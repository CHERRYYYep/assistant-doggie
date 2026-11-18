/** Established JSON shapes shared by memory consumers. */
import { projectBucket } from "./archive-view.ts";
import type { MemoryQueryPlan } from "./memory-query.ts";
import type { MemorySearchResponse } from "./query.ts";
import type { BucketDetail, EntryRow, MemoryRow } from "../storage/store.ts";

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
