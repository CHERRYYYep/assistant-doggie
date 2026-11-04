/** JSON-only types derived from runtime schemas; all imports erase in browsers. */
import type { z } from "zod";
import type * as schema from "./response-schemas.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// JSON omits undefined properties. Keep exact optional properties and readonly
// collections without maintaining a second handwritten protocol definition.
type JsonDto<T> = T extends readonly (infer Item)[]
  ? readonly JsonDto<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: JsonDto<Exclude<T[Key], undefined>> }
    : T;
type ResponseDto<T extends z.ZodType> = JsonDto<z.output<T>>;
export type ErrorResponse = ResponseDto<typeof schema.errorResponseSchema>;
export type BucketDto = ResponseDto<typeof schema.bucketResponseSchema>;
export type EntryDto = ResponseDto<typeof schema.entryResponseSchema>;
export type MemoryDto = ResponseDto<typeof schema.memoryResponseSchema>;
export type BucketDetailDto = ResponseDto<typeof schema.bucketDetailSchema>;
export type CandidateBucketDto = ResponseDto<
  typeof schema.candidateBucketSchema
>;
export type ArchiveExtractionDto = ResponseDto<
  typeof schema.archiveExtractionSchema
>;
export type ArchiveProjectionDto = ResponseDto<
  typeof schema.archiveProjectionSchema
>;
export type DiscardedArchiveDto = ResponseDto<
  typeof schema.discardedArchiveSchema
>;
export type ArchiveDto = ResponseDto<typeof schema.archiveResponseSchema>;
export type ChatMessageDto = ResponseDto<typeof schema.chatMessageSchema>;
export type QueryPlanDto = ResponseDto<typeof schema.queryPlanSchema>;
export type MemoryQueryResponse = ResponseDto<
  typeof schema.memoryQueryResponseSchema
>;
export type ActiveBucketsResponse = ResponseDto<
  typeof schema.activeBucketsResponseSchema
>;
export type BucketSearchResponse = ResponseDto<
  typeof schema.bucketSearchResponseSchema
>;
export type BucketDetailResponse = ResponseDto<
  typeof schema.bucketDetailResponseSchema
>;
export type ChatHistoryResponse = ResponseDto<
  typeof schema.chatHistoryResponseSchema
>;
export type ArchiveResponse = ResponseDto<
  typeof schema.archiveProjectionSchema
>;
export type ChatResponse = ResponseDto<typeof schema.chatResponseSchema>;
export type ChatConfirmationResponse = ResponseDto<
  typeof schema.chatConfirmationResponseSchema
>;
export type MoveEntryResponse = ResponseDto<
  typeof schema.moveEntryResponseSchema
>;
export type DeleteBucketResponse = ResponseDto<
  typeof schema.deleteBucketResponseSchema
>;
export type EntryRevocationResponse = ResponseDto<
  typeof schema.revokeEntryResponseSchema
>;
export type BucketStatusResponse = ResponseDto<
  typeof schema.bucketStatusResponseSchema
>;
export type TodoDto = ResponseDto<typeof schema.todoSchema>;
export type AgendaResponse = ResponseDto<typeof schema.agendaResponseSchema>;
export type TodoResponse = ResponseDto<typeof schema.todoResponseSchema>;
export type TodoMutationResponse = ResponseDto<
  typeof schema.todoMutationResponseSchema
>;

export type ArchiveActionDto = NonNullable<
  ArchiveProjectionDto["available_actions"]
>[number];
export type ChatMessageDetailsDto = JsonValue;
export type MemoryQueryHitDto = MemoryQueryResponse["results"][number];
export type ChatToolMessageDto = ChatResponse["tool_messages"][number];
export type PendingChatMessageDto = {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
  readonly pending: true;
};
export type UiChatMessageDto = ChatMessageDto | PendingChatMessageDto;
