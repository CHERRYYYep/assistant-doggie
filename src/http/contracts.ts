import { TaskError } from "../domain/task.ts";
/** Stable JSON contracts at the local HTTP boundary. */

import { z } from "zod";

import {
  ApplicationError,
  type ArchiveResult,
} from "../application/archive.ts";
import { CorrectionError } from "../application/correction.ts";
import {
  MemoryQueryError,
  type MemoryQueryPlan,
} from "../application/memory-query.ts";
import type { MemorySearchResponse } from "../application/query.ts";
import { DomainError } from "../domain/errors.ts";
import {
  BUCKET_STATUSES,
  BUCKET_TYPES,
  type BucketView,
} from "../domain/types.ts";
import { LlmError } from "../llm/structured-output.ts";
import { StorageError } from "../storage/database.ts";
import type {
  BucketDetail,
  BucketRow,
  ChatMessageRow,
  EntryRow,
  JsonValue,
  MemoryRow,
} from "../storage/store.ts";

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
export type MoveEntryRequest = z.infer<typeof moveEntryRequestSchema>;
export type BucketStatusRequest = z.infer<typeof bucketStatusRequestSchema>;
export type MemoryQueryRequest = z.infer<typeof memoryQueryRequestSchema>;

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
      case "archive_attempt_not_found":
      case "archive_attempt_text_mismatch":
      case "archive_attempt_not_pending":
        return new HttpBoundaryError(409, error.message);
      case "invalid_write":
        return new HttpBoundaryError(400, error.message);
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

export function projectBucket(bucket: BucketRow) {
  return {
    id: bucket.id,
    title: bucket.title,
    type: bucket.kind,
    status: bucket.lifecycle,
    summary: bucket.summary,
    tags: [...bucket.tags],
    created_at: bucket.createdAt,
    updated_at: bucket.updatedAt,
    last_active_at: bucket.lastActiveAt,
    archived_at: bucket.archivedAt,
  } as const;
}

export function projectEntry(entry: EntryRow) {
  return {
    id: entry.id,
    bucket_id: entry.bucketId,
    raw_text: entry.rawText,
    summary: entry.summary,
    content_type: entry.contentType,
    classification_confidence: entry.classificationConfidence,
    classification_reason: entry.classificationReason,
    created_at: entry.createdAt,
    moved_from_bucket_id: entry.movedFromBucketId,
    archive_state: entry.archiveState,
    archived_at: entry.archivedAt,
  } as const;
}

export function projectMemory(memory: MemoryRow) {
  return {
    id: memory.id,
    bucket_id: memory.bucketId,
    entry_id: memory.entryId,
    kind: memory.kind,
    text: memory.text,
    status: memory.status,
    due_at: memory.dueAt,
    occurred_at: memory.occurredAt,
    source: memory.source,
    reason: memory.reason,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    metadata: memory.metadata,
  } as const;
}

export function projectBucketDetail(detail: BucketDetail) {
  return {
    bucket: projectBucket(detail.bucket),
    entries: detail.entries.map(projectEntry),
    memories: detail.memories.map(projectMemory),
  } as const;
}

export function projectQueryPlan(plan: MemoryQueryPlan) {
  return {
    raw_text: plan.rawText,
    terms: [...plan.terms],
    entity_terms: [...plan.entityTerms],
    topic_terms: [...plan.topicTerms],
    bucket_terms: [...plan.bucketTerms],
    time_range:
      plan.timeRange === undefined
        ? null
        : {
            start: plan.timeRange.start.toISOString(),
            end: plan.timeRange.end.toISOString(),
            label: plan.timeRange.label,
          },
    statuses: [...plan.statuses],
    structured_filters: plan.structuredFilters.map((filter) => ({
      field: filter.field,
      value: filter.value,
    })),
    limit: plan.limit,
  } as const;
}

export function projectMemoryQuery(response: MemorySearchResponse) {
  return {
    ok: true,
    query: response.query.rawText,
    query_plan: projectQueryPlan(response.query),
    total_entries: response.results.length,
    total_buckets: response.buckets.length,
    results: response.results.map((hit) => ({
      bucket: projectBucket(hit.bucket),
      entry: projectEntry(hit.entry),
      memories: hit.memories.map(projectMemory),
      matched_fields: [...hit.matchedFields],
      keyword_score: hit.keywordScore,
      semantic_score: hit.lexicalSimilarity,
      score: hit.score,
    })),
    buckets: response.buckets.map((group) => ({
      bucket: projectBucket(group.bucket),
      matched_entry_count: group.matchedEntryCount,
      top_score: group.topScore,
    })),
    evidence: response.evidence.map(projectMemory),
    answer: response.answer,
  } as const;
}

export type ArchiveProjectionOptions = {
  readonly candidates?: readonly BucketView[];
  readonly bucket?: BucketRow | undefined;
  readonly memoryItemIds?: readonly string[];
};

export function projectArchive(
  result: ArchiveResult,
  options: ArchiveProjectionOptions = {},
) {
  const recommendedBucketId =
    result.action === "append_existing"
      ? (result.bucketId ?? result.candidateBucketIds[0] ?? null)
      : (result.candidateBucketIds[0] ?? null);
  const candidateBuckets = result.candidateBucketIds.flatMap((candidateId) => {
    const candidate = options.candidates?.find(({ id }) => id === candidateId);
    return candidate === undefined
      ? []
      : [
          {
            id: candidate.id,
            title: candidate.title,
            type: candidate.bucketType,
            status: candidate.status,
            summary: candidate.summary,
            tags: [...candidate.tags],
            last_active_at_unix_ms: candidate.lastActiveAtUnixMs,
            is_recommended: candidate.id === recommendedBucketId,
          },
        ];
  });
  const recommendedBucket =
    candidateBuckets.find(({ is_recommended }) => is_recommended) ?? null;

  return {
    ok: true,
    attempt_id: result.attemptId,
    archive_state: result.archiveState,
    bucket_id: result.bucketId ?? null,
    entry_id: result.entryId ?? null,
    memory_item_ids: [...(options.memoryItemIds ?? [])],
    action: result.action,
    confidence: result.confidence,
    reason: result.reason,
    question: result.question ?? null,
    candidate_bucket_ids: [...result.candidateBucketIds],
    recommended_bucket_id: recommendedBucketId,
    recommended_bucket: recommendedBucket,
    candidate_buckets: candidateBuckets,
    bucket_title: result.bucketTitle ?? null,
    bucket_type: result.bucketType ?? null,
    bucket: options.bucket === undefined ? null : projectBucket(options.bucket),
    extraction:
      result.extraction === undefined
        ? null
        : {
            summary: result.extraction.summary,
            todos: [...result.extraction.todos],
            evidences: [...result.extraction.evidences],
            timeline_events: result.extraction.timelineEvents.map((event) => ({
              event_time: event.occurredAt ?? null,
              text: event.text,
            })),
            decisions: [...result.extraction.decisions],
            hypotheses: [...result.extraction.hypotheses],
            entities: [...result.extraction.entities],
            tags: [...result.extraction.tags],
          },
    source_attempt_id: result.sourceAttemptId ?? null,
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
