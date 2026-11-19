/** Chat transcript rendering: the empty state and one message. */

import type { ClarificationCardDto, UiChatMessageDto } from "../../src/http/dto.ts";
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

export function renderClarification(card: ClarificationCardDto): string {
  const binding = `data-clarification-id="${escapeHtml(card.id)}" data-revision="${card.revision}"`;
  const button = (action: string, label: string) =>
    `<button type="button" data-action="clarification-${action}" ${binding}>${label}</button>`;
  const candidates = card.candidates
    .map(
      (item) =>
        `<li><button type="button" data-action="clarification-select" ${binding} data-work-item-id="${escapeHtml(item.id)}">${escapeHtml(item.title)}</button> <span>${escapeHtml(item.hint)}</span></li>`,
    )
    .join("");
  const active = card.status === "pending" || card.status === "resolved";
  return `<article class="clarification-card"><strong>任务澄清</strong>
    <p>原请求：${escapeHtml(card.originalText)}</p>
    ${card.latestReply === null ? "" : `<p>最新补充：${escapeHtml(card.latestReply)}</p>`}
    <p>${escapeHtml(card.question)}</p>
    ${card.selected === null ? "" : `<p>已选目标：<strong>${escapeHtml(card.selected.title)}</strong></p>`}
    ${candidates ? `<ul>${candidates}</ul>${button("none", "都不是")}` : ""}
    ${active ? button("reply", "补充这条请求") : ""}
    ${card.status !== "cancelled" ? button("cancel", "取消澄清") : ""}
  </article>`;
}

/** Preserve unchanged confirmation form controls and focused nodes between history refreshes. */
const renderedRows = new Map<string, { readonly node: HTMLElement; readonly html: string }>();

export function renderTranscript(
  messages: readonly UiChatMessageDto[],
  cards: readonly ClarificationCardDto[] = [],
): void {
  const rows = messages.map((message) => ({
    id: message.id,
    html: renderMessage(message),
  }));
  const historyIds = new Set(rows.map(({ id }) => id));
  const byAssistant = new Map(cards.map((card) => [card.assistantMessageId, card]));
  const timeline = rows.flatMap((row) => {
    const card = byAssistant.get(row.id);
    return card === undefined
      ? [row]
      : [row, { id: `card-${card.id}`, html: renderClarification(card) }];
  });
  // A pending request can outlive the ordinary history window.
  timeline.push(
    ...cards
      .filter((card) => !historyIds.has(card.assistantMessageId))
      .slice()
      .reverse()
      .map((card) => ({ id: `card-${card.id}`, html: renderClarification(card) })),
  );

  // Minimal DOM harnesses can still execute the real module graph without pretending
  // to implement node movement. Production browsers always use the keyed path.
  if (
    typeof document.createElement !== "function" ||
    typeof chatMessages.insertBefore !== "function"
  ) {
    renderedRows.clear();
    if (!timeline.length) renderEmpty();
    else chatMessages.innerHTML = timeline.map(({ html }) => html).join("");
    return;
  }
  const atBottom =
    chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
  const ids = new Set(timeline.map(({ id }) => id));
  if (ids.size !== timeline.length) {
    // An invalid duplicate key must not merge two unrelated confirmation cards.
    renderedRows.clear();
    chatMessages.innerHTML = timeline.map(({ html }) => html).join("");
    return;
  }
  for (const [id, row] of renderedRows) {
    if (!ids.has(id)) {
      row.node.remove();
      renderedRows.delete(id);
    }
  }
  if (!timeline.length) {
    renderEmpty();
    return;
  }
  if (!renderedRows.size) chatMessages.innerHTML = "";
  timeline.forEach(({ id, html }, index) => {
    const previous = renderedRows.get(id);
    const node = previous?.node ?? document.createElement("div");
    if (previous?.html !== html) node.innerHTML = html;
    const position = chatMessages.children.item(index);
    if (position !== node) chatMessages.insertBefore(node, position);
    renderedRows.set(id, { node, html });
  });
  if (atBottom) chatMessages.scrollTop = chatMessages.scrollHeight;
}
