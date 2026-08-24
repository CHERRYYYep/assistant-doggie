/**
 * The only mutable state in the UI.
 *
 * One owner, one object. Modules read and write `state.*` rather than keeping
 * private copies, so "which bucket is selected" has exactly one answer.
 */
export const state = {
  /** Active buckets as last returned by the server. */
  activeBuckets: [],
  /** Bucket whose detail panel is open, or null. */
  selectedBucketId: null,
  /** Chat messages currently rendered, oldest first. */
  history: [],
};

export function bucketById(id) {
  return state.activeBuckets.find((bucket) => bucket.id === id);
}
