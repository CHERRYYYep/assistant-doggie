/**
 * The archive result and confirmation card.
 *
 * This is the surface that keeps `ask_user` honest: when the server has not
 * written an Entry, the card must say so and offer all four choices.
 */

import { escapeHtml, renderMarkdown } from "./markdown.js";
import {
  bucketLabel,
  candidateBuckets,
  renderBucketOptions,
  renderBucketSummary,
} from "./render-bucket.js";
import { bucketById, state } from "./state.js";

export function renderMoveEntryCard(archive) {
  if (!archive.entry_id) return "";
  const options = renderBucketOptions(archive.bucket_id);
  const hasTarget = state.activeBuckets.some((bucket) => bucket.id !== archive.bucket_id);
  return `<div class="move-entry"><h4>修改 Bucket</h4>${hasTarget ? `<select data-role="move-target">${options}</select><button data-action="move-entry" data-entry-id="${escapeHtml(archive.entry_id)}">修改 Bucket</button>` : '<span class="muted">暂无其他活跃 Bucket 可供移动。</span>'}<div data-role="move-status" class="muted"></div></div>`;
}

export function renderArchiveCard(archive, sourceText) {
  if (!archive || !archive.archive_state) return "";
  const state = archive.archive_state;
  const cardClass =
    state === "needs_confirmation" ? "archive-card needs-confirmation" : "archive-card";
  let html = `<div class="${cardClass}" data-source-text="${escapeHtml(sourceText || archive.source_text || "")}" data-attempt-id="${escapeHtml(archive.attempt_id || "")}"><h3>${state === "needs_confirmation" ? "需要确认归档" : "归档结果"}</h3>`;
  if (archive.reason)
    html += `<div class="archive-reason"><b>模型判断理由：</b>${renderMarkdown(archive.reason)}</div>`;
  if (state === "needs_confirmation") {
    const candidates = candidateBuckets(archive);
    const recommendedId =
      archive.recommended_bucket_id || archive.recommended_bucket?.id || candidates[0]?.id || "";
    const recommended =
      archive.recommended_bucket ||
      candidates.find((bucket) => bucket.id === recommendedId) ||
      bucketById(recommendedId);
    html += `<div class="archive-question"><b>请选择：</b>${renderMarkdown(archive.question || "信息不够明确，请选择归档方式。")}</div><div class="archive-group"><h4>推荐 Bucket</h4>${recommended ? `<div class="candidate-card recommended">${renderBucketSummary(recommended)}</div><div class="archive-actions"><button class="primary" data-action="chat-confirm" data-confirm-action="append" data-bucket-id="${escapeHtml(recommended.id)}">1. 保存到${bucketLabel(recommended)}</button></div>` : '<div class="muted">模型暂未给出可直接保存的推荐 Bucket。</div>'}</div>`;
    const alternatives = candidates.filter((bucket) => bucket.id !== recommendedId);
    html += `<div class="archive-group"><h4>备选 Bucket</h4>${alternatives.length ? alternatives.map((bucket) => `<div class="candidate-card">${renderBucketSummary(bucket)}</div>`).join("") : '<div class="muted">没有其他明确候选，仍可从活跃 Bucket 中选择。</div>'}<select data-role="alternative-bucket">${renderBucketOptions(recommendedId)}</select><div class="archive-actions"><button data-action="chat-confirm" data-confirm-action="append-alternative">2. 保存到其他 Bucket</button></div></div>`;
    const types = [
      "task",
      "incident",
      "experiment",
      "idea",
      "decision",
      "meeting",
      "knowledge",
      "draft",
    ];
    html += `<div class="archive-group"><h4>创建新 Bucket</h4><input data-role="create-title" value="${escapeHtml(archive.bucket_title || "")}" placeholder="例如：接口 A 压测"><select data-role="create-type">${types.map((type) => `<option value="${type}"${type === (archive.bucket_type || "task") ? " selected" : ""}>${type}</option>`).join("")}</select><div class="archive-actions"><button data-action="chat-confirm" data-confirm-action="create">3. 创建新的 Bucket</button><button data-action="chat-confirm" data-confirm-action="discard">4. 不保存</button></div></div><p class="muted">如已保存后仍需调整，可使用“修改 Bucket”入口。</p>`;
  } else if (state === "archived") {
    const bucket = archive.bucket || bucketById(archive.bucket_id);
    html += `<p class="success"><b>已归档到：</b>${bucketLabel(bucket || { id: archive.bucket_id })}</p>`;
    if (archive.extraction?.summary)
      html += `<p><b>摘要：</b>${escapeHtml(archive.extraction.summary)}</p>`;
    html += renderMoveEntryCard(archive);
  } else if (state === "discarded") {
    html += '<p class="muted">这条内容没有保存为正式 Entry。</p>';
  }
  html += "</div>";
  return html;
}
