/** Read-only application capability and schemas used by both tool adapters. */
import { z } from "zod";
import { requiredText } from "../domain/errors.ts";
import { StorageError } from "../storage/database.ts";
import type { Store } from "../storage/store.ts";
import { MemoryQueryService } from "./query.ts";

export const MAX_MEMORY_QUERY_CHARS = 500;
export const MAX_BUCKET_REFERENCE_CHARS = 200;
export const DEFAULT_MEMORY_RESULT_LIMIT = 20;

export const listActiveBucketsInputSchema = z.object({}).strict();
export const searchMemoryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_MEMORY_QUERY_CHARS),
  })
  .strict();
export const getBucketDetailInputSchema = z
  .object({
    bucket_id: z.string().trim().min(1).max(MAX_BUCKET_REFERENCE_CHARS),
  })
  .strict();
export class MemoryTools {
  readonly #store: Pick<Store, "listActiveBuckets" | "getBucketDetail">;
  readonly #query: MemoryQueryService;
  constructor(
    store: Pick<
      Store,
      "listActiveBuckets" | "getBucketDetail" | "searchEntryCandidates"
    >,
    clock?: () => Date,
  ) {
    this.#store = store;
    this.#query = new MemoryQueryService(store, clock);
  }
  listActiveBuckets() {
    return this.#store.listActiveBuckets(DEFAULT_MEMORY_RESULT_LIMIT);
  }
  searchMemory(query: string) {
    return this.#query.search(
      requiredText(query, "query"),
      DEFAULT_MEMORY_RESULT_LIMIT,
    );
  }
  getBucketDetail(bucketId: string) {
    const id = requiredText(bucketId, "bucket_id");
    const detail = this.#store.getBucketDetail(id);
    if (detail === undefined) throw StorageError.missingRecord("buckets", id);
    return detail;
  }
}
