/** Natural-language query results: the parsed plan, then grouped evidence. */

import type { MemoryQueryResponse, QueryPlanDto } from "../../../../src/http/dto.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { bucketLabel } from "./render-bucket.ts";
import { memoryQueryResult } from "./dom.ts";

export function renderQueryPlan(plan: QueryPlanDto): string {
  const range = plan.time_range
    ? `${escapeHtml(plan.time_range.label)}（${escapeHtml(plan.time_range.start)} 至 ${escapeHtml(plan.time_range.end)}）`
    : "未指定";
  const statuses = plan.statuses.map(escapeHtml).join("、") || "未指定";
  const filters =
    plan.structured_filters
      .map((filter) => `${escapeHtml(filter.field)}=${escapeHtml(filter.value)}`)
      .join("；") || "无";
  return `<div class="query-plan"><b>查询理解</b><br>实体：${plan.entity_terms.map(escapeHtml).join("、") || "未识别"}<br>主题：${plan.topic_terms.map(escapeHtml).join("、") || "未识别"}<br>时间范围：${range}<br>状态：${statuses}<br>结构化筛选：${filters}</div>`;
}

export function renderMemoryQuery(data: MemoryQueryResponse): void {
  let html = renderQueryPlan(data.query_plan);
  html += `<div class="query-answer"><b>合并回答：</b>${renderMarkdown(data.answer || "")}</div>`;
  if (!data.results.length) {
    memoryQueryResult.innerHTML = html + '<p class="muted">没有匹配的 Entry。</p>';
    return;
  }
  const groups = new Map<
    string,
    {
      readonly bucket: MemoryQueryResponse["results"][number]["bucket"];
      entries: Array<MemoryQueryResponse["results"][number]>;
    }
  >();
  for (const hit of data.results) {
    const id = hit.bucket.id || "unknown";
    const group = groups.get(id);
    if (group) {
      group.entries.push(hit);
    } else {
      groups.set(id, { bucket: hit.bucket, entries: [hit] });
    }
  }
  html += "<h3>按 Bucket 合并的证据</h3>";
  for (const group of groups.values()) {
    html += `<div class="query-bucket"><b>${bucketLabel(group.bucket)}</b> <span class="muted">${escapeHtml(group.bucket.status || "")} · ${group.entries.length} 条 Entry</span>`;
    for (const hit of group.entries) {
      const entry = hit.entry;
      html += `<div class="query-entry"><b>Entry</b> · ${escapeHtml(entry.created_at || "")} · score ${escapeHtml(hit.score)}<br>${renderMarkdown(entry.raw_text || "")}<br><span class="muted">${escapeHtml(entry.summary || "")}</span><br><span class="muted">匹配字段：${hit.matched_fields.map(escapeHtml).join("、") || "关键词/语义匹配"}</span></div>`;
    }
    html += "</div>";
  }
  if (data.evidence.length) {
    html +=
      '<div class="query-evidence"><h3>去重后的证据</h3>' +
      data.evidence
        .map(
          (memory) =>
            `<div class="detail-entry"><b>${escapeHtml(memory.kind || "evidence")}</b>：${escapeHtml(memory.text || "")}</div>`,
        )
        .join("") +
      "</div>";
  }
  memoryQueryResult.innerHTML = html;
}
