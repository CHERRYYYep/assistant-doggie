/** Chat transcript rendering: the empty state and one message. */

import type { ClarificationCardDto, UiChatMessageDto } from "../../src/http/dto.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { chatMessages } from "./dom.ts";
import { renderArchiveCard } from "./render-archive.ts";
import type { ConversationDelegateOptions, ConversationInteraction } from "./state.ts";

type TranscriptCard = ClarificationCardDto | ConversationInteraction;

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
    html += renderCitations(message.details["citations"], message.details["materialMessageIds"]);
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

function renderCitations(entries: unknown, currentMaterial: unknown): string {
  const buttons = (Array.isArray(entries) ? entries : []).flatMap((item: unknown, index) => {
    if (!isRecord(item)) return [];
    const entryId = stringValue(item["entryId"]);
    const bucketId = stringValue(item["bucketId"]);
    if (!entryId || !bucketId) return [];
    return [
      `<button type="button" data-action="show-entry-citation" data-bucket-id="${escapeHtml(bucketId)}" data-entry-id="${escapeHtml(entryId)}">来源 ${index + 1}</button>`,
    ];
  });
  if (Array.isArray(currentMaterial)) {
    for (const item of currentMaterial as readonly unknown[]) {
      const messageId = stringValue(item);
      if (messageId)
        buttons.push(
          `<button type="button" data-action="show-message-citation" data-message-id="${escapeHtml(messageId)}">本轮提供（未归档）</button>`,
        );
    }
  }
  return buttons.length
    ? `<div class="evidence-links" aria-label="本地证据">${buttons.join("")}</div>`
    : "";
}

const EXECUTION_LABELS = {
  pending: "等待批准",
  queued: "已入队",
  running: "正在检查",
  succeeded: "检查完成",
  failed: "检查失败",
  cancelled: "已取消",
  rejected: "已拒绝",
  stale: "结果或提案已失效",
} as const;

function renderExecution(execution: NonNullable<ClarificationCardDto["execution"]>): string {
  const { taskId, status, output, failureCode } = execution;
  return `<div class="clarification-execution">
    <p><strong>只读检查：${EXECUTION_LABELS[status]}</strong></p>
    ${status === "succeeded" && output ? `<p>工具输出（未归档）</p><pre>${escapeHtml(output)}</pre>` : ""}
    ${status !== "stale" && failureCode ? `<p>状态代码：${escapeHtml(failureCode)}</p>` : ""}
    <button type="button" data-action="clarification-agent" data-task-id="${escapeHtml(taskId)}">${status === "pending" ? "前往 Agent 面板审批" : "查看 Agent 任务"}</button>
  </div>`;
}

function renderDelegateOptions(options: ConversationDelegateOptions, submit: string): string {
  if (!options.backends.length || !options.workspaces.length) {
    return `<p class="muted">${!options.backends.length ? "需要启用 CLI。" : "请先登记要检查的工作区。"} <button type="button" data-action="clarification-agent">打开 Agent 面板</button></p>`;
  }
  return `<div class="clarification-delegate">
    <p>选择要检查的工作区和执行工具。提案提交后，需在 Agent 面板单独批准。</p>
    <label>工作区 <select data-delegate-workspace><option value="">请选择工作区</option>${options.workspaces
      .map(
        (item) =>
          `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)} · ${escapeHtml(item.baseCommit.slice(0, 8))}</option>`,
      )
      .join("")}</select></label>
    <label>工具 <select data-delegate-backend><option value="">请选择 CLI</option>${options.backends
      .map((backend) => `<option value="${escapeHtml(backend)}">${escapeHtml(backend)}</option>`)
      .join("")}</select></label>
    ${submit}
  </div>`;
}

export function renderClarification(
  card: TranscriptCard,
  options: ConversationDelegateOptions | null = null,
): string {
  const prompt = "promptMessageId" in card ? card.promptMessageId : null;
  const selected = card.selected;
  const binding = `data-clarification-id="${escapeHtml(card.id)}" data-revision="${card.revision}"${prompt ? ` data-prompt-message-id="${escapeHtml(prompt)}"` : ""}`;
  const retryBinding =
    "retryResultMessageId" in card && card.retryResultMessageId
      ? ` data-retry-result-message-id="${escapeHtml(card.retryResultMessageId)}"`
      : "";
  const button = (action: string, label: string) =>
    `<button type="button" data-action="clarification-${action}" ${binding}>${label}</button>`;
  const candidates = card.candidates
    .map((item) => {
      const reference =
        prompt && "kind" in item
          ? `data-subject-id="${escapeHtml(item.id)}" data-subject-kind="${escapeHtml(item.kind)}"`
          : `data-work-item-id="${escapeHtml(item.id)}"`;
      return `<li><button type="button" data-action="clarification-select" ${binding} ${reference}>${escapeHtml(item.title)}</button> <span>${escapeHtml(item.hint)}</span>${renderCandidateSource(item)}</li>`;
    })
    .join("");
  const active =
    card.status === "pending" ||
    (card.status === "resolved" &&
      (prompt === null || ("awaiting" in card && card.awaiting !== null)));
  const selectedEntry = selected !== null && "kind" in selected && selected.kind === "entry";
  const resolved = card.status === "resolved" && selected !== null;
  const legacyContinue = resolved && !selectedEntry && prompt === null;
  const status = card.execution?.status;
  const canDelegate =
    resolved &&
    !selectedEntry &&
    status !== "pending" &&
    status !== "queued" &&
    status !== "running";
  const showOptions =
    options !== null && options.clarificationId === card.id && options.revision === card.revision;
  return `<article class="clarification-card"><strong>${prompt ? "对话续接" : "任务澄清"}</strong>
    <p>原请求：${escapeHtml(card.originalText)}</p>
    ${card.latestReply === null ? "" : `<p>最新补充：${escapeHtml(card.latestReply)}</p>`}
    ${"contextResult" in card && card.contextResult ? `<p class="conversation-result ${escapeHtml(card.contextResult.status)}">${escapeHtml(card.contextResult.text)}${card.contextResult.status === "unknown" ? "（结果尚未确认；可核对同一次请求状态。）" : ""}</p>` : `<p>${escapeHtml(card.question)}</p>`}
    ${selected === null ? "" : `<p>${selectedEntry ? "已关联材料" : "已选目标"}：<strong>${escapeHtml(selected.title)}</strong>${renderCandidateSource(selected)}</p>`}
    ${"selectedMaterial" in card && card.selectedMaterial ? `<details class="conversation-supplied-material"><summary>本轮提供的原文</summary><pre>${escapeHtml(card.selectedMaterial.text)}</pre></details>` : ""}
    ${active && candidates ? `<ul>${candidates}</ul>${button("none", "都不是")}` : ""}
    ${active && "truncated" in card && card.truncated ? '<p class="muted">只显示部分候选，可补充更具体的名称。</p>' : ""}
    ${active ? button("reply", "补充这条请求") : ""}
    ${legacyContinue ? button("continue", "查阅本地资料并继续") : ""}
    ${canDelegate ? button("prepare", showOptions ? "关闭只读检查选项" : "准备只读检查") : ""}
    ${canDelegate && showOptions ? renderDelegateOptions(options, button("delegate", "提交只读检查提案")) : ""}
    ${active ? button("cancel", "取消澄清") : ""}
    ${"retryResultMessageId" in card && card.retryResultMessageId ? `<button type="button" data-action="clarification-retry" ${binding}${retryBinding}${"retryRequestId" in card && card.retryRequestId ? ` data-retry-request-id="${escapeHtml(card.retryRequestId)}"` : ""}>${"retryRequestId" in card && card.retryRequestId ? "核对重试结果" : "重试回答"}</button>` : ""}
    ${card.execution ? renderExecution(card.status === "stale" || card.status === "cancelled" ? { ...card.execution, status: "stale" } : card.execution) : ""}
  </article>`;
}

function renderCandidateSource(candidate: TranscriptCard["candidates"][number]): string {
  if (!("kind" in candidate) || candidate.kind !== "entry") return "";
  return ` <span class="muted">${escapeHtml(candidate.createdAt)}</span> <button type="button" data-action="show-entry-citation" data-bucket-id="${escapeHtml(candidate.bucketId)}" data-entry-id="${escapeHtml(candidate.id)}">查看原文</button>`;
}

/** Preserve unchanged confirmation form controls and focused nodes between history refreshes. */
const renderedRows = new Map<string, { readonly node: HTMLElement; readonly html: string }>();

export function renderTranscript(
  messages: readonly UiChatMessageDto[],
  cards: readonly TranscriptCard[] = [],
  options: ConversationDelegateOptions | null = null,
): void {
  const rows = messages.map((message) => ({
    id: message.id,
    html: renderMessage(message),
  }));
  const historyIds = new Set(rows.map(({ id }) => id));
  const anchor = (card: TranscriptCard): string =>
    ("promptMessageId" in card ? card.promptMessageId : null) ?? card.assistantMessageId;
  const byAssistant = new Map(cards.map((card) => [anchor(card), card]));
  const timeline = rows.flatMap((row) => {
    const card = byAssistant.get(row.id);
    return card === undefined
      ? [row]
      : [row, { id: `card-${card.id}`, html: renderClarification(card, options) }];
  });
  // A pending request can outlive the ordinary history window.
  timeline.push(
    ...cards
      .filter((card) => !historyIds.has(anchor(card)))
      .slice()
      .reverse()
      .map((card) => ({ id: `card-${card.id}`, html: renderClarification(card, options) })),
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

export function showConversationMessage(messageId: string): boolean {
  const row = renderedRows.get(messageId)?.node;
  if (!row) return false;
  row.tabIndex = -1;
  row.focus();
  return true;
}
