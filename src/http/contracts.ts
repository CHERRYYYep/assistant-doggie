import {
  ConversationError,
  type ConversationTurn,
} from "../domain/main-conversation.ts";
import { ChatCapacityError } from "../application/chat-turns.ts";
import { WorkItemError } from "../domain/work-item.ts";
import { AgentError, HarnessError } from "../domain/agent.ts";
import { TaskError } from "../domain/task.ts";
/** Stable JSON contracts at the local HTTP boundary. */

import { z } from "zod";

import { ApplicationError } from "../application/archive.ts";
import { projectBucket } from "../application/archive-view.ts";
export { projectArchive, projectBucket } from "../application/archive-view.ts";
import { CorrectionError } from "../application/correction.ts";
import { MemoryQueryError } from "../application/memory-query.ts";
import { projectEntry, projectMemory } from "../application/memory-view.ts";
export {
  projectEntry,
  projectMemory,
  projectBucketDetail,
  projectQueryPlan,
  projectMemoryQuery,
} from "../application/memory-view.ts";
import { DomainError } from "../domain/errors.ts";
import { BUCKET_STATUSES, BUCKET_TYPES } from "../domain/types.ts";
import { TODO_STATUSES } from "../domain/todo.ts";
import { LlmError } from "../llm/structured-output.ts";
import { StorageError } from "../storage/database.ts";
import type { ChatMessageRow, JsonValue, TodoRow } from "../storage/store.ts";

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

const optionalTrimmedString = z.string().trim().min(1).optional();
const requiredTrimmedString = z.string().trim().min(1);
const requiredOriginalString = z
  .string()
  .refine((value) => value.trim() !== "", "must not be empty");
const listLimit = z.coerce.number().int().min(1).max(MAX_LIST_LIMIT);

export const archiveRequestSchema = z
  .object({
    text: requiredTrimmedString,
    focus_bucket_id: optionalTrimmedString,
  })
  .strict();

export const chatRequestSchema = z
  .object({
    message: requiredTrimmedString,
    focus_bucket_id: optionalTrimmedString,
  })
  .strict();

const confirmationBase = {
  confirmation_granted: z.literal(true),
  attempt_id: requiredTrimmedString,
  text: requiredOriginalString,
  focus_bucket_id: optionalTrimmedString,
} as const;

export const chatConfirmationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...confirmationBase,
      action: z.literal("append"),
      bucket_id: requiredTrimmedString,
    })
    .strict(),
  z
    .object({
      ...confirmationBase,
      action: z.literal("create"),
      title: requiredTrimmedString,
      bucket_type: z.enum(BUCKET_TYPES),
    })
    .strict(),
  z
    .object({
      ...confirmationBase,
      action: z.literal("discard"),
    })
    .strict(),
]);

export const moveEntryRequestSchema = z
  .object({
    entry_id: requiredTrimmedString,
    target_bucket_id: requiredTrimmedString,
    command_text: requiredTrimmedString.default(
      "Move Entry through Doggie API.",
    ),
  })
  .strict();

export const bucketStatusRequestSchema = z
  .object({
    bucket_id: requiredTrimmedString,
    status: z.enum(BUCKET_STATUSES),
  })
  .strict();

const todoCommandBase = {
  command_text: requiredTrimmedString,
  expected_updated_at: z.string().datetime(),
} as const;
const repeatRuleInputSchema = z
  .strictObject({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z.number().int().min(1).max(31),
    weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    count: z.number().int().min(1).max(366).optional(),
  })
  .refine((rule) => !(rule.until !== undefined && rule.count !== undefined), {
    message: "until and count cannot both be set",
  });
const todoRawTimeInputSchema = z.strictObject({
  scheduled_text: z.string().trim().min(1).nullable(),
  due_text: z.string().trim().min(1).nullable(),
  time_zone: z.string().trim().min(1),
});
export const todoAgendaQuerySchema = z
  .strictObject({
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    bucket_id: optionalTrimmedString,
    include_history: z.enum(["true", "false"]).default("false"),
  })
  .refine((query) => query.from === undefined || query.to !== undefined, {
    message: "from and to must be provided together",
  })
  .refine((query) => query.to === undefined || query.from !== undefined, {
    message: "from and to must be provided together",
  });
export const todoTransitionRequestSchema = z.strictObject({
  ...todoCommandBase,
  status: z.enum(TODO_STATUSES),
});
export const todoPlanRequestSchema = z.strictObject({
  ...todoCommandBase,
  scheduled_at: z.string().datetime({ offset: true }).nullable(),
  due_at: z.string().datetime({ offset: true }).nullable(),
  repeat_rule: repeatRuleInputSchema.nullable(),
  raw_time: todoRawTimeInputSchema.nullable(),
});
export const todoAdvanceRequestSchema = z.strictObject(todoCommandBase);
export const todoReopenRequestSchema = z.strictObject(todoCommandBase);

export const memoryQueryRequestSchema = z
  .object({
    query: requiredTrimmedString,
    limit: listLimit.default(DEFAULT_LIST_LIMIT),
    start_at: z.string().trim().min(1).optional(),
    end_at: z.string().trim().min(1).optional(),
    statuses: z.array(z.enum(BUCKET_STATUSES)).default([]),
    filters: z
      .array(
        z
          .object({
            field: requiredTrimmedString,
            value: requiredTrimmedString,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const queryLimitSchema = listLimit.default(DEFAULT_LIST_LIMIT);

export type ArchiveRequest = z.infer<typeof archiveRequestSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatConfirmationRequest = z.infer<
  typeof chatConfirmationRequestSchema
>;
export type ConversationTurnRequest = ConversationTurn;
export type MoveEntryRequest = z.infer<typeof moveEntryRequestSchema>;
export type BucketStatusRequest = z.infer<typeof bucketStatusRequestSchema>;
export type MemoryQueryRequest = z.infer<typeof memoryQueryRequestSchema>;
export type TodoAgendaQuery = z.infer<typeof todoAgendaQuerySchema>;
export type TodoTransitionRequest = z.infer<typeof todoTransitionRequestSchema>;
export type TodoPlanRequest = z.infer<typeof todoPlanRequestSchema>;
export type TodoAdvanceRequest = z.infer<typeof todoAdvanceRequestSchema>;
export type TodoReopenRequest = z.infer<typeof todoReopenRequestSchema>;

export class HttpBoundaryError extends Error {
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: number,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "HttpBoundaryError";
    this.status = status;
    this.details = details;
  }
}

export type ErrorBody = {
  readonly ok: false;
  readonly error: string;
  readonly [key: string]: unknown;
};

export function stableError(error: unknown): {
  readonly status: number;
  readonly body: ErrorBody;
} {
  const normalized = normalizeHttpError(error);
  return {
    status: normalized.status,
    body: {
      ok: false,
      error: normalized.message,
      ...(normalized.details ?? {}),
    },
  };
}

export function normalizeHttpError(error: unknown): HttpBoundaryError {
  if (error instanceof HttpBoundaryError) return error;
  if (error instanceof ConversationError)
    return new HttpBoundaryError(
      error.code === "missing" ? 404 : 409,
      error.message,
    );
  if (error instanceof WorkItemError)
    return new HttpBoundaryError(
      error.code === "missing"
        ? 404
        : error.code === "invalid_reference"
          ? 400
          : 409,
      error.message,
    );
  if (error instanceof AgentError)
    return new HttpBoundaryError(
      error.code === "missing"
        ? 404
        : error.code === "disabled" || error.code === "unavailable"
          ? 503
          : error.code === "conflict" ||
              error.code === "memory_changed" ||
              error.code === "workspace_changed" ||
              error.code === "binding_mismatch"
            ? 409
            : 400,
      error.message,
    );
  if (error instanceof HarnessError)
    return new HttpBoundaryError(500, error.message);
  if (error instanceof ChatCapacityError)
    return new HttpBoundaryError(429, error.message);
  if (error instanceof TaskError)
    return new HttpBoundaryError(
      error.kind === "missing" ? 404 : error.kind === "capacity" ? 429 : 503,
      error.message,
    );
  if (error instanceof z.ZodError) {
    return new HttpBoundaryError(400, "request body is invalid");
  }
  if (
    error instanceof DomainError ||
    error instanceof ApplicationError ||
    error instanceof CorrectionError ||
    error instanceof MemoryQueryError
  ) {
    return new HttpBoundaryError(400, error.message);
  }
  if (error instanceof StorageError) {
    switch (error.kind) {
      case "missing_record":
        return new HttpBoundaryError(404, error.message);
      case "inactive_bucket":
      case "memory_context_changed":
      case "archive_attempt_not_found":
      case "archive_attempt_text_mismatch":
      case "archive_attempt_not_pending":
      case "stale_write":
        return new HttpBoundaryError(409, error.message);
      case "invalid_write":
        return new HttpBoundaryError(400, error.message);
      case "storage_unavailable":
        return new HttpBoundaryError(503, "storage is unavailable");
      case "foreign_database":
      case "unsupported_schema_version":
      case "pragma_not_applied":
        return new HttpBoundaryError(500, "storage operation failed");
    }
  }
  if (error instanceof LlmError) {
    return new HttpBoundaryError(500, error.message);
  }
  return new HttpBoundaryError(500, "internal server error");
}

export type BucketJson = ReturnType<typeof projectBucket>;
export type EntryJson = ReturnType<typeof projectEntry>;
export type MemoryJson = ReturnType<typeof projectMemory>;

export function projectTodo(todo: TodoRow) {
  return {
    id: todo.id,
    bucket_id: todo.bucketId,
    entry_id: todo.entryId,
    kind: "todo" as const,
    text: todo.text,
    status: todo.status,
    scheduled_at: todo.scheduledAt,
    due_at: todo.dueAt,
    todo_rule:
      todo.todoRule === null
        ? null
        : {
            frequency: todo.todoRule.frequency,
            interval: todo.todoRule.interval,
            weekdays: todo.todoRule.weekdays ?? null,
            until: todo.todoRule.until ?? null,
            count: todo.todoRule.count ?? null,
          },
    todo_raw_time:
      todo.todoRawTime === null
        ? null
        : {
            scheduled_text: todo.todoRawTime.scheduledText,
            due_text: todo.todoRawTime.dueText,
            time_zone: todo.todoRawTime.timeZone,
          },
    todo_occurrence: todo.todoOccurrence,
    occurred_at: todo.occurredAt,
    source: todo.source,
    reason: todo.reason,
    created_at: todo.createdAt,
    updated_at: todo.updatedAt,
  } as const;
}

export function projectChatMessage(message: ChatMessageRow) {
  return {
    id: message.id,
    sequence: message.sequence,
    role: message.role,
    content: message.content,
    tool_name: message.toolName,
    tool_call_id: message.toolCallId,
    details: jsonDetails(message.details) ?? null,
    created_at: message.createdAt,
  } as const;
}

export function jsonDetails(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
