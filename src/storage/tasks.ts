/** Synchronous queue transactions: claim/terminal transitions are compare-and-set. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  TaskError,
  taskPayloadSchema,
  taskSnapshotSchema,
  type TaskPayload,
  type TaskSnapshot,
} from "../domain/task.ts";
import { withTransaction } from "./database.ts";

const rowSchema = z.object({
  id: z.string(),
  payload_json: z.string(),
  status: z.string(),
  revision: z.number(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const MAX_ACTIVE_TASKS = 32;
export const MAX_RETAINED_TASKS = 200;

export class TaskStore {
  readonly #db: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#db = database;
  }

  acquireExecutor(ownerId: string): void {
    withTransaction(this.#db, () => {
      const raw = this.#db
        .prepare(
          "SELECT owner_id, process_id FROM background_task_executor WHERE singleton=1",
        )
        .get();
      if (raw !== undefined) {
        const owner = z
          .object({
            owner_id: z.string(),
            process_id: z.number().int().positive(),
          })
          .parse(raw);
        // Unknown ownership (EPERM, PID reuse) fails closed. No age-based lease
        // stealing: a paused live worker could otherwise commit after recovery.
        if (isProcessAlive(owner.process_id))
          throw new TaskError("executor_busy");
        this.#db
          .prepare("DELETE FROM background_task_executor WHERE singleton=1")
          .run();
      }
      this.#db
        .prepare("INSERT INTO background_task_executor VALUES (1, ?, ?)")
        .run(ownerId, process.pid);
      this.#db
        .prepare(
          "UPDATE background_tasks SET status='failed', error_code='interrupted', revision=revision+1, updated_at=? WHERE status='running'",
        )
        .run(new Date().toISOString());
    });
  }
  releaseExecutor(ownerId: string): void {
    this.#db
      .prepare(
        "DELETE FROM background_task_executor WHERE singleton=1 AND owner_id=?",
      )
      .run(ownerId);
  }
  enqueue(input: unknown): TaskSnapshot {
    const payload = taskPayloadSchema.parse(input);
    return withTransaction(this.#db, () => {
      const count = z
        .object({ count: z.number() })
        .parse(
          this.#db
            .prepare(
              "SELECT COUNT(*) AS count FROM background_tasks WHERE status IN ('queued','running')",
            )
            .get(),
        ).count;
      if (count >= MAX_ACTIVE_TASKS) throw new TaskError("capacity");
      this.#db
        .prepare(
          "DELETE FROM background_tasks WHERE id IN (SELECT id FROM background_tasks WHERE status NOT IN ('queued','running') ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
        )
        .run(MAX_RETAINED_TASKS - count - 1);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.#db
        .prepare(
          "INSERT INTO background_tasks (id,sequence,payload_json,status,revision,created_at,updated_at) VALUES (?,(SELECT COALESCE(MAX(sequence),0)+1 FROM background_tasks),?,'queued',1,?,?)",
        )
        .run(id, JSON.stringify(payload), now, now);
      return this.get(id);
    });
  }
  get(id: string): TaskSnapshot {
    return snapshot(this.#read(id));
  }
  list(): readonly TaskSnapshot[] {
    // Include all outstanding work plus recent terminal records (at most 40).
    return this.#db
      .prepare(
        "SELECT * FROM background_tasks ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END, sequence DESC LIMIT 40",
      )
      .all()
      .map((row) => snapshot(rowSchema.parse(row)));
  }
  hasQueued(): boolean {
    return (
      this.#db
        .prepare(
          "SELECT id FROM background_tasks WHERE status='queued' LIMIT 1",
        )
        .get() !== undefined
    );
  }
  claim():
    { readonly task: TaskSnapshot; readonly payload: TaskPayload } | undefined {
    return withTransaction(this.#db, () => {
      const raw = this.#db
        .prepare(
          "SELECT * FROM background_tasks WHERE status='queued' ORDER BY sequence LIMIT 1",
        )
        .get();
      if (raw === undefined) return undefined;
      const row = rowSchema.parse(raw);
      const payload = taskPayloadSchema.parse(JSON.parse(row.payload_json));
      this.#transition(row.id, "queued", "running", null);
      return { task: this.get(row.id), payload };
    });
  }
  cancelQueued(id: string): TaskSnapshot {
    this.#transition(id, "queued", "cancelled", null);
    return this.get(id);
  }
  finish(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    errorCode: TaskSnapshot["errorCode"] = null,
  ): TaskSnapshot {
    this.#transition(id, "running", status, errorCode);
    return this.get(id);
  }
  #transition(
    id: string,
    expected: TaskSnapshot["status"],
    status: TaskSnapshot["status"],
    error: TaskSnapshot["errorCode"],
  ): void {
    this.#db
      .prepare(
        "UPDATE background_tasks SET status=?,error_code=?,revision=revision+1,updated_at=? WHERE id=? AND status=?",
      )
      .run(status, error, new Date().toISOString(), id, expected);
  }
  #read(id: string): z.infer<typeof rowSchema> {
    const row = this.#db
      .prepare("SELECT * FROM background_tasks WHERE id=?")
      .get(id);
    if (row === undefined) throw new TaskError("missing");
    return rowSchema.parse(row);
  }
}
function snapshot(row: z.infer<typeof rowSchema>): TaskSnapshot {
  return taskSnapshotSchema.parse({
    id: row.id,
    status: row.status,
    revision: row.revision,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
