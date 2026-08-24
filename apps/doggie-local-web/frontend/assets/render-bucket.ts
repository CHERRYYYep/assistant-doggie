/** Bucket presentation shared by the sidebar, the archive card and queries. */

import type {
  BucketDto,
  BucketSearchResponse,
  CandidateBucketDto,
} from "../../../../src/http/dto.ts";
import { escapeHtml } from "./markdown.ts";
import { bucketById, state } from "./state.ts";

type BucketDisplay = Pick<BucketDto, "id" | "title" | "type" | "status" | "summary">;
type CandidateSource = Pick<CandidateBucketDto, "id" | "title" | "type" | "status" | "summary">;
type BucketLabelInput = {
  readonly id: string;
  readonly title?: string | null;
  readonly type?: string | null;
  readonly status?: string | null;
  readonly summary?: string | null;
};

export function bucketLabel(bucket: BucketLabelInput | null | undefined): string {
  return bucket ? `「${escapeHtml(bucket.title || bucket.id)}」` : "未命名 Bucket";
}

export function renderBucketSummary(bucket: BucketDisplay | CandidateSource): string {
  return `<div class="bucket-title">${bucketLabel(bucket)}</div><div class="bucket-meta">${escapeHtml(bucket.type || "unknown")} · ${escapeHtml(bucket.status || "")}</div><div class="bucket-summary">${escapeHtml(bucket.summary || "暂无摘要")}</div>`;
}

export function candidateBuckets(data: {
  readonly candidate_buckets?: readonly CandidateBucketDto[];
  readonly candidate_bucket_ids?: readonly string[];
}): readonly (BucketDto | CandidateBucketDto)[] {
  const byId = new Map<string, BucketDto | CandidateBucketDto>();
  for (const bucket of data.candidate_buckets ?? []) {
    if (bucket.id) byId.set(bucket.id, bucket);
  }
  for (const id of data.candidate_bucket_ids ?? []) {
    if (!byId.has(id)) {
      const bucket = bucketById(id);
      if (bucket) byId.set(id, bucket);
    }
  }
  for (const bucket of state.activeBuckets) {
    if (!byId.has(bucket.id)) byId.set(bucket.id, bucket);
  }
  return [...byId.values()];
}

export function renderBucketOptions(excludeId: string | null, selectedId = ""): string {
  const options = state.activeBuckets.filter((bucket) => bucket.id !== excludeId);
  if (!options.length) return '<option value="">暂无其他活跃 Bucket</option>';
  return options
    .map(
      (bucket) =>
        `<option value="${escapeHtml(bucket.id)}"${bucket.id === selectedId ? " selected" : ""}>${escapeHtml(bucket.title || bucket.id)} · ${escapeHtml(bucket.type || "unknown")}</option>`,
    )
    .join("");
}

export function renderBucketSearchResult(result: BucketSearchResponse): string {
  return result.results
    .map(
      ({ bucket, matched_entry_count: count }) =>
        `<div>${renderBucketSummary(bucket)}<span class="muted">${count} 条 Entry</span></div>`,
    )
    .join("");
}
