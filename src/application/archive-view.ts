/** Shared legacy archive snapshot used by HTTP and persisted conversation audit. */
import type { ArchiveExecution } from "./archive-runtime.ts";
import type { ArchiveResult } from "./archive.ts";
import type { BucketView } from "../domain/types.ts";
import type { BucketRow, Store } from "../storage/store.ts";

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

export function projectArchiveExecution(
  store: Pick<Store, "getBucket" | "listEffectiveMemoryIdsForEntry">,
  execution: ArchiveExecution,
) {
  const memoryItemIds =
    execution.result.bucketId === undefined ||
    execution.result.entryId === undefined
      ? []
      : store.listEffectiveMemoryIdsForEntry(
          execution.result.entryId,
          execution.result.bucketId,
        );
  return projectArchive(execution.result, {
    candidates: execution.candidates,
    bucket:
      execution.result.bucketId === undefined
        ? undefined
        : store.getBucket(execution.result.bucketId),
    memoryItemIds,
  });
}
