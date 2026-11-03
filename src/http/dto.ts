/** JSON-only DTOs shared by the HTTP service and browser frontend. */

import type {
  BucketStatus,
  BucketType,
  ClassificationAction,
} from "../domain/types.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ErrorResponse = {
  readonly ok: false;
  readonly error: string;
  readonly [key: string]: unknown;
};

export type BucketDto = {
  readonly id: string;
  readonly title: string;
  readonly type: BucketType;
  readonly status: BucketStatus;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_active_at: string;
  readonly archived_at: string | null;
};

export type EntryDto = {
  readonly id: string;
  readonly bucket_id: string;
  readonly raw_text: string;
  readonly summary: string | null;
  readonly content_type: string;
  readonly classification_confidence: number | null;
  readonly classification_reason: string | null;
  readonly created_at: string;
  readonly moved_from_bucket_id: string | null;
  readonly archive_state: string;
  readonly archived_at: string;
};

export type MemoryDto = {
  readonly id: string;
  readonly bucket_id: string;
  readonly entry_id: string | null;
  readonly kind: string;
  readonly text: string;
  readonly status: string | null;
  readonly due_at: string | null;
  readonly occurred_at: string | null;
  readonly source: string | null;
  readonly reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly metadata: JsonValue;
};

export type BucketDetailDto = {
  readonly bucket: BucketDto;
  readonly entries: readonly EntryDto[];
  readonly memories: readonly MemoryDto[];
};

export type CandidateBucketDto = {
  readonly id: string;
  readonly title: string;
  readonly type: BucketType;
  readonly status: BucketStatus;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly last_active_at_unix_ms: number;
  readonly is_recommended: boolean;
};

export type ArchiveExtractionDto = {
  readonly summary: string;
  readonly todos: readonly string[];
  readonly evidences: readonly string[];
  readonly timeline_events: readonly {
    readonly event_time: string | null;
    readonly text: string;
  }[];
  readonly decisions: readonly string[];
  readonly hypotheses: readonly string[];
  readonly entities: readonly string[];
  readonly tags: readonly string[];
};

export type ArchiveActionDto =
  | "append_recommended"
  | "append_alternative"
  | "create_new"
  | "discard"
  | "move_entry"
  | "revoke_entry";

export type ArchiveProjectionDto = {
  readonly ok: true;
  readonly attempt_id: string;
  readonly archive_state:
    "archived" | "needs_confirmation" | "revoked" | "deleted";
  readonly revoked_at?: string;
  readonly bucket_id: string | null;
  readonly entry_id: string | null;
  readonly memory_item_ids: readonly string[];
  readonly action: ClassificationAction;
  readonly confidence: number;
  readonly reason: string;
  readonly question: string | null;
  readonly candidate_bucket_ids: readonly string[];
  readonly recommended_bucket_id: string | null;
  readonly recommended_bucket: CandidateBucketDto | null;
  readonly candidate_buckets: readonly CandidateBucketDto[];
  readonly bucket_title: string | null;
  readonly bucket_type: BucketType | null;
  readonly bucket: BucketDto | null;
  readonly extraction: ArchiveExtractionDto | null;
  readonly source_attempt_id: string | null;
  readonly result_attempt_id?: string | null;
  readonly available_actions?: readonly ArchiveActionDto[];
  readonly confirmation_options?: {
    readonly recommended: "append_recommended";
    readonly alternative: "append_alternative";
    readonly create: "create_new";
    readonly discard: "discard";
  };
  readonly pending_confirmation?: boolean;
};

export type DiscardedArchiveDto = {
  readonly ok: true;
  readonly attempt_id: string;
  readonly archive_state: "discarded";
  readonly bucket_id: null;
  readonly entry_id: null;
  readonly memory_item_ids: readonly string[];
  readonly source_attempt_id: string;
  readonly result_attempt_id: null;
  readonly bucket?: BucketDto | null;
  readonly reason?: string;
};

export type ArchiveDto = ArchiveProjectionDto | DiscardedArchiveDto;

export type ChatMessageDetailsDto = JsonValue;

export type ChatMessageDto = {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly content: string;
  readonly tool_name: string | null;
  readonly tool_call_id: string | null;
  readonly details: ChatMessageDetailsDto | null;
  readonly created_at: string;
};

export type PendingChatMessageDto = {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
  readonly pending: true;
};

export type UiChatMessageDto = ChatMessageDto | PendingChatMessageDto;

export type QueryPlanDto = {
  readonly raw_text: string;
  readonly terms: readonly string[];
  readonly entity_terms: readonly string[];
  readonly topic_terms: readonly string[];
  readonly bucket_terms: readonly string[];
  readonly time_range: {
    readonly start: string;
    readonly end: string;
    readonly label: string;
  } | null;
  readonly statuses: readonly BucketStatus[];
  readonly structured_filters: readonly {
    readonly field: string;
    readonly value: string;
  }[];
  readonly limit: number;
};

export type MemoryQueryHitDto = {
  readonly bucket: BucketDto;
  readonly entry: EntryDto;
  readonly memories: readonly MemoryDto[];
  readonly matched_fields: readonly string[];
  readonly keyword_score: number;
  readonly semantic_score: number;
  readonly score: number;
};

export type MemoryQueryResponse = {
  readonly ok: true;
  readonly query: string;
  readonly query_plan: QueryPlanDto;
  readonly total_entries: number;
  readonly total_buckets: number;
  readonly results: readonly MemoryQueryHitDto[];
  readonly buckets: readonly {
    readonly bucket: BucketDto;
    readonly matched_entry_count: number;
    readonly top_score: number;
  }[];
  readonly evidence: readonly MemoryDto[];
  readonly answer: string;
};

export type ActiveBucketsResponse = {
  readonly ok: true;
  readonly buckets: readonly BucketDto[];
};

export type BucketSearchResponse = {
  readonly ok: true;
  readonly results: readonly {
    readonly bucket: BucketDto;
    readonly matched_entry_count: number;
    readonly score: number;
  }[];
};

export type BucketDetailResponse = {
  readonly ok: true;
  readonly detail: BucketDetailDto;
};

export type ChatHistoryResponse = {
  readonly ok: true;
  readonly messages: readonly ChatMessageDto[];
};

export type ArchiveResponse = ArchiveProjectionDto;

export type ChatToolMessageDto = {
  readonly name: string;
  readonly call_id: string;
  readonly arguments: JsonValue;
  readonly output: JsonValue;
};

export type ChatResponse = {
  readonly ok: true;
  readonly archive: ArchiveProjectionDto;
  readonly archive_state: ArchiveProjectionDto["archive_state"];
  readonly user_message: ChatMessageDto;
  readonly tool_messages: readonly ChatToolMessageDto[];
  readonly assistant_message: ChatMessageDto;
  readonly messages: readonly ChatMessageDto[];
  readonly chat_error: string | null;
};

export type ChatConfirmationResponse = {
  readonly ok: true;
  readonly confirmation_action: "append" | "create" | "discard";
  readonly archive: ArchiveDto;
  readonly archive_state: ArchiveDto["archive_state"];
  readonly source_attempt_id: string;
  readonly result_attempt_id: string | null;
  readonly user_message: ChatMessageDto;
  readonly assistant_message: ChatMessageDto;
  readonly messages: readonly ChatMessageDto[];
};

export type MoveEntryResponse = {
  readonly ok: true;
  readonly correction_id: string;
  readonly source_bucket_id: string;
  readonly target_bucket_id: string;
  readonly entry: EntryDto;
};

export type DeleteBucketResponse = {
  readonly ok: true;
  readonly bucket_id: string;
  readonly deleted_entry_ids: readonly string[];
  readonly deleted_memory_item_ids: readonly string[];
  readonly updated_archive_attempt_ids: readonly string[];
  readonly correction_id: string;
};

export type EntryRevocationResponse = {
  readonly ok: true;
  readonly entry_id: string;
  readonly bucket_id: string;
  readonly correction_id: string;
  readonly revoked_at: string;
  readonly memory_item_ids: readonly string[];
};

export type BucketStatusResponse = {
  readonly ok: true;
  readonly bucket_id: string;
  readonly status: BucketStatus;
};
