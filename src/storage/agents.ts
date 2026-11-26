/** Agent identity, bound approval, queue admission and audit share transactions. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AgentError,
  agentCompletionSchema,
  agentProposalSchema,
  agentTaskSchema,
  sessionSchema,
  workspaceSchema,
  type AgentTask,
  type AgentCompletion,
  type AgentProposal,
  type AgentSession,
  type AgentWorkspace,
} from "../domain/agent.ts";
import type { TaskSnapshot } from "../domain/task.ts";
import type { WorkspaceSnapshot } from "../agent/workspace.ts";
import { withTransaction } from "./database.ts";
import {
  insertPendingAction,
  requirePendingAction,
  approvePendingAction,
  rejectPendingAction,
  finishPendingAction,
} from "./pending-actions.ts";
import { TaskStore } from "./tasks.ts";
import { Store } from "./store.ts";
import { WorkItemStore, type WorkItemBinding } from "./work-items.ts";
import {
  workItemAttemptSchema,
  workItemInstruction,
  type WorkItemAttempt,
} from "../domain/work-item.ts";
import {
  ConversationExecutionStore,
  type ConversationExecutionProjection,
  type ConversationExecutionReference,
} from "./conversation-execution.ts";

const taskSelect = `SELECT id, session_id AS sessionId, workspace_id AS workspaceId, backend, instruction, pending_action_id AS pendingActionId, queue_id AS queueId, status, output, failure_code AS failureCode, created_at AS createdAt, updated_at AS updatedAt FROM agent_tasks`;
const sessionSelect = `SELECT id, workspace_id AS workspaceId, backend, remote_id AS remoteId, memory_revision AS memoryRevision, created_at AS createdAt FROM agent_sessions`;
const workspaceSelect = `SELECT id,path,base_commit AS baseCommit,git_status AS gitStatus,created_at AS createdAt FROM agent_workspaces`;
export class AgentStore {
  readonly #db: DatabaseSync;
  readonly #conversation: ConversationExecutionStore;
  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#conversation = new ConversationExecutionStore(
      db,
      new WorkItemStore(db),
    );
  }
  registerWorkspace(
    snapshot: WorkspaceSnapshot,
    bucketId?: string,
  ): AgentWorkspace {
    return withTransaction(this.#db, () => {
      const existing = this.#db
        .prepare(
          workspaceSelect + " WHERE path=? AND base_commit=? AND git_status=?",
        )
        .get(snapshot.path, snapshot.baseCommit, snapshot.gitStatus);
      let workspace: AgentWorkspace;
      if (existing === undefined) {
        const id = randomUUID();
        const now = new Date().toISOString();
        this.#db
          .prepare("INSERT INTO agent_workspaces VALUES (?,?,?,?,?)")
          .run(id, snapshot.path, snapshot.baseCommit, snapshot.gitStatus, now);
        workspace = this.workspace(id);
      } else {
        workspace = workspaceSchema.parse(existing);
        if (
          workspace.baseCommit !== snapshot.baseCommit ||
          workspace.gitStatus !== snapshot.gitStatus
        )
          throw new AgentError("workspace_changed");
      }
      if (
        bucketId !== undefined &&
        this.#db
          .prepare("UPDATE buckets SET workspace_id=? WHERE id=?")
          .run(workspace.id, bucketId).changes !== 1
      )
        throw new AgentError("missing");
      return workspace;
    });
  }
  workspace(id: string): AgentWorkspace {
    const row = this.#db.prepare(workspaceSelect + " WHERE id=?").get(id);
    if (row === undefined) throw new AgentError("missing");
    return workspaceSchema.parse(row);
  }
  workspaces(): readonly AgentWorkspace[] {
    return this.#db
      .prepare(workspaceSelect + " ORDER BY created_at DESC,id DESC LIMIT 100")
      .all()
      .map((row) => workspaceSchema.parse(row));
  }
  session(id: string): AgentSession {
    const row = this.#db.prepare(sessionSelect + " WHERE id=?").get(id);
    if (row === undefined) throw new AgentError("missing");
    return sessionSchema.parse(row);
  }
  assertMemoryContextCurrent(sessionId: string): void {
    if (
      this.session(sessionId).memoryRevision !==
      new Store(this.#db).getMemoryContextRevision()
    )
      throw new AgentError("memory_changed");
  }
  assertExecutionContextCurrent(task: AgentTask): void {
    this.assertMemoryContextCurrent(task.sessionId);
    this.#conversation.assertCurrent(task.id);
  }
  conversationExecution(
    cardId: string,
  ): ConversationExecutionProjection | null {
    return this.#conversation.latest(cardId);
  }
  publicProjection(task: AgentTask): AgentTask {
    return this.#conversation.maskStaleOutput(task);
  }
  task(id: string): AgentTask {
    const row = this.#db.prepare(taskSelect + " WHERE id=?").get(id);
    if (row === undefined) throw new AgentError("missing");
    return agentTaskSchema.parse(row);
  }
  tasks(): readonly AgentTask[] {
    return this.#db
      .prepare(
        taskSelect +
          " ORDER BY CASE WHEN status IN ('pending','queued','running') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 100",
      )
      .all()
      .map((row) => agentTaskSchema.parse(row));
  }
  proposeForWorkItem(id: string, input: unknown): AgentTask {
    const request = workItemAttemptSchema.parse(input);
    return withTransaction(this.#db, () =>
      this.#proposeForWorkItemWithinTransaction(id, request),
    );
  }
  proposeForConversationWithinTransaction(
    id: string,
    input: WorkItemAttempt,
    card: ConversationExecutionReference,
  ): AgentTask {
    const request = workItemAttemptSchema.parse(input);
    if (request.workspaceId === null || request.sessionId !== undefined)
      throw new AgentError("binding_mismatch");
    return this.#proposeForWorkItemWithinTransaction(id, request, card);
  }
  #proposeForWorkItemWithinTransaction(
    id: string,
    request: WorkItemAttempt,
    card?: ConversationExecutionReference,
  ): AgentTask {
    if (!this.#db.isTransaction) throw new AgentError("conflict");
    const goals = new WorkItemStore(this.#db);
    const kind = card === undefined ? "attempt" : "conversation_attempt";
    const payload = JSON.stringify({ workItemId: id, ...request, card });
    const replay = goals.replay(request.requestId, kind, payload);
    if (replay !== undefined) return this.task(replay);
    const item = goals.expectedForProposal(id, request.expectedRevision);
    const task = this.#proposeWithinTransaction(
      agentProposalSchema.parse({
        backend: request.backend,
        workspaceId: request.workspaceId,
        instruction: workItemInstruction(item, request.instruction),
        ...(request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId }),
      }),
      { workItemId: id, scopeRevision: item.scopeRevision },
    );
    goals.bindAttempt(item, task);
    if (card !== undefined) this.#conversation.bind(task.id, card);
    goals.remember(request.requestId, kind, payload, task.id);
    return task;
  }
  propose(input: unknown): AgentTask {
    const proposal = agentProposalSchema.parse(input);
    return withTransaction(this.#db, () =>
      this.#proposeWithinTransaction(proposal),
    );
  }
  #proposeWithinTransaction(
    proposal: AgentProposal,
    binding?: WorkItemBinding,
  ): AgentTask {
    if (!this.#db.isTransaction) throw new AgentError("conflict");

    const count = z
      .object({ n: z.number() })
      .parse(
        this.#db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_tasks WHERE status IN ('pending','queued','running')",
          )
          .get(),
      ).n;
    if (count >= 32) throw new AgentError("conflict");
    if (proposal.workspaceId !== null) this.workspace(proposal.workspaceId);
    let session: AgentSession;
    if (proposal.sessionId !== undefined) {
      session = this.session(proposal.sessionId);
      this.#conversation.excludeLinkedSession(session.id);
      const owner = new WorkItemStore(this.#db).sessionBinding(session.id);
      if (
        (binding === undefined) !== (owner === undefined) ||
        (binding !== undefined &&
          (owner?.workItemId !== binding.workItemId ||
            owner.scopeRevision !== binding.scopeRevision))
      )
        throw new AgentError("binding_mismatch");
      if (
        session.backend !== proposal.backend ||
        session.workspaceId !== proposal.workspaceId
      )
        throw new AgentError("binding_mismatch");
      this.#assertSessionReusable(session.id);
    } else {
      const sid = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO agent_sessions (id,workspace_id,backend,remote_id,created_at,memory_revision) VALUES (?,?,?,?,?,?)",
        )
        .run(
          sid,
          proposal.workspaceId,
          proposal.backend,
          null,
          new Date().toISOString(),
          new Store(this.#db).getMemoryContextRevision(),
        );
      session = this.session(sid);
    }
    const id = randomUUID();
    const actionId = randomUUID();
    const now = new Date().toISOString();
    insertPendingAction(
      this.#db,
      actionId,
      {
        kind: "agent_task",
        payload: {
          instruction: proposal.instruction,
          workspaceId: proposal.workspaceId,
        },
      },
      "user",
      proposal.instruction,
      now,
    );
    this.#db
      .prepare(
        "INSERT INTO agent_tasks (id,session_id,workspace_id,backend,instruction,pending_action_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
      )
      .run(
        id,
        session.id,
        proposal.workspaceId,
        proposal.backend,
        proposal.instruction,
        actionId,
        now,
        now,
      );
    return this.task(id);
  }
  approve(id: string, instruction: string): TaskSnapshot {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, instruction, "pending");
      if (task.status !== "pending") throw new AgentError("conflict");
      new WorkItemStore(this.#db).assertExecutable(id);
      this.#conversation.assertCurrent(id);
      // A proposal can predate another task's failure. Recheck at admission,
      // inside the same transaction that records approval and queues the work.
      this.#assertSessionReusable(task.sessionId);
      if (
        this.#db
          .prepare(
            "SELECT t.id FROM agent_tasks t LEFT JOIN agent_workspaces w ON w.id=t.workspace_id WHERE t.status IN ('queued','running') AND (t.session_id=? OR w.path=(SELECT path FROM agent_workspaces WHERE id=?)) LIMIT 1",
          )
          .get(task.sessionId, task.workspaceId) !== undefined
      )
        throw new AgentError("conflict");
      const queued = new TaskStore(this.#db).enqueueWithinTransaction({
        agent_task_id: id,
      });
      approvePendingAction(
        this.#db,
        task.pendingActionId,
        instruction,
        { action: "approve" },
        new Date().toISOString(),
      );
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status='queued',queue_id=?,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(queued.id, new Date().toISOString(), id);
      new WorkItemStore(this.#db).projectAttempt(id);
      return queued;
    });
  }
  reject(id: string, instruction: string): AgentTask {
    return withTransaction(this.#db, () =>
      this.#rejectWithinTransaction(this.task(id), instruction),
    );
  }
  rejectPendingForConversationWithinTransaction(cardId: string): void {
    if (!this.#db.isTransaction) throw new AgentError("conflict");
    for (const id of this.#conversation.expiredPendingTaskIds(cardId)) {
      const task = this.task(id);
      this.#rejectWithinTransaction(task, task.instruction);
    }
  }
  #rejectWithinTransaction(task: AgentTask, instruction: string): AgentTask {
    this.#bound(task, instruction, "pending");
    if (task.status !== "pending") throw new AgentError("conflict");
    const now = new Date().toISOString();
    rejectPendingAction(this.#db, task.pendingActionId, instruction, now);
    this.#db
      .prepare(
        "UPDATE agent_tasks SET status='rejected',updated_at=? WHERE id=?",
      )
      .run(now, task.id);
    new WorkItemStore(this.#db).projectAttempt(task.id);
    return this.task(task.id);
  }
  start(id: string): AgentTask {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, task.instruction, "approved");
      if (task.status !== "queued" || task.queueId === null)
        throw new AgentError("conflict");
      this.#assertSessionReusable(task.sessionId);
      new WorkItemStore(this.#db).assertExecutable(id);
      this.#conversation.assertCurrent(id);
      const queue = new TaskStore(this.#db).get(task.queueId);
      if (queue.status !== "running") throw new AgentError("conflict");
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status='running',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      new WorkItemStore(this.#db).projectAttempt(id);
      return this.task(id);
    });
  }
  complete(id: string, completion: AgentCompletion): AgentTask {
    const parsed = agentCompletionSchema.safeParse(completion);
    if (!parsed.success) throw new AgentError("invalid_event");
    const outcome = parsed.data;
    if (Buffer.byteLength(outcome.output) > 64 * 1024)
      throw new AgentError("output_limit");
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      if (task.status !== "running" && task.status !== "queued")
        throw new AgentError("conflict");
      this.#bound(task, task.instruction, "approved");
      if (outcome.status === "succeeded") {
        if (
          task.status !== "running" ||
          task.queueId === null ||
          new TaskStore(this.#db).get(task.queueId).status !== "running"
        )
          throw new AgentError("conflict");
        this.assertExecutionContextCurrent(task);
        new WorkItemStore(this.#db).assertExecutable(id);
        if (outcome.remoteId !== undefined) {
          const session = this.session(task.sessionId);
          if (
            session.remoteId !== null &&
            session.remoteId !== outcome.remoteId
          )
            throw new AgentError("binding_mismatch");
          this.#db
            .prepare("UPDATE agent_sessions SET remote_id=? WHERE id=?")
            .run(outcome.remoteId, task.sessionId);
        }
      }
      finishPendingAction(
        this.#db,
        task.pendingActionId,
        task.instruction,
        outcome.status === "succeeded"
          ? { status: "executed", result: { referenceId: task.id } }
          : {
              status: "failed",
              failureCode: outcome.failureCode,
            },
        new Date().toISOString(),
      );
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status=?,output=?,failure_code=?,updated_at=? WHERE id=?",
        )
        .run(
          outcome.status,
          outcome.output,
          outcome.failureCode,
          new Date().toISOString(),
          id,
        );
      new WorkItemStore(this.#db).projectAttempt(id);
      return this.task(id);
    });
  }
  reconcile(): void {
    // Explicit maintenance entry point. Production startup also repairs these
    // projections while acquiring queue ownership in the same transaction.
    new TaskStore(this.#db).recoverProjections();
  }
  #assertSessionReusable(sessionId: string): void {
    this.assertMemoryContextCurrent(sessionId);
    // Queue cancellation/restart can precede agent projection reconciliation.
    // Treat that outstanding work as failed without relying on a GET request
    // to reconcile it first. Successfully committed agent results stay valid.
    if (
      this.#db
        .prepare(
          "SELECT t.id FROM agent_tasks t LEFT JOIN background_tasks q ON q.id=t.queue_id WHERE t.session_id=? AND (t.status IN ('failed','cancelled') OR (t.status IN ('queued','running') AND (q.status IN ('failed','cancelled','succeeded') OR q.id IS NULL))) LIMIT 1",
        )
        .get(sessionId) !== undefined
    )
      throw new AgentError("conflict");
  }
  #bound(
    task: AgentTask,
    instruction: string,
    status: "pending" | "approved",
  ): void {
    const action = requirePendingAction(
      this.#db,
      task.pendingActionId,
      instruction,
      status,
    );
    if (
      action.kind !== "agent_task" ||
      action.payload.instruction !== task.instruction ||
      action.payload.workspaceId !== task.workspaceId ||
      task.instruction !== instruction
    )
      throw new AgentError("binding_mismatch");
  }
}
