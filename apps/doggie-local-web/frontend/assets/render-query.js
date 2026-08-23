/** Natural-language query results: the parsed plan, then grouped evidence. */

import { escapeHtml, renderMarkdown } from "./markdown.js";
import { bucketLabel } from "./render-bucket.js";
import { memoryQueryResult } from "./dom.js";

export function renderQueryPlan(plan) {
  const range = plan.time_range
    ? `${escapeHtml(plan.time_range.label)}（${escapeHtml(plan.time_range.start)} 至 ${escapeHtml(plan.time_range.end)}）`
    : "未指定";
  const statuses = (plan.statuses || []).map(escapeHtml).join("、") || "未指定";
  const filters =
    (plan.structured_filters || [])
      .map((filter) => `${escapeHtml(filter.field)}=${escapeHtml(filter.value)}`)
      .join("；") || "无";
  return `<div class="query-plan"><b>查询理解</b><br>实体：${(plan.entity_terms || []).map(escapeHtml).join("、") || "未识别"}<br>主题：${(plan.topic_terms || []).map(escapeHtml).join("、") || "未识别"}<br>时间范围：${range}<br>状态：${statuses}<br>结构化筛选：${filters}</div>`;
}

export function renderMemoryQuery(data) {
  let html = renderQueryPlan(data.query_plan || {});
  html += `<div class="query-answer"><b>合并回答：</b>${renderMarkdown(data.answer || "")}</div>`;
  const results = data.results || [];
  if (!results.length) {
    memoryQueryResult.innerHTML = html + '<p class="muted">没有匹配的 Entry。</p>';
    return;
  }
  const groups = new Map();
  for (const hit of results) {
    const id = hit.bucket?.id || "unknown";
    if (!groups.has(id)) groups.set(id, { bucket: hit.bucket, entries: [] });
    groups.get(id).entries.push(hit);
  }
  html += "<h3>按 Bucket 合并的证据</h3>";
  for (const group of groups.values()) {
    html += `<div class="query-bucket"><b>${bucketLabel(group.bucket)}</b> <span class="muted">${escapeHtml(group.bucket?.status || "")} · ${group.entries.length} 条 Entry</span>`;
    for (const hit of group.entries) {
      const entry = hit.entry || {};
      html += `<div class="query-entry"><b>Entry</b> · ${escapeHtml(entry.created_at || "")} · score ${escapeHtml(hit.score)}<br>${renderMarkdown(entry.raw_text || "")}<br><span class="muted">${escapeHtml(entry.summary || "")}</span><br><span class="muted">匹配字段：${(hit.matched_fields || []).map(escapeHtml).join("、") || "关键词/语义匹配"}</span></div>`;
    }
    html += "</div>";
  }
  const evidence = data.evidence || [];
  if (evidence.length) {
    html +=
      '<div class="query-evidence"><h3>去重后的证据</h3>' +
      evidence
        .map(
          (memory) =>
            `<div class="detail-entry"><b>${escapeHtml(memory.kind || "evidence")}</b>：${escapeHtml(memory.text || "")}</div>`,
        )
        .join("") +
      "</div>";
  }
  memoryQueryResult.innerHTML = html;
}
