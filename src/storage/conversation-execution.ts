import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AgentError,
  agentTaskSchema,
  type AgentTask,
} from "../domain/agent.ts";
import { WorkItemError } from "../domain/work-item.ts";
import { ConversationStore } from "./conversation.ts";
import type { WorkItemStore } from "./work-items.ts";

export type ConversationExecutionReference = {
  readonly id: string;
  readonly revision: number;
};

export type ConversationExecutionProjection = {
  readonly taskId: string;
  readonly status: z.infer<typeof agentTaskSchema.shape.status> | "stale";
  readonly output: string | null;
  readonly failureCode: string | null;
};
type GoalScope = Pick<
  WorkItemStore,
  "assertExecutable" | "hasAvailableScopeSources"
>;

const joinedReference = `SELECT c.status, c.revision, c.selected_id AS selectedId,
 c.selected_scope_revision AS selectedScopeRevision, a.work_item_id AS workItemId,
 a.scope_revision AS scopeRevision, x.card_revision AS cardRevision
 FROM conversation_executions x JOIN conversation_clarifications c ON c.id=x.clarification_id
 LEFT JOIN work_item_attempts a ON a.agent_task_id=x.task_id WHERE x.task_id=?`;
const referenceSchema = z.strictObject({
  status: z.string(),
  revision: z.number().int().positive(),
  selectedId: z.uuid().nullable(),
  selectedScopeRevision: z.number().int().positive().nullable(),
  workItemId: z.uuid().nullable(),
  scopeRevision: z.number().int().positive().nullable(),
  cardRevision: z.number().int().positive(),
});
const attemptSchema = z.strictObject({
  taskId: agentTaskSchema.shape.id,
  sessionId: agentTaskSchema.shape.sessionId,
  status: agentTaskSchema.shape.status,
  output: agentTaskSchema.shape.output,
  failureCode: agentTaskSchema.shape.failureCode,
});

export class ConversationExecutionStore {
  readonly #db: DatabaseSync;
  readonly #goals: GoalScope;

  constructor(db: DatabaseSync, goals: GoalScope) {
    this.#db = db;
    this.#goals = goals;
  }

  bind(taskId: string, card: ConversationExecutionReference): void {
    if (!this.#db.isTransaction) throw new AgentError("conflict");
    const bound = this.#db
      .prepare(
        `INSERT INTO conversation_executions(task_id,clarification_id,card_revision)
         SELECT ?,id,revision FROM conversation_clarifications WHERE id=? AND revision=? AND status='resolved'`,
      )
      .run(taskId, card.id, card.revision);
    if (bound.changes !== 1) throw new WorkItemError("conflict");
    this.assertCurrent(taskId);
  }

  /** Additional guards only for attempts attached to a main conversation card. */
  assertCurrent(taskId: string): boolean {
    const row = this.#db.prepare(joinedReference).get(taskId);
    if (row === undefined) return false;
    const ref = referenceSchema.parse(row);
    if (
      ref.status !== "resolved" ||
      ref.revision !== ref.cardRevision ||
      ref.workItemId === null ||
      ref.selectedId !== ref.workItemId ||
      ref.scopeRevision === null ||
      ref.selectedScopeRevision !== ref.scopeRevision ||
      !this.#goals.hasAvailableScopeSources(ref.workItemId)
    )
      throw new WorkItemError("conflict");
    this.#goals.assertExecutable(taskId);
    return true;
  }

  /** Unlinked attempts must not inherit context tied to a conversation card. */
  excludeLinkedSession(sessionId: string): void {
    if (
      this.#db
        .prepare(
          "SELECT 1 FROM agent_tasks t JOIN conversation_executions x ON x.task_id=t.id WHERE t.session_id=? LIMIT 1",
        )
        .get(sessionId) !== undefined
    )
      throw new AgentError("binding_mismatch");
  }

  expiredPendingTaskIds(cardId: string): readonly string[] {
    return this.#db
      .prepare(
        `SELECT t.id FROM conversation_executions x
         JOIN conversation_clarifications c ON c.id=x.clarification_id
         JOIN agent_tasks t ON t.id=x.task_id
         WHERE c.id=? AND (c.revision<>x.card_revision OR c.status<>'resolved') AND t.status='pending'`,
      )
      .all(cardId)
      .map((row) => agentTaskSchema.shape.id.parse(row["id"]));
  }

  latest(cardId: string): ConversationExecutionProjection | null {
    const row = this.#db
      .prepare(
        `SELECT t.id AS taskId,t.session_id AS sessionId,t.status,t.output,t.failure_code AS failureCode
         FROM conversation_executions x JOIN agent_tasks t ON t.id=x.task_id
         JOIN work_item_attempts a ON a.agent_task_id=t.id
         WHERE x.clarification_id=? ORDER BY a.sequence DESC LIMIT 1`,
      )
      .get(cardId);
    if (row === undefined) return null;
    const attempt = attemptSchema.parse(row);
    if (this.#stale(attempt.taskId, attempt.sessionId)) {
      return {
        taskId: attempt.taskId,
        status: "stale",
        output: null,
        failureCode: null,
      };
    }
    return {
      taskId: attempt.taskId,
      status: attempt.status,
      output: attempt.status === "succeeded" ? attempt.output : null,
      failureCode: attempt.failureCode,
    };
  }

  /** Older views keep the audit status and binding without showing stale derived text. */
  maskStaleOutput(task: AgentTask): AgentTask {
    return task.status === "succeeded" && this.#stale(task.id, task.sessionId)
      ? { ...task, output: "" }
      : task;
  }

  #stale(taskId: string, sessionId: string): boolean {
    try {
      if (!this.assertCurrent(taskId)) return false;
    } catch (error) {
      if (error instanceof WorkItemError) return true;
      throw error;
    }
    const stored = this.#db
      .prepare("SELECT memory_revision FROM agent_sessions WHERE id=?")
      .get(sessionId);
    return (
      stored?.["memory_revision"] !==
      new ConversationStore(this.#db).getMemoryContextRevision()
    );
  }
}
