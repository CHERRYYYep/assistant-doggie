/** Chat transcript rendering: the empty state and one message. */

import { escapeHtml, renderMarkdown } from "./markdown.js";
import { renderArchiveCard } from "./render-archive.js";
import { chatMessages } from "./dom.js";

export function renderEmpty() {
  chatMessages.innerHTML =
    '<div class="empty-chat"><h3>从一条工作事实开始</h3><p>例如：接口 A 最近两周的压测结果有明显回归。</p><p>我会自动归档；如果目标不明确，会展示推荐、备选、创建和不保存选项。</p></div>';
}

export function renderMessage(message) {
  const role = message.role || "assistant";
  if (role === "tool")
    return `<article class="message tool"><div class="avatar">⌁</div><div class="bubble"><div class="message-text">工具：${escapeHtml(message.tool_name || "memory")}（结果已保存）</div></div></article>`;
  const isUser = role === "user";
  let html = `<article class="message ${isUser ? "user" : "assistant"}${message.pending ? " pending" : ""}"><div class="avatar">${isUser ? "你" : "D"}</div><div class="bubble"><div class="message-text">${renderMarkdown(message.content || "")}</div>`;
  if (!isUser) {
    const details = message.details || {};
    if (details.archive) html += renderArchiveCard(details.archive, details.source_text || "");
  }
  html += "</div></article>";
  return html;
}
