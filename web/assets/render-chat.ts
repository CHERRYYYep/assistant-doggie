/** Chat transcript rendering: the empty state and one message. */

import type { UiChatMessageDto } from "../../src/http/dto.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { chatMessages } from "./dom.ts";
import { renderArchiveCard } from "./render-archive.ts";

export function renderEmpty(): void {
  chatMessages.innerHTML = `<div class="empty-chat"><div class="welcome-symbol" aria-hidden="true">✳</div><span class="eyebrow">A PLACE FOR YOUR THOUGHTS</span><h3>从这里，接着想。</h3><p>记录今天的进展，留住刚刚的灵感。<br />Doggie 帮你整理，等你需要时再找回来。</p><div class="welcome-examples"><div><span>01 / 记录进展</span><p>例如：接口 A 的延迟已降到 80ms。</p></div><div><span>02 / 留下下一步</span><p>例如：明天下午复核这次压测结果。</p></div></div><small>发送后会尝试归档；目标不明确时，由你选择保存到哪里。</small></div>`;
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

/** Preserve unchanged confirmation form controls and focused nodes between history refreshes. */
const renderedRows = new Map<string, { readonly node: HTMLElement; readonly html: string }>();

export function renderTranscript(messages: readonly UiChatMessageDto[]): void {
  // Minimal DOM harnesses can still execute the real module graph without pretending
  // to implement node movement. Production browsers always use the keyed path.
  if (
    typeof document.createElement !== "function" ||
    typeof chatMessages.insertBefore !== "function"
  ) {
    renderedRows.clear();
    if (!messages.length) renderEmpty();
    else chatMessages.innerHTML = messages.map(renderMessage).join("");
    return;
  }
  const atBottom =
    chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  const ids = new Set(messages.map((message) => message.id));
  if (ids.size !== messages.length) {
    // An invalid duplicate key must not merge two unrelated confirmation cards.
    renderedRows.clear();
    chatMessages.innerHTML = messages.map(renderMessage).join("");
    return;
  }
  for (const [id, row] of renderedRows) {
    if (!ids.has(id)) {
      row.node.remove();
      renderedRows.delete(id);
    }
  }
  if (!messages.length) {
    renderEmpty();
    return;
  }
  if (!renderedRows.size) chatMessages.innerHTML = "";
  messages.forEach((message, index) => {
    const html = renderMessage(message);
    const previous = renderedRows.get(message.id);
    const node = previous?.node ?? document.createElement("div");
    if (previous?.html !== html) node.innerHTML = html;
    const position = chatMessages.children.item(index);
    if (position !== node) chatMessages.insertBefore(node, position);
    renderedRows.set(message.id, { node, html });
  });
  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}
