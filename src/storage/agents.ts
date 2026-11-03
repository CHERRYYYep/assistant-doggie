/** Agent identity, bound approval, queue admission and audit share transactions. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AgentError,
  agentProposalSchema,
  agentTaskSchema,
  sessionSchema,
  workspaceSchema,
  type AgentTask,
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

const taskSelect = `SELECT id, session_id AS sessionId, workspace_id AS workspaceId, backend, instruction, pending_action_id AS pendingActionId, queue_id AS queueId, status, output, failure_code AS failureCode, created_at AS createdAt, updated_at AS updatedAt FROM agent_tasks`;
const sessionSelect = `SELECT id, workspace_id AS workspaceId, backend, remote_id AS remoteId, created_at AS createdAt FROM agent_sessions`;
const workspaceSelect = `SELECT id,path,base_commit AS baseCommit,git_status AS gitStatus,created_at AS createdAt FROM agent_workspaces`;
export class AgentStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
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
  propose(input: unknown): AgentTask {
    const proposal = agentProposalSchema.parse(input);
    return withTransaction(this.#db, () => {
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
        if (
          session.backend !== proposal.backend ||
          session.workspaceId !== proposal.workspaceId
        )
          throw new AgentError("binding_mismatch");
        this.#assertSessionReusable(session.id);
      } else {
        const sid = randomUUID();
        this.#db
          .prepare("INSERT INTO agent_sessions VALUES (?,?,?,?,?)")
          .run(
            sid,
            proposal.workspaceId,
            proposal.backend,
            null,
            new Date().toISOString(),
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
    });
  }
  approve(id: string, instruction: string): TaskSnapshot {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, instruction, "pending");
      if (task.status !== "pending") throw new AgentError("conflict");
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
      return queued;
    });
  }
  reject(id: string, instruction: string): AgentTask {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, instruction, "pending");
      if (task.status !== "pending") throw new AgentError("conflict");
      rejectPendingAction(
        this.#db,
        task.pendingActionId,
        instruction,
        new Date().toISOString(),
      );
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status='rejected',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      return this.task(id);
    });
  }
  start(id: string): AgentTask {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, task.instruction, "approved");
      if (task.status !== "queued" || task.queueId === null)
        throw new AgentError("conflict");
      this.#assertSessionReusable(task.sessionId);
      const queue = new TaskStore(this.#db).get(task.queueId);
      if (queue.status !== "running") throw new AgentError("conflict");
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status='running',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), id);
      return this.task(id);
    });
  }
  complete(
    id: string,
    outcome: {
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly output: string;
      readonly failureCode: string | null;
      readonly remoteId?: string;
    },
  ): AgentTask {
    return withTransaction(this.#db, () => {
      const task = this.task(id);
      this.#bound(task, task.instruction, "approved");
      if (task.status !== "running" && task.status !== "queued")
        throw new AgentError("conflict");
      if (Buffer.byteLength(outcome.output) > 64 * 1024)
        throw new AgentError("output_limit");
      if (outcome.remoteId !== undefined) {
        z.string().uuid().parse(outcome.remoteId);
        const session = this.session(task.sessionId);
        if (session.remoteId !== null && session.remoteId !== outcome.remoteId)
          throw new AgentError("binding_mismatch");
        this.#db
          .prepare("UPDATE agent_sessions SET remote_id=? WHERE id=?")
          .run(outcome.remoteId, task.sessionId);
      }
      finishPendingAction(
        this.#db,
        task.pendingActionId,
        task.instruction,
        outcome.status === "succeeded"
          ? { status: "executed", result: { referenceId: task.id } }
          : {
              status: "failed",
              failureCode: outcome.failureCode ?? "cancelled",
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
      return this.task(id);
    });
  }
  reconcile(): void {
    // Run only after the T12 owner has been acquired. Interrupted CLI work is
    // never resumed automatically; no process is started during recovery.
    new TaskStore(this.#db).reconcileAgentTasks();
  }
  #assertSessionReusable(sessionId: string): void {
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
