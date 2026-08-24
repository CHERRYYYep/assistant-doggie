/** Bucket presentation shared by the sidebar, the archive card and queries. */

import { escapeHtml } from "./markdown.ts";
import { bucketById, state } from "./state.ts";

export function bucketLabel(bucket) {
  return bucket ? `「${escapeHtml(bucket.title || bucket.id)}」` : "未命名 Bucket";
}

export function renderBucketSummary(bucket) {
  return `<div class="bucket-title">${bucketLabel(bucket)}</div><div class="bucket-meta">${escapeHtml(bucket.type || "unknown")} · ${escapeHtml(bucket.status || "")}</div><div class="bucket-summary">${escapeHtml(bucket.summary || "暂无摘要")}</div>`;
}

export function candidateBuckets(data) {
  const byId = new Map();
  for (const bucket of data.candidate_buckets || []) {
    if (bucket?.id) byId.set(bucket.id, bucket);
  }
  for (const id of data.candidate_bucket_ids || []) {
    if (!byId.has(id) && bucketById(id)) byId.set(id, bucketById(id));
  }
  for (const bucket of state.activeBuckets) {
    if (!byId.has(bucket.id)) byId.set(bucket.id, bucket);
  }
  return [...byId.values()];
}

export function renderBucketOptions(excludeId, selectedId = "") {
  const options = state.activeBuckets.filter((bucket) => bucket.id !== excludeId);
  if (!options.length) return '<option value="">暂无其他活跃 Bucket</option>';
  return options
    .map(
      (bucket) =>
        `<option value="${escapeHtml(bucket.id)}"${bucket.id === selectedId ? " selected" : ""}>${escapeHtml(bucket.title || bucket.id)} · ${escapeHtml(bucket.type || "unknown")}</option>`,
    )
    .join("");
}
