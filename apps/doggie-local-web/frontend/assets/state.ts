/**
 * The only mutable state in the UI.
 *
 * One owner, one object. Modules read and write `state.*` rather than keeping
 * private copies, so "which bucket is selected" has exactly one answer.
 */

import type { BucketDto, UiChatMessageDto } from "../../../../src/http/dto.ts";

export type FrontendState = {
  /** Active buckets as last returned by the server. */
  activeBuckets: readonly BucketDto[];
  /** Bucket whose detail panel is open, or null. */
  selectedBucketId: string | null;
  /** Chat messages currently rendered, oldest first. */
  history: UiChatMessageDto[];
};

export const state: FrontendState = {
  activeBuckets: [],
  selectedBucketId: null,
  history: [],
};

export function bucketById(id: string): BucketDto | undefined {
  return state.activeBuckets.find((bucket) => bucket.id === id);
}
