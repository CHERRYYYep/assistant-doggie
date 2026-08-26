/** Chat transcript rendering: the empty state and one message. */

import type { UiChatMessageDto } from "../../../../src/http/dto.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { chatMessages } from "./dom.ts";
import { renderArchiveCard } from "./render-archive.ts";

export function renderEmpty(): void {
  chatMessages.innerHTML =
    '<div class="empty-chat"><h3>从一条工作事实开始</h3><p>例如：接口 A 最近两周的压测结果有明显回归。</p><p>我会自动归档；如果目标不明确，会展示推荐、备选、创建和不保存选项。</p></div>';
}

export function renderMessage(message: UiChatMessageDto): string {
  const role = message.role;
  if (role === "tool") {
    return `<article class="message tool"><div class="avatar">⌁</div><div class="bubble"><div class="message-text">工具：${escapeHtml(message.tool_name || "memory")}（结果已保存）</div></div></article>`;
  }
  const isUser = role === "user";
  let html = `<article class="message ${isUser ? "user" : "assistant"}${"pending" in message && message.pending ? " pending" : ""}"><div class="avatar">${isUser ? "你" : "D"}</div><div class="bubble"><div class="message-text">${renderMarkdown(message.content || "")}</div>`;
  if (!isUser && "details" in message && isRecord(message.details)) {
    const archive = message.details["archive"];
    if (isRecord(archive) && typeof archive["archive_state"] === "string") {
      html += renderArchiveCard(archive as never, stringValue(message.details["source_text"]));
    }
  }
  html += "</div></article>";
  return html;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
