import { workItemSchema, workItemSourceSchema } from "../domain/work-item.ts";
/** Runtime JSON contracts. These schemas are also the OpenAPI source of truth. */
import { z } from "zod";

import { agentTaskSchema, workspaceSchema } from "../domain/agent.ts";
import { taskSnapshotSchema } from "../domain/task.ts";
import {
  BUCKET_STATUSES,
  BUCKET_TYPES,
  CLASSIFICATION_ACTIONS,
} from "../domain/types.ts";
import { TODO_STATUSES } from "../domain/todo.ts";

const text = z.string();
const id = z.string().min(1);
const nullableText = text.nullable();
const timestamp = z.string().datetime();
const nullableTimestamp = timestamp.nullable();
const confidence = z.number().min(0).max(1);
const ids = z.array(id);
const strings = z.array(text);
const count = z.number().int().nonnegative();
const todoStatus = z.enum(TODO_STATUSES);
const repeatRuleResponseSchema = z.strictObject({
  frequency: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().min(1).max(31),
  weekdays: z.array(z.number().int().min(1).max(7)).nullable(),
  until: z.string().datetime().nullable(),
  count: z.number().int().min(1).max(366).nullable(),
});
const todoRawTimeResponseSchema = z.strictObject({
  scheduled_text: text.nullable(),
  due_text: text.nullable(),
  time_zone: text,
});

export const bucketResponseSchema = z.strictObject({
  id,
  title: text,
  type: z.enum(BUCKET_TYPES),
  status: z.enum(BUCKET_STATUSES),
  summary: text,
  tags: strings,
  created_at: timestamp,
  updated_at: timestamp,
  last_active_at: timestamp,
  archived_at: nullableTimestamp,
});
export const entryResponseSchema = z.strictObject({
  id,
  bucket_id: id,
  raw_text: text,
  summary: nullableText,
  content_type: text,
  classification_confidence: confidence.nullable(),
  classification_reason: nullableText,
  created_at: timestamp,
  moved_from_bucket_id: nullableText,
  archive_state: text,
  archived_at: timestamp,
});
export const memoryResponseSchema = z.strictObject({
  id,
  bucket_id: id,
  entry_id: nullableText,
  kind: text,
  text,
  status: nullableText,
  // These are source/extraction values (including date-only or natural text),
  // unlike the service-generated ISO timestamps below.
  due_at: nullableText,
  occurred_at: nullableText,
  source: nullableText,
  reason: nullableText,
  created_at: timestamp,
  updated_at: timestamp,
  metadata: z.json(),
});
export const bucketDetailSchema = z.strictObject({
  bucket: bucketResponseSchema,
  entries: z.array(entryResponseSchema),
  memories: z.array(memoryResponseSchema),
});
export const candidateBucketSchema = z.strictObject({
  id,
  title: text,
  type: z.enum(BUCKET_TYPES),
  status: z.enum(BUCKET_STATUSES),
  summary: text,
  tags: strings,
  last_active_at_unix_ms: z.number().int(),
  is_recommended: z.boolean(),
});
export const archiveExtractionSchema = z.strictObject({
  summary: text,
  todos: strings,
  evidences: strings,
  timeline_events: z.array(z.strictObject({ event_time: nullableText, text })),
  decisions: strings,
  hypotheses: strings,
  entities: strings,
  tags: strings,
});
export const archiveProjectionSchema = z.strictObject({
  ok: z.literal(true),
  attempt_id: id,
  archive_state: z.enum([
    "archived",
    "needs_confirmation",
    "revoked",
    "deleted",
  ]),
  revoked_at: z.string().datetime().optional(),
  bucket_id: nullableText,
  entry_id: nullableText,
  memory_item_ids: ids,
  action: z.enum(CLASSIFICATION_ACTIONS),
  confidence,
  reason: text,
  question: nullableText,
  candidate_bucket_ids: ids,
  recommended_bucket_id: nullableText,
  recommended_bucket: candidateBucketSchema.nullable(),
  candidate_buckets: z.array(candidateBucketSchema),
  bucket_title: nullableText,
  bucket_type: z.enum(BUCKET_TYPES).nullable(),
  bucket: bucketResponseSchema.nullable(),
  extraction: archiveExtractionSchema.nullable(),
  source_attempt_id: nullableText,
  result_attempt_id: nullableText.optional(),
  available_actions: z
    .array(
      z.enum([
        "append_recommended",
        "append_alternative",
        "create_new",
        "discard",
        "move_entry",
        "revoke_entry",
      ]),
    )
    .optional(),
  confirmation_options: z
    .strictObject({
      recommended: z.literal("append_recommended"),
      alternative: z.literal("append_alternative"),
      create: z.literal("create_new"),
      discard: z.literal("discard"),
    })
    .optional(),
  pending_confirmation: z.boolean().optional(),
});
export const discardedArchiveSchema = z.strictObject({
  ok: z.literal(true),
  attempt_id: id,
  archive_state: z.literal("discarded"),
  bucket_id: z.null(),
  entry_id: z.null(),
  memory_item_ids: ids,
  source_attempt_id: id,
  result_attempt_id: z.null(),
  bucket: bucketResponseSchema.nullable().optional(),
  reason: text.optional(),
});
export const archiveResponseSchema = z.union([
  archiveProjectionSchema,
  discardedArchiveSchema,
]);
export const chatMessageSchema = z.strictObject({
  id,
  sequence: z.number().int().positive(),
  role: text,
  content: text,
  tool_name: nullableText,
  tool_call_id: nullableText,
  details: z.json(),
  created_at: timestamp,
});
export const queryPlanSchema = z.strictObject({
  raw_text: text,
  terms: strings,
  entity_terms: strings,
  topic_terms: strings,
  bucket_terms: strings,
  time_range: z
    .strictObject({ start: timestamp, end: timestamp, label: text })
    .nullable(),
  statuses: z.array(z.enum(BUCKET_STATUSES)),
  structured_filters: z.array(z.strictObject({ field: text, value: text })),
  limit: z.number().int().min(1).max(100),
});
export const memoryQueryResponseSchema = z.strictObject({
  ok: z.literal(true),
  query: text,
  query_plan: queryPlanSchema,
  total_entries: count,
  total_buckets: count,
  results: z.array(
    z.strictObject({
      bucket: bucketResponseSchema,
      entry: entryResponseSchema,
      memories: z.array(memoryResponseSchema),
      matched_fields: strings,
      keyword_score: z.number(),
      semantic_score: z.number(),
      score: z.number(),
    }),
  ),
  buckets: z.array(
    z.strictObject({
      bucket: bucketResponseSchema,
      matched_entry_count: count,
      top_score: z.number(),
    }),
  ),
  evidence: z.array(memoryResponseSchema),
  answer: text,
});
export const healthResponseSchema = z.strictObject({
  ok: z.literal(true),
  service: z.literal("doggie-local-web"),
});
export const activeBucketsResponseSchema = z.strictObject({
  ok: z.literal(true),
  buckets: z.array(bucketResponseSchema),
});
export const bucketSearchResponseSchema = z.strictObject({
  ok: z.literal(true),
  results: z.array(
    z.strictObject({
      bucket: bucketResponseSchema,
      matched_entry_count: count,
      score: z.number(),
    }),
  ),
});
export const bucketDetailResponseSchema = z.strictObject({
  ok: z.literal(true),
  detail: bucketDetailSchema,
});
export const chatHistoryResponseSchema = z.strictObject({
  ok: z.literal(true),
  messages: z.array(chatMessageSchema),
});
export const chatResponseSchema = z.strictObject({
  ok: z.literal(true),
  archive: archiveProjectionSchema,
  archive_state: z.enum([
    "archived",
    "needs_confirmation",
    "revoked",
    "deleted",
  ]),
  user_message: chatMessageSchema,
  tool_messages: z.array(
    z.strictObject({
      name: text,
      call_id: text,
      arguments: z.json(),
      output: z.json(),
    }),
  ),
  assistant_message: chatMessageSchema,
  messages: z.array(chatMessageSchema),
  chat_error: nullableText,
});
export const chatConfirmationResponseSchema = z.strictObject({
  ok: z.literal(true),
  confirmation_action: z.enum(["append", "create", "discard"]),
  archive: archiveResponseSchema,
  archive_state: z.enum([
    "archived",
    "needs_confirmation",
    "discarded",
    "revoked",
    "deleted",
  ]),
  source_attempt_id: id,
  result_attempt_id: nullableText,
  user_message: chatMessageSchema,
  assistant_message: chatMessageSchema,
  messages: z.array(chatMessageSchema),
});
export const moveEntryResponseSchema = z.strictObject({
  ok: z.literal(true),
  correction_id: id,
  source_bucket_id: id,
  target_bucket_id: id,
  entry: entryResponseSchema,
});
export const deleteBucketResponseSchema = z.strictObject({
  ok: z.literal(true),
  bucket_id: id,
  deleted_entry_ids: ids,
  deleted_memory_item_ids: ids,
  updated_archive_attempt_ids: ids,
  correction_id: id,
});
export const revokeEntryResponseSchema = z.strictObject({
  ok: z.literal(true),
  entry_id: id,
  bucket_id: id,
  correction_id: id,
  revoked_at: z.string().datetime(),
  memory_item_ids: ids,
});
export const bucketStatusResponseSchema = z.strictObject({
  ok: z.literal(true),
  bucket_id: id,
  status: z.enum(BUCKET_STATUSES),
});
export const todoSchema = z.strictObject({
  id,
  bucket_id: id,
  entry_id: nullableText,
  kind: z.literal("todo"),
  text,
  status: todoStatus,
  scheduled_at: nullableTimestamp,
  due_at: nullableTimestamp,
  todo_rule: repeatRuleResponseSchema.nullable(),
  todo_raw_time: todoRawTimeResponseSchema.nullable(),
  todo_occurrence: z.number().int().min(1).nullable(),
  occurred_at: nullableText,
  source: nullableText,
  reason: nullableText,
  created_at: timestamp,
  updated_at: timestamp,
});
export const agendaResponseSchema = z.strictObject({
  ok: z.literal(true),
  now: timestamp,
  todos: z.array(todoSchema),
});
export const todoResponseSchema = z.strictObject({
  ok: z.literal(true),
  todo: todoSchema,
});
export const todoMutationResponseSchema = z.strictObject({
  ok: z.literal(true),
  todo: todoSchema,
  correction_id: id,
});
export const errorResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: text,
  user_message: chatMessageSchema.optional(),
  assistant_message: chatMessageSchema.optional(),
});
export const taskResponseSchema = z.strictObject({
  ok: z.literal(true),
  task: taskSnapshotSchema,
});
export const tasksResponseSchema = z.strictObject({
  ok: z.literal(true),
  tasks: z.array(taskSnapshotSchema).max(40),
});
export const agentCapabilitiesResponseSchema = z.strictObject({
  ok: z.literal(true),
  backends: z.array(z.enum(["codex", "claude"])).max(2),
  permission: z.literal("read_only"),
});
export const agentWorkspaceResponseSchema = z.strictObject({
  ok: z.literal(true),
  workspace: workspaceSchema,
});
export const agentWorkspacesResponseSchema = z.strictObject({
  ok: z.literal(true),
  workspaces: z.array(workspaceSchema).max(100),
});
export const agentTaskResponseSchema = z.strictObject({
  ok: z.literal(true),
  task: agentTaskSchema,
});
export const agentTasksResponseSchema = z.strictObject({
  ok: z.literal(true),
  tasks: z.array(agentTaskSchema).max(100),
});
export const agentApprovalResponseSchema = z.strictObject({
  ok: z.literal(true),
  task: agentTaskSchema,
  queueTask: taskSnapshotSchema,
});

/** SSE data has the exact same shape as GET task.task; the event ID is revision. */
export const taskEventDataSchema = taskSnapshotSchema;

export const workItemResponseSchema = z.strictObject({
  ok: z.literal(true),
  workItem: workItemSchema,
});
export const workItemsResponseSchema = z.strictObject({
  ok: z.literal(true),
  workItems: z.array(workItemSchema).max(100),
});
export const workItemDetailResponseSchema = z.strictObject({
  ok: z.literal(true),
  workItem: workItemSchema,
  sources: z.array(workItemSourceSchema).max(200),
  attempts: z.array(agentTaskSchema).max(20),
});
export const workItemResolutionResponseSchema = z.strictObject({
  ok: z.literal(true),
  kind: z.enum(["resolved", "clarify", "unassigned"]),
  workItemId: z.string().uuid().nullable(),
  candidates: z
    .array(z.strictObject({ id: z.string().uuid(), title: z.string() }))
    .max(100),
});
