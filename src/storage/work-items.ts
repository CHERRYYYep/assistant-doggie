/** Local goal authority. No model, HTTP or external memory service access. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { agentTaskSchema, type AgentTask } from "../domain/agent.ts";
import {
  createWorkItemSchema,
  updateWorkItemSchema,
  workItemActionSchema,
  workItemSchema,
  sourceReferenceSchema,
  WorkItemError,
  type WorkItem,
  type SourceReference,
} from "../domain/work-item.ts";
import { withTransaction } from "./database.ts";
import { rejectPendingAction } from "./pending-actions.ts";
import { Store } from "./store.ts";

const select = `SELECT id,title,goal,acceptance,status,revision,scope_revision AS scopeRevision,
 cancel_requested AS cancelRequested,last_attempt_id AS lastAttemptId,last_attempt_status AS lastAttemptStatus,
 created_at AS createdAt,updated_at AS updatedAt FROM work_items`;
const MAX_LISTED_WORK_ITEMS = 100;
const workItemReferenceSchema = workItemSchema.pick({
  id: true,
  title: true,
  status: true,
});
const bindingSchema = z.strictObject({
  workItemId: z.string().uuid(),
  scopeRevision: z.number().int().positive(),
});
const taskSelect = `SELECT t.id,session_id AS sessionId,workspace_id AS workspaceId,backend,instruction,
 pending_action_id AS pendingActionId,queue_id AS queueId,status,output,failure_code AS failureCode,
 created_at AS createdAt,updated_at AS updatedAt FROM agent_tasks t`;
export type WorkItemBinding = Readonly<z.infer<typeof bindingSchema>>;

export class WorkItemStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(id: string): WorkItem {
    const row = this.#db.prepare(select + " WHERE id=?").get(id);
    if (row === undefined) throw new WorkItemError("missing");
    return workItemSchema.parse({
      ...row,
      cancelRequested: row["cancelRequested"] === 1,
    });
  }
  list(): readonly WorkItem[] {
    return this.#db
      .prepare(
        select +
          " ORDER BY CASE WHEN status IN ('done','cancelled') THEN 1 ELSE 0 END,updated_at DESC,id DESC LIMIT ?",
      )
      .all(MAX_LISTED_WORK_ITEMS)
      .map((row) =>
        workItemSchema.parse({
          ...row,
          cancelRequested: row["cancelRequested"] === 1,
        }),
      );
  }
  findExactTitle(
    title: string,
  ): readonly Pick<WorkItem, "id" | "title" | "status">[] {
    return this.#db
      .prepare(
        "SELECT id,title,status FROM work_items WHERE title = ? ORDER BY CASE WHEN status IN ('done','cancelled') THEN 1 ELSE 0 END,updated_at DESC,id DESC LIMIT ?",
      )
      .all(title, MAX_LISTED_WORK_ITEMS)
      .map((row) => workItemReferenceSchema.parse(row));
  }
  detail(id: string) {
    const workItem = this.get(id);
    const sources = this.#db
      .prepare(
        "SELECT kind,source_id AS id FROM work_item_sources WHERE work_item_id=? ORDER BY kind,source_id LIMIT 200",
      )
      .all(id)
      .map((row) => sourceReferenceSchema.parse(row))
      .map((ref) => ({ ...ref, available: this.#sourceAvailable(ref) }));
    const attempts = this.#db
      .prepare(
        taskSelect +
          " JOIN work_item_attempts a ON a.agent_task_id=t.id WHERE a.work_item_id=? ORDER BY a.sequence DESC LIMIT 20",
      )
      .all(id)
      .map((row) => agentTaskSchema.parse(row));
    return { workItem, sources, attempts };
  }

  replay(requestId: string, kind: string, payload: string): string | undefined {
    const raw = this.#db
      .prepare(
        "SELECT kind,payload_json AS payload,result_id AS result FROM work_item_requests WHERE request_id=?",
      )
      .get(requestId);
    if (raw === undefined) return undefined;
    const row = z
      .strictObject({
        kind: z.string(),
        payload: z.string(),
        result: z.string().uuid(),
      })
      .parse(raw);
    if (row.kind !== kind || row.payload !== payload)
      throw new WorkItemError("conflict");
    return row.result;
  }
  remember(
    requestId: string,
    kind: string,
    payload: string,
    resultId: string,
  ): void {
    if (!this.#db.isTransaction) throw new WorkItemError("conflict");
    this.#db
      .prepare("INSERT INTO work_item_requests VALUES (?,?,?,?)")
      .run(requestId, kind, payload, resultId);
  }

  create(input: unknown): WorkItem {
    const request = createWorkItemSchema.parse(input);
    return withTransaction(this.#db, () => {
      const payload = JSON.stringify(request);
      const previous = this.replay(request.requestId, "create", payload);
      if (previous !== undefined) return this.get(previous);
      for (const ref of request.sources)
        if (!this.#sourceAvailable(ref))
          throw new WorkItemError("invalid_reference");
      const now = new Date().toISOString();
      const id = randomUUID();
      this.#db
        .prepare(
          "INSERT INTO work_items (id,title,goal,acceptance,status,revision,scope_revision,created_at,updated_at) VALUES (?,?,?,?,'open',1,1,?,?)",
        )
        .run(id, request.title, request.goal, request.acceptance, now, now);
      for (const ref of request.sources)
        this.#db
          .prepare("INSERT OR IGNORE INTO work_item_sources VALUES (?,?,?)")
          .run(id, ref.kind, ref.id);
      this.remember(request.requestId, "create", payload, id);
      this.#event(this.get(id), "created", { requestId: request.requestId });
      this.#message(
        id,
        `建立工作目标「${request.title}」\n${request.goal}\n验收要求：${request.acceptance}`,
      );
      return this.get(id);
    });
  }
  update(id: string, input: unknown): WorkItem {
    const request = updateWorkItemSchema.parse(input);
    return withTransaction(this.#db, () => {
      const item = this.#expected(id, request.expectedRevision);
      this.#assertOpen(item);
      if (this.inFlight(id).length > 0) throw new WorkItemError("conflict");
      this.#rejectPending(id);
      this.#db
        .prepare(
          "UPDATE work_items SET title=?,goal=?,acceptance=?,scope_revision=scope_revision+1,revision=revision+1,updated_at=? WHERE id=?",
        )
        .run(
          request.title,
          request.goal,
          request.acceptance,
          new Date().toISOString(),
          id,
        );
      const updated = this.get(id);
      this.#event(updated, "scope_updated", {
        previousScopeRevision: item.scopeRevision,
      });
      this.#message(
        id,
        `修改工作目标「${updated.title}」\n${updated.goal}\n验收要求：${updated.acceptance}`,
      );
      return updated;
    });
  }
  transition(id: string, input: unknown): WorkItem {
    const request = workItemActionSchema.parse(input);
    return withTransaction(this.#db, () => {
      const item = this.#expected(id, request.expectedRevision);
      if (request.action === "reopen") {
        if (item.status !== "done" && item.status !== "cancelled")
          throw new WorkItemError("conflict");
        return this.#change(item, "open", false, true, "reopened");
      }
      this.#assertOpen(item);
      const active = this.inFlight(id);
      if (request.action === "complete" && active.length > 0)
        throw new WorkItemError("conflict");
      this.#rejectPending(id);
      return request.action === "complete"
        ? this.#change(item, "done", false, true, "completed")
        : active.length === 0
          ? this.#change(item, "cancelled", false, true, "cancelled")
          : this.#change(item, item.status, true, false, "cancel_requested");
    });
  }
  inFlight(id: string): readonly string[] {
    return this.#db
      .prepare(
        "SELECT t.id FROM agent_tasks t JOIN work_item_attempts a ON a.agent_task_id=t.id WHERE a.work_item_id=? AND t.status IN ('queued','running')",
      )
      .all(id)
      .map((row) => z.strictObject({ id: z.string().uuid() }).parse(row).id);
  }
  expectedForProposal(id: string, revision: number): WorkItem {
    const item = this.#expected(id, revision);
    this.#assertOpen(item);
    if (
      this.#db
        .prepare(
          "SELECT t.id FROM agent_tasks t JOIN work_item_attempts a ON a.agent_task_id=t.id WHERE a.work_item_id=? AND t.status IN ('pending','queued','running') LIMIT 1",
        )
        .get(id) !== undefined
    )
      throw new WorkItemError("conflict");
    return item;
  }
  sessionBinding(sessionId: string): WorkItemBinding | undefined {
    const row = this.#db
      .prepare(
        "SELECT work_item_id AS workItemId,scope_revision AS scopeRevision FROM work_item_sessions WHERE session_id=?",
      )
      .get(sessionId);
    return row === undefined ? undefined : bindingSchema.parse(row);
  }
  bindAttempt(item: WorkItem, task: AgentTask): void {
    if (!this.#db.isTransaction) throw new WorkItemError("conflict");
    const binding = this.sessionBinding(task.sessionId);
    if (
      binding !== undefined &&
      (binding.workItemId !== item.id ||
        binding.scopeRevision !== item.scopeRevision)
    )
      throw new WorkItemError("conflict");
    this.#db
      .prepare("INSERT OR IGNORE INTO work_item_sessions VALUES (?,?,?)")
      .run(task.sessionId, item.id, item.scopeRevision);
    this.#db
      .prepare(
        "INSERT INTO work_item_attempts VALUES (?,?,?,(SELECT COALESCE(MAX(sequence),0)+1 FROM work_item_attempts))",
      )
      .run(task.id, item.id, item.scopeRevision);
    this.projectAttempt(task.id);
    this.#message(item.id, task.instruction);
  }
  assertExecutable(taskId: string): void {
    const row = this.#db
      .prepare(
        "SELECT work_item_id AS workItemId,scope_revision AS scopeRevision FROM work_item_attempts WHERE agent_task_id=?",
      )
      .get(taskId);
    if (row === undefined) return;
    const binding = bindingSchema.parse(row);
    const item = this.get(binding.workItemId);
    this.#assertOpen(item);
    if (item.scopeRevision !== binding.scopeRevision)
      throw new WorkItemError("conflict");
  }

  projectAttempt(taskId: string): void {
    const row = this.#db
      .prepare(
        "SELECT a.work_item_id AS workItemId,a.scope_revision AS scopeRevision,t.status FROM work_item_attempts a JOIN agent_tasks t ON t.id=a.agent_task_id WHERE a.agent_task_id=?",
      )
      .get(taskId);
    if (row === undefined) return;
    const attempt = bindingSchema
      .extend({ status: agentTaskSchema.shape.status })
      .parse(row);
    const item = this.get(attempt.workItemId);
    if (
      item.scopeRevision !== attempt.scopeRevision ||
      (item.lastAttemptId === taskId &&
        item.lastAttemptStatus === attempt.status)
    )
      return;
    const status = item.cancelRequested
      ? this.inFlight(item.id).length === 0
        ? "cancelled"
        : item.status
      : attempt.status === "failed" || attempt.status === "cancelled"
        ? "blocked"
        : attempt.status === "queued" ||
            attempt.status === "running" ||
            attempt.status === "succeeded"
          ? "in_progress"
          : item.status;
    const finishedCancel = item.cancelRequested && status === "cancelled";
    this.#db
      .prepare(
        "UPDATE work_items SET status=?,cancel_requested=?,scope_revision=scope_revision+?,revision=revision+1,last_attempt_id=?,last_attempt_status=?,updated_at=? WHERE id=?",
      )
      .run(
        status,
        finishedCancel ? 0 : Number(item.cancelRequested),
        Number(finishedCancel),
        taskId,
        attempt.status,
        new Date().toISOString(),
        item.id,
      );
    this.#event(this.get(item.id), "attempt_status", {
      taskId,
      status: attempt.status,
    });
  }
  reconcile(): void {
    withTransaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          "SELECT last_attempt_id AS id FROM work_items WHERE last_attempt_id IS NOT NULL AND status NOT IN ('done','cancelled')",
        )
        .all();
      for (const row of rows)
        this.projectAttempt(
          z.strictObject({ id: z.string().uuid() }).parse(row).id,
        );
    });
  }
  #expected(id: string, revision: number): WorkItem {
    const item = this.get(id);
    if (item.revision !== revision) throw new WorkItemError("stale");
    return item;
  }
  #assertOpen(item: WorkItem): void {
    if (
      item.cancelRequested ||
      item.status === "done" ||
      item.status === "cancelled"
    )
      throw new WorkItemError("conflict");
  }
  #change(
    item: WorkItem,
    status: WorkItem["status"],
    cancel: boolean,
    scope: boolean,
    event: string,
  ): WorkItem {
    this.#db
      .prepare(
        "UPDATE work_items SET status=?,cancel_requested=?,scope_revision=scope_revision+?,revision=revision+1,updated_at=? WHERE id=?",
      )
      .run(
        status,
        Number(cancel),
        Number(scope),
        new Date().toISOString(),
        item.id,
      );
    const changed = this.get(item.id);
    this.#event(changed, event, { previousStatus: item.status });
    return changed;
  }
  #event(
    item: WorkItem,
    kind: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    this.#db
      .prepare("INSERT INTO work_item_events VALUES (?,?,?,?,?,?)")
      .run(
        randomUUID(),
        item.id,
        item.revision,
        kind,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  }
  #message(id: string, content: string): void {
    const message = new Store(this.#db).appendChatMessageWithinTransaction({
      role: "user",
      content,
      details: { kind: "work_item", work_item_id: id },
    });
    this.#db
      .prepare("INSERT INTO work_item_sources VALUES (?,'message',?)")
      .run(id, message.id);
  }
  #rejectPending(id: string): void {
    const rows = this.#db
      .prepare(
        "SELECT t.id,t.pending_action_id AS actionId,t.instruction FROM agent_tasks t JOIN work_item_attempts a ON a.agent_task_id=t.id WHERE a.work_item_id=? AND t.status='pending'",
      )
      .all(id);
    for (const row of rows) {
      const task = z
        .strictObject({
          id: z.string().uuid(),
          actionId: z.string().uuid(),
          instruction: z.string(),
        })
        .parse(row);
      rejectPendingAction(
        this.#db,
        task.actionId,
        task.instruction,
        new Date().toISOString(),
      );
      this.#db
        .prepare(
          "UPDATE agent_tasks SET status='rejected',updated_at=? WHERE id=?",
        )
        .run(new Date().toISOString(), task.id);
    }
  }
  #sourceAvailable(ref: SourceReference): boolean {
    if (ref.kind === "entry")
      return (
        this.#db
          .prepare("SELECT id FROM entries WHERE id=? AND revoked_at IS NULL")
          .get(ref.id) !== undefined
      );
    if (ref.kind === "bucket")
      return (
        this.#db.prepare("SELECT id FROM buckets WHERE id=?").get(ref.id) !==
        undefined
      );
    return (
      this.#db
        .prepare(
          "SELECT id FROM conversation_messages WHERE id=? AND role='user'",
        )
        .get(ref.id) !== undefined
    );
  }
}
