/** Durable background chat work is data, never an authorization to run tools. */
import { z } from "zod";

export const MAX_TASK_PAYLOAD_BYTES = 128 * 1024;
export const taskPayloadSchema = z
  .object({
    message: z.string().trim().min(1),
    focus_bucket_id: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).length <=
      MAX_TASK_PAYLOAD_BYTES,
    "task payload is too large",
  );
export type TaskPayload = z.infer<typeof taskPayloadSchema>;
export const taskSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    errorCode: z.enum(["execution_failed", "interrupted"]).nullable(),
  })
  .strict();
export type TaskSnapshot = Readonly<z.infer<typeof taskSnapshotSchema>>;
export function isTerminalTask(task: TaskSnapshot): boolean {
  return task.status !== "queued" && task.status !== "running";
}
export class TaskError extends Error {
  readonly kind:
    "capacity" | "missing" | "closed" | "executor_busy" | "faulted";
  constructor(kind: TaskError["kind"]) {
    super(
      {
        capacity: "task capacity exceeded",
        missing: "task not found",
        closed: "task executor is closed",
        executor_busy: "another task executor is active",
        faulted: "task executor is unavailable",
      }[kind],
    );
    this.name = "TaskError";
    this.kind = kind;
  }
}
