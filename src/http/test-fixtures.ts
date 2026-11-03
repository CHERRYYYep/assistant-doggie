/** Valid protocol fixtures for transport tests that do not exercise business storage. */
import type { DoggieHttpApi } from "./app.ts";
import * as schema from "./response-schemas.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const bucket = schema.bucketResponseSchema.parse({
  id: "b1",
  title: "fixture",
  type: "task",
  status: "active",
  summary: "",
  tags: [],
  created_at: timestamp,
  updated_at: timestamp,
  last_active_at: timestamp,
  archived_at: null,
});
const entry = schema.entryResponseSchema.parse({
  id: "e1",
  bucket_id: "b1",
  raw_text: "fixture",
  summary: null,
  content_type: "text",
  classification_confidence: null,
  classification_reason: null,
  created_at: timestamp,
  moved_from_bucket_id: null,
  archive_state: "archived",
  archived_at: timestamp,
});
const archive = schema.archiveProjectionSchema.parse({
  ok: true,
  attempt_id: "a1",
  archive_state: "needs_confirmation",
  bucket_id: null,
  entry_id: null,
  memory_item_ids: [],
  action: "ask_user",
  confidence: 0.5,
  reason: "fixture",
  question: "save?",
  candidate_bucket_ids: [],
  recommended_bucket_id: null,
  recommended_bucket: null,
  candidate_buckets: [],
  bucket_title: null,
  bucket_type: null,
  bucket: null,
  extraction: null,
  source_attempt_id: null,
});
const user = (content: string) =>
  schema.chatMessageSchema.parse({
    id: "user-1",
    sequence: 1,
    role: "user",
    content,
    tool_name: null,
    tool_call_id: null,
    details: null,
    created_at: timestamp,
  });
const assistant = schema.chatMessageSchema.parse({
  ...user("fixture response"),
  id: "assistant-1",
  sequence: 2,
  role: "assistant",
});

export function chatResponseFixture(message = "fixture") {
  const input = user(message);
  return schema.chatResponseSchema.parse({
    ok: true,
    archive,
    archive_state: archive.archive_state,
    user_message: input,
    tool_messages: [],
    assistant_message: assistant,
    messages: [input, assistant],
    chat_error: null,
  });
}

export function httpApiFixture(calls: string[] = []): DoggieHttpApi {
  const called = <T>(name: string, value: unknown, result: T): T => {
    calls.push(`${name}:${JSON.stringify(value)}`);
    return result;
  };
  const queryResponse = (query: string, limit: number) =>
    schema.memoryQueryResponseSchema.parse({
      ok: true,
      query,
      query_plan: {
        raw_text: query,
        terms: [],
        entity_terms: [],
        topic_terms: [],
        bucket_terms: [],
        time_range: null,
        statuses: [],
        structured_filters: [],
        limit,
      },
      total_entries: 0,
      total_buckets: 0,
      results: [],
      buckets: [],
      evidence: [],
      answer: "",
    });
  return {
    activeBuckets: (limit) =>
      called("active", limit, { ok: true, buckets: [] }),
    searchBuckets: (query, limit) =>
      called("search", { query, limit }, { ok: true, results: [] }),
    chatHistory: (limit) =>
      called("history", limit, { ok: true, messages: [] }),
    memoryQuery: (query, limit) =>
      called("query", { query, limit }, queryResponse(query, limit)),
    memoryQueryJson: (request) =>
      called("queryJson", request, queryResponse(request.query, request.limit)),
    bucketDetail: (bucketId) =>
      called("detail", bucketId, {
        ok: true,
        detail: {
          bucket: { ...bucket, id: bucketId },
          entries: [],
          memories: [],
        },
      }),
    deleteBucket: (bucketId) =>
      called("delete", bucketId, {
        ok: true,
        bucket_id: bucketId,
        deleted_entry_ids: [],
        deleted_memory_item_ids: [],
        updated_archive_attempt_ids: [],
        correction_id: "c1",
      }),
    revokeEntry: (entryId) =>
      called("revoke", entryId, {
        ok: true,
        entry_id: entryId,
        bucket_id: "b1",
        correction_id: "c1",
        revoked_at: timestamp,
        memory_item_ids: [],
      }),
    archive: (request) => called("archive", request, archive),
    chat: (request) =>
      called("chat", request, chatResponseFixture(request.message)),
    confirmChat: (request) => {
      const result =
        request.action === "discard"
          ? {
              ok: true,
              attempt_id: request.attempt_id,
              archive_state: "discarded",
              bucket_id: null,
              entry_id: null,
              memory_item_ids: [],
              source_attempt_id: request.attempt_id,
              result_attempt_id: null,
            }
          : {
              ...archive,
              source_attempt_id: request.attempt_id,
              result_attempt_id: "a2",
            };
      return called(
        "confirm",
        request,
        schema.chatConfirmationResponseSchema.parse({
          ok: true,
          confirmation_action: request.action,
          archive: result,
          archive_state: result.archive_state,
          source_attempt_id: request.attempt_id,
          result_attempt_id: result.result_attempt_id,
          user_message: user(request.text),
          assistant_message: assistant,
          messages: [user(request.text), assistant],
        }),
      );
    },
    appendConfirmed: (request) => called("append", request, archive),
    createConfirmed: (request) => called("create", request, archive),
    moveEntry: (request) =>
      called("move", request, {
        ok: true,
        correction_id: "c1",
        source_bucket_id: "b1",
        target_bucket_id: request.target_bucket_id,
        entry: {
          ...entry,
          id: request.entry_id,
          bucket_id: request.target_bucket_id,
        },
      }),
    setBucketStatus: (request) =>
      called("status", request, {
        ok: true,
        bucket_id: request.bucket_id,
        status: request.status,
      }),
  };
}
