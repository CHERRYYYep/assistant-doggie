/**
 * Controllers: fetch from the server, update state, re-render.
 *
 * Rendering stays pure in the `render-*` modules; everything with a network
 * call or a state mutation lives here so the two never interleave.
 */

import type {
  ChatConfirmationRequest,
  ChatRequest,
  ConversationTurnRequest,
} from "../../src/http/contracts.ts";
import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { PendingChatMessageDto } from "../../src/http/dto.ts";
import type { BucketType } from "../../src/domain/types.ts";
import {
  deleteBucketRequest,
  fetchActiveBuckets,
  fetchBucketDetail,
  fetchChatHistory,
  fetchClarifications,
  fetchAgentCapabilities,
  fetchAgentWorkspaces,
  postConversationTurn,
  ApiRequestError,
  fetchMemoryQuery,
  fetchAgenda,
  isConflictError,
  postChatConfirmation,
  postTask,
  postTaskCancel,
  fetchTasks,
  isTerminalTask,
  watchTask,
  postEntryMove,
  revokeEntryRequest,
  postTodoTransition,
  postTodoPlan,
  postTodoAdvance,
  postTodoReopen,
} from "./api.ts";
import {
  buckets,
  agenda,
  chatInput,
  chatMessages,
  chatSend,
  conversationPreview,
  conversationRefresh,
  conversationRetry,
  replyClear,
  replyContext,
  replyLabel,
  detail,
  memoryQueryInput,
  memoryQueryResult,
  selectedBucketLabel,
  setStatus,
  taskList,
  taskRefresh,
} from "./dom.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { bucketLabel, renderBucketSummary } from "./render-bucket.ts";
import { renderTranscript } from "./render-chat.ts";
import { renderMemoryQuery } from "./render-query.ts";
import { bucketById, state } from "./state.ts";
import { showAgentTask } from "./agents.ts";

import { activateWorkspace } from "./workspace.ts";

const BUCKET_TYPES = [
  "idea",
  "task",
  "incident",
  "experiment",
  "decision",
  "meeting",
  "knowledge",
  "draft",
] as const satisfies readonly BucketType[];

type ConfirmButtonAction = "append" | "append-alternative" | "create" | "discard";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireDataset(element: HTMLElement, name: string): string {
  const value = element.dataset[name];
  if (!value) throw new Error(`前端元素缺少 data-${name}`);
  return value;
}

function isBucketType(value: string): value is BucketType {
  return (BUCKET_TYPES as readonly string[]).includes(value);
}

export async function refreshBuckets(): Promise<void> {
  const revision = ++state.bucketsRequestRevision;
  try {
    const data = await fetchActiveBuckets();
    if (revision !== state.bucketsRequestRevision) return;
    state.activeBuckets = [...data.buckets];
    if (state.selectedBucketId && !bucketById(state.selectedBucketId)) {
      state.selectedBucketId = null;
      detail.innerHTML = '<span class="muted">选择一个 Bucket 查看详情。</span>';
    }
    selectedBucketLabel.textContent = "自动关联最近和热门 Bucket";
    buckets.innerHTML =
      state.activeBuckets
        .map(
          (bucket) =>
            `<button class="bucket${bucket.id === state.selectedBucketId ? " selected" : ""}" data-action="show-bucket" data-bucket-id="${escapeHtml(bucket.id)}">${renderBucketSummary(bucket)}</button>`,
        )
        .join("") || '<div class="muted">暂无活跃 Bucket</div>';
  } catch (error) {
    if (revision !== state.bucketsRequestRevision) return;
    buckets.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

const TODO_STATUS_LABELS = {
  open: "待处理",
  in_progress: "进行中",
  blocked: "阻塞",
  done: "已完成",
  cancelled: "已取消",
} as const;

function todoTime(value: string | null): string {
  if (value === null) return "无日期";
  return new Date(value).toLocaleString();
}

function localDateTimeValue(value: string | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isoDateTimeValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) throw new Error("TODO 时间格式无效");
  return date.toISOString();
}

function isRepeatFrequency(value: string): value is "daily" | "weekly" | "monthly" {
  return value === "daily" || value === "weekly" || value === "monthly";
}

function todoPlanEditor(todo: (typeof state.agenda)[number]): string {
  const rule = todo.todo_rule;
  const frequency = rule?.frequency ?? "none";
  const interval = rule?.interval ?? 1;
  return `<details class="todo-plan-editor"><summary>编辑计划</summary><div class="todo-plan-fields"><label>计划时间<input data-role="todo-scheduled" type="datetime-local" value="${escapeHtml(localDateTimeValue(todo.scheduled_at))}" /></label><label>截止时间<input data-role="todo-due" type="datetime-local" value="${escapeHtml(localDateTimeValue(todo.due_at))}" /></label><label>重复<select data-role="todo-frequency"><option value="none"${frequency === "none" ? " selected" : ""}>不重复</option><option value="daily"${frequency === "daily" ? " selected" : ""}>每天</option><option value="weekly"${frequency === "weekly" ? " selected" : ""}>每周</option><option value="monthly"${frequency === "monthly" ? " selected" : ""}>每月</option></select></label><label>间隔<input data-role="todo-interval" type="number" min="1" max="31" value="${interval}" /></label><button data-action="todo-save-plan" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">保存计划</button></div></details>`;
}

export function renderAgenda(): void {
  agenda.innerHTML =
    state.agenda
      .map((todo) => {
        const historical = todo.status === "done" || todo.status === "cancelled";
        const repeating = todo.todo_rule !== null;
        const startAction =
          todo.status === "open" || todo.status === "blocked"
            ? `<button data-action="todo-transition" data-status="in_progress" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">${todo.status === "blocked" ? "继续处理" : "开始处理"}</button>`
            : "";
        const completeAction =
          todo.status === "in_progress" || todo.status === "open"
            ? repeating
              ? `<button data-action="todo-advance" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">完成并推进</button>`
              : `<button data-action="todo-transition" data-status="done" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">完成</button>`
            : "";
        const actions = historical
          ? `<button data-action="todo-reopen" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">重新打开</button>`
          : `${startAction}${completeAction}<button data-action="todo-transition" data-status="blocked" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">阻塞</button><button data-action="todo-transition" data-status="cancelled" data-todo-id="${escapeHtml(todo.id)}" data-expected-updated-at="${escapeHtml(todo.updated_at)}">取消</button>`;
        return `<article class="agenda-item agenda-${todo.status}"><div class="agenda-item-main"><strong>${escapeHtml(todo.text)}</strong><span class="todo-status">${TODO_STATUS_LABELS[todo.status]}</span><span class="muted">计划：${escapeHtml(todoTime(todo.scheduled_at))}</span><span class="muted">截止：${escapeHtml(todoTime(todo.due_at))}</span><span class="muted todo-source">来源：${escapeHtml(bucketById(todo.bucket_id)?.title ?? todo.bucket_id)}</span></div><div class="agenda-actions">${actions}<button data-action="show-todo-source" data-bucket-id="${escapeHtml(todo.bucket_id)}">查看来源</button></div>${todoPlanEditor(todo)}</article>`;
      })
      .join("") || '<span class="muted">暂无待处理 TODO</span>';
}

export async function refreshAgenda(includeHistory = false): Promise<void> {
  const revision = ++state.agendaRequestRevision;
  agenda.textContent = "加载中…";
  try {
    const data = await fetchAgenda(includeHistory);
    if (revision !== state.agendaRequestRevision) return;
    state.agenda = [...data.todos];
    renderAgenda();
  } catch (error) {
    if (revision !== state.agendaRequestRevision) return;
    agenda.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

export async function transitionAgendaTodo(button: HTMLButtonElement): Promise<void> {
  const todoId = requireDataset(button, "todoId");
  const status = button.dataset["status"];
  const expected = requireDataset(button, "expectedUpdatedAt");
  if (
    status !== "open" &&
    status !== "in_progress" &&
    status !== "done" &&
    status !== "blocked" &&
    status !== "cancelled"
  ) {
    throw new Error("TODO 状态操作无效");
  }
  button.disabled = true;
  try {
    await postTodoTransition(todoId, {
      status,
      command_text: `用户将 TODO 标记为${TODO_STATUS_LABELS[status]}。`,
      expected_updated_at: expected,
    });
    await refreshAgenda();
  } catch (error) {
    if (isConflictError(error)) await refreshAgenda(true);
    throw error;
  } finally {
    button.disabled = false;
  }
}

export async function advanceAgendaTodo(button: HTMLButtonElement): Promise<void> {
  const todoId = requireDataset(button, "todoId");
  const expected = requireDataset(button, "expectedUpdatedAt");
  button.disabled = true;
  try {
    await postTodoAdvance(todoId, {
      command_text: "用户完成当前重复 TODO 并推进下一次。",
      expected_updated_at: expected,
    });
    await refreshAgenda();
  } catch (error) {
    if (isConflictError(error)) await refreshAgenda(true);
    throw error;
  } finally {
    button.disabled = false;
  }
}

export async function saveAgendaTodoPlan(button: HTMLButtonElement): Promise<void> {
  const todoId = requireDataset(button, "todoId");
  const expected = requireDataset(button, "expectedUpdatedAt");
  const editor = button.closest<HTMLElement>(".todo-plan-editor");
  if (!editor) throw new Error("TODO 计划编辑器不存在");
  const scheduled = editor.querySelector<HTMLInputElement>('[data-role="todo-scheduled"]');
  const due = editor.querySelector<HTMLInputElement>('[data-role="todo-due"]');
  const frequency = editor.querySelector<HTMLSelectElement>('[data-role="todo-frequency"]');
  const interval = editor.querySelector<HTMLInputElement>('[data-role="todo-interval"]');
  if (!scheduled || !due || !frequency || !interval) throw new Error("TODO 计划字段不完整");
  const current = state.agenda.find((todo) => todo.id === todoId);
  if (frequency.value !== "none" && !isRepeatFrequency(frequency.value)) {
    throw new Error("TODO 重复频率无效");
  }
  const selectedFrequency = frequency.value;
  const parsedInterval = Number(interval.value);
  if (!Number.isSafeInteger(parsedInterval) || parsedInterval < 1 || parsedInterval > 31) {
    throw new Error("TODO 重复间隔必须是 1 到 31 的整数");
  }
  if (selectedFrequency !== "none" && scheduled.value.trim() === "") {
    throw new Error("重复 TODO 必须设置计划时间");
  }
  const repeatRule =
    selectedFrequency === "none"
      ? null
      : {
          frequency: selectedFrequency,
          interval: parsedInterval,
          weekdays:
            current?.todo_rule?.weekdays === null || current?.todo_rule?.weekdays === undefined
              ? undefined
              : [...current.todo_rule.weekdays],
          until: current?.todo_rule?.until ?? undefined,
          count: current?.todo_rule?.count ?? undefined,
        };
  button.disabled = true;
  try {
    await postTodoPlan(todoId, {
      scheduled_at: isoDateTimeValue(scheduled.value),
      due_at: isoDateTimeValue(due.value),
      repeat_rule: repeatRule,
      raw_time: null,
      command_text: "用户修改 TODO 计划。",
      expected_updated_at: expected,
    });
    await refreshAgenda(true);
  } catch (error) {
    if (isConflictError(error)) await refreshAgenda(true);
    throw error;
  } finally {
    button.disabled = false;
  }
}

export async function reopenAgendaTodo(button: HTMLButtonElement): Promise<void> {
  const todoId = requireDataset(button, "todoId");
  const expected = requireDataset(button, "expectedUpdatedAt");
  button.disabled = true;
  try {
    await postTodoReopen(todoId, {
      command_text: "用户重新打开 TODO。",
      expected_updated_at: expected,
    });
    await refreshAgenda(true);
  } catch (error) {
    if (isConflictError(error)) await refreshAgenda(true);
    throw error;
  } finally {
    button.disabled = false;
  }
}

export async function showBucket(
  bucketId: string | undefined,
  reveal = true,
  citedEntryId?: string,
): Promise<void> {
  if (!bucketId) throw new Error("Bucket ID 不能为空");
  if (reveal) activateWorkspace("memory", true);
  const revision = ++state.detailRequestRevision;
  state.selectedBucketId = bucketId;
  detail.textContent = "正在加载记录…";
  selectedBucketLabel.textContent = "自动关联最近和热门 Bucket";
  document
    .querySelectorAll<HTMLElement>(".bucket[data-bucket-id]")
    .forEach((node) => node.classList.toggle("selected", node.dataset["bucketId"] === bucketId));
  try {
    const data = await fetchBucketDetail(bucketId);
    if (revision !== state.detailRequestRevision || state.selectedBucketId !== bucketId) return;
    const bucket = data.detail.bucket;
    const entries = data.detail.entries;
    const citedIndex =
      citedEntryId === undefined ? -1 : entries.findIndex(({ id }) => id === citedEntryId);
    detail.innerHTML =
      renderBucketSummary(bucket) +
      `<div class="detail-actions"><button data-action="delete-bucket" data-bucket-id="${escapeHtml(bucket.id)}">删除 Bucket</button></div><div class="muted detail-count">${entries.length} 条 Entry</div>` +
      (citedEntryId !== undefined && citedIndex === -1
        ? '<p class="warning">引用来源不在当前 Bucket 的有效记录中，可能已撤销或移动。</p>'
        : "") +
      entries
        .map(
          (entry, index) =>
            `<div ${index === citedIndex ? 'class="detail-entry cited-entry" id="cited-entry" tabindex="-1"' : 'class="detail-entry"'}><b>${index === citedIndex ? "引用来源" : "Entry"}</b><br>${renderMarkdown(entry.raw_text)}<br><span class="muted">${escapeHtml(entry.summary || "")}</span><br><button data-action="revoke-entry" data-entry-id="${escapeHtml(entry.id)}">撤销记录</button></div>`,
        )
        .join("");
    if (citedIndex !== -1) detail.querySelector<HTMLElement>("#cited-entry")?.focus();
  } catch (error) {
    if (revision !== state.detailRequestRevision || state.selectedBucketId !== bucketId) return;
    detail.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

export function renderHistory(): void {
  renderTranscript(state.history, state.preview ? state.clarifications : [], state.delegateOptions);
}

export async function loadHistory(): Promise<void> {
  const revision = ++state.historyRequestRevision;
  try {
    const [data, cards] = await Promise.all([
      fetchChatHistory(),
      state.preview ? fetchClarifications().catch((error: unknown) => ({ error })) : undefined,
    ]);
    if (revision !== state.historyRequestRevision) return;
    state.history = [...data.messages];
    if (cards && "clarifications" in cards) state.clarifications = cards.clarifications;
    if (cards && "error" in cards) {
      state.clarifications = [];
      setStatus(`无法恢复澄清卡：${errorMessage(cards.error)}`, "warning");
    }
    renderHistory();
  } catch (error) {
    if (revision !== state.historyRequestRevision) return;
    setStatus(errorMessage(error), "warning");
  }
}

export async function runMemoryQuery(): Promise<void> {
  const revision = ++state.queryRequestRevision;
  const query = memoryQueryInput.value.trim();
  if (!query) {
    memoryQueryResult.textContent = "请输入自然语言查询。";
    return;
  }
  memoryQueryResult.textContent = "查询中…";
  try {
    const data = await fetchMemoryQuery(query);
    if (revision !== state.queryRequestRevision) return;
    renderMemoryQuery(data);
  } catch (error) {
    if (revision !== state.queryRequestRevision) return;
    memoryQueryResult.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

export async function setConversationPreview(enabled: boolean): Promise<void> {
  if (!enabled && state.reply !== null && chatInput.value.trim() !== "") {
    conversationPreview.checked = true;
    setStatus("请先发送或丢弃卡片回复草稿。", "warning");
    return;
  }
  state.preview = enabled;
  conversationRefresh.hidden = !enabled;
  if (!enabled) {
    state.clarifications = [];
    state.delegateOptions = null;
    clearClarificationReply();
    renderHistory();
  }
  await loadHistory();
}

export function discardClarificationReply(): void {
  if (state.reply !== null) {
    chatInput.value = "";
    chatInput.style.height = "auto";
  }
  clearClarificationReply();
}

export function clearClarificationReply(): void {
  state.reply = null;
  replyContext.hidden = true;
}

export async function actOnClarification(button: HTMLButtonElement): Promise<void> {
  if (!state.preview) return;
  const action = button.dataset["action"];
  if (action === "clarification-agent") {
    await showAgentTask(button.dataset["taskId"]);
    return;
  }
  if (chatSend.disabled || state.retryTurn !== null || button.disabled) return;
  const clarificationId = requireDataset(button, "clarificationId");
  const expectedRevision = Number(requireDataset(button, "revision"));
  if (action === "clarification-reply") {
    const card = state.clarifications.find(({ id }) => id === clarificationId);
    if (!card || card.revision !== expectedRevision) return;
    if (chatInput.value.trim() && state.reply?.clarificationId !== clarificationId) {
      setStatus("输入框中还有草稿，请先处理后再回复这张卡。", "warning");
      return;
    }
    state.reply = { clarificationId, expectedRevision };
    replyLabel.textContent = `回复：${card.originalText.slice(0, 100)}`;
    replyContext.hidden = false;
    chatInput.focus();
    return;
  }
  if (
    (action === "clarification-continue" || action === "clarification-delegate") &&
    state.reply?.clarificationId === clarificationId &&
    chatInput.value.trim()
  ) {
    setStatus("请先发送或丢弃这张卡的回复草稿。", "warning");
    chatInput.focus();
    return;
  }
  const base = { clarificationId, expectedRevision, requestId: crypto.randomUUID() };
  if (action === "clarification-prepare") {
    const options = state.delegateOptions;
    if (options?.clarificationId === clarificationId && options.revision === expectedRevision) {
      state.delegateOptions = null;
      renderHistory();
      return;
    }
    button.disabled = true;
    try {
      const [{ backends }, { workspaces }] = await Promise.all([
        fetchAgentCapabilities(),
        fetchAgentWorkspaces(),
      ]);
      if (
        !state.preview ||
        !state.clarifications.some(
          (card) => card.id === clarificationId && card.revision === expectedRevision,
        )
      )
        return;
      state.delegateOptions = { clarificationId, revision: expectedRevision, backends, workspaces };
      renderHistory();
    } finally {
      button.disabled = false;
    }
  } else if (action === "clarification-continue") {
    await submitPreviewTurn({ ...base, action: "continue" });
  } else if (action === "clarification-delegate") {
    const options = state.delegateOptions;
    if (options?.clarificationId !== clarificationId || options.revision !== expectedRevision)
      return;
    const group = button.closest(".clarification-delegate");
    const backend = group?.querySelector<HTMLSelectElement>("[data-delegate-backend]")?.value;
    const workspaceId = group?.querySelector<HTMLSelectElement>("[data-delegate-workspace]")?.value;
    if (
      (backend !== "codex" && backend !== "claude") ||
      !options.backends.includes(backend) ||
      workspaceId === undefined ||
      !options.workspaces.some(({ id }) => id === workspaceId)
    ) {
      setStatus("请选择已登记的工作区和可用的 CLI。", "warning");
      return;
    }
    await submitPreviewTurn({ ...base, action: "delegate", backend, workspaceId });
  } else if (action === "clarification-select") {
    await submitPreviewTurn({
      ...base,
      action: "select",
      workItemId: requireDataset(button, "workItemId"),
    });
  } else if (action === "clarification-none" || action === "clarification-cancel") {
    await submitPreviewTurn({
      ...base,
      action: action === "clarification-none" ? "none" : "cancel",
    });
  }
}

export async function retryConversationTurn(): Promise<void> {
  if (state.retryTurn !== null) await submitPreviewTurn(state.retryTurn);
}

async function submitPreviewTurn(request: ConversationTurnRequest): Promise<void> {
  if (chatSend.disabled) return;
  chatSend.disabled = true;
  conversationPreview.disabled = true;
  conversationRetry.disabled = true;
  replyClear.disabled = true;
  setStatus("正在处理主对话…");
  try {
    const { result } = await postConversationTurn(request);
    state.retryTurn = null;
    if ("text" in request && chatInput.value.trim() === request.text) {
      chatInput.value = "";
      chatInput.style.height = "auto";
      if (request.action === "reply") clearClarificationReply();
    }
    if (result.kind === "archive") await Promise.all([refreshBuckets(), refreshAgenda()]);
    if (request.action === "delegate" && result.kind === "clarification") {
      state.delegateOptions = null;
    }
    setStatus(
      "chatError" in result
        ? result.chatError
        : request.action === "delegate" && result.kind === "clarification"
          ? "已提交只读检查提案。请在 Agent 面板核对后审批。"
          : "",
      "chatError" in result && result.chatError ? "warning" : "",
    );
    await loadHistory();
  } catch (error) {
    const known = error instanceof ApiRequestError && error.status < 500;
    state.retryTurn = known ? null : request;
    await loadHistory();
    setStatus(known ? errorMessage(error) : "提交结果未确认。可用同一请求核对或重试。", "warning");
  } finally {
    chatSend.disabled = false;
    conversationPreview.disabled = state.retryTurn !== null;
    conversationRetry.hidden = state.retryTurn === null;
    conversationRetry.disabled = false;
    replyClear.disabled = false;
    chatInput.focus();
  }
}

export async function sendMessage(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  if (state.retryTurn !== null) {
    setStatus("请先核对上次发送结果。", "warning");
    return;
  }
  if (state.preview) {
    if (text.length > 4000) {
      setStatus("主对话预览每条消息最多 4000 字符。", "warning");
      return;
    }
    const requestId = crypto.randomUUID();
    await submitPreviewTurn(
      state.reply === null
        ? { action: "message", text, requestId }
        : { action: "reply", text, requestId, ...state.reply },
    );
    return;
  }
  chatInput.value = "";
  chatInput.style.height = "auto";
  const pending: PendingChatMessageDto = {
    id: `pending-${Date.now()}`,
    role: "user",
    content: text,
    pending: true,
  };
  state.history.push(pending);
  renderHistory();
  chatSend.disabled = true;
  setStatus("正在理解、归档并生成回复…");
  try {
    const request: ChatRequest = { message: text };
    const { task } = await postTask(request);
    applyTask(task);
    observeTask(task);
    setStatus(
      isTerminalTask(task)
        ? "任务已结束；正在刷新历史。"
        : "已提交后台任务；关闭页面或事件断流不会取消。",
    );
  } catch (error) {
    await loadHistory();
    setStatus(`提交结果未确认：${errorMessage(error)}。请刷新任务状态，不要重复发送。`, "warning");
    await resumeTasks();
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
}

export async function confirmArchive(button: HTMLButtonElement): Promise<void> {
  const card = button.closest<HTMLElement>(".archive-card");
  if (!card) return;
  const action = button.dataset["confirmAction"] as ConfirmButtonAction | undefined;
  if (!action) throw new Error("确认按钮缺少操作类型");
  const text = requireDataset(card, "sourceText");
  const attemptId = requireDataset(card, "attemptId");
  const base = {
    confirmation_granted: true as const,
    attempt_id: attemptId,
    text,
  };
  let payload: ChatConfirmationRequest;
  if (action === "append" || action === "append-alternative") {
    const bucketId =
      action === "append"
        ? requireDataset(button, "bucketId")
        : card.querySelector<HTMLSelectElement>('[data-role="alternative-bucket"]')?.value;
    if (!bucketId) throw new Error("请选择其他 Bucket");
    payload = { ...base, action: "append", bucket_id: bucketId };
  } else if (action === "create") {
    const title = card.querySelector<HTMLInputElement>('[data-role="create-title"]')?.value.trim();
    const bucketTypeValue = card.querySelector<HTMLSelectElement>(
      '[data-role="create-type"]',
    )?.value;
    if (!title) throw new Error("新 Bucket 标题不能为空");
    if (!bucketTypeValue || !isBucketType(bucketTypeValue)) {
      throw new Error("新 Bucket 类型无效");
    }
    payload = {
      ...base,
      action: "create",
      title,
      bucket_type: bucketTypeValue,
    };
  } else {
    payload = { ...base, action: "discard" };
  }
  button.disabled = true;
  setStatus("正在处理归档选择…");
  try {
    await postChatConfirmation(payload);
    await Promise.all([loadHistory(), refreshBuckets(), refreshAgenda()]);
    setStatus("已更新归档。");
  } finally {
    button.disabled = false;
  }
}

export async function moveEntry(button: HTMLButtonElement): Promise<void> {
  if (button.disabled) return;
  const card = button.closest<HTMLElement>(".archive-card");
  const entryId = button.dataset["entryId"];
  const targetBucketId = card?.querySelector<HTMLSelectElement>('[data-role="move-target"]')?.value;
  if (!entryId || !targetBucketId) throw new Error("请选择目标 Bucket");
  button.disabled = true;
  try {
    await postEntryMove({
      entry_id: entryId,
      target_bucket_id: targetBucketId,
      command_text: "用户在对话中修改了 Bucket。",
    });
    const status = card?.querySelector<HTMLElement>('[data-role="move-status"]');
    if (status) {
      status.innerHTML = `<span class="success">已移动到${bucketLabel(bucketById(targetBucketId) || { id: targetBucketId })}。</span>`;
    }
    await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
    if (state.selectedBucketId) await showBucket(state.selectedBucketId, false);
  } finally {
    button.disabled = false;
  }
}

export async function revokeEntry(button: HTMLButtonElement): Promise<void> {
  const entryId = requireDataset(button, "entryId");
  if (button.disabled || state.revokingEntries.has(entryId)) return;
  if (!confirm("撤销这条记录？它及其专属派生记忆将不再用于回答，聊天与审计仍保留。")) return;
  state.revokingEntries.add(entryId);
  button.disabled = true;
  setStatus("正在撤销记录…");
  try {
    await revokeEntryRequest(entryId);
    // Discard reads begun before the mutation, including their error handlers.
    ++state.detailRequestRevision;
    ++state.queryRequestRevision;
    memoryQueryResult.textContent = "记忆已更新，请重新查询。";
    await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
    if (state.selectedBucketId) await showBucket(state.selectedBucketId, false);
    setStatus("记录已撤销。为避免引用旧事实，后续回答从新的聊天上下文继续。");
  } finally {
    state.revokingEntries.delete(entryId);
    button.disabled = false;
  }
}

export async function deleteBucket(bucketId: string | undefined): Promise<void> {
  if (!bucketId) throw new Error("Bucket ID 不能为空");
  const bucket = bucketById(bucketId) || { id: bucketId, title: bucketId };
  if (
    !confirm(
      `确定删除 Bucket「${bucket.title || bucket.id}」吗？其中的 Entry 和结构化记忆会一并删除。`,
    )
  ) {
    return;
  }
  setStatus("正在删除 Bucket…");
  await deleteBucketRequest(bucketId);
  ++state.detailRequestRevision;
  ++state.queryRequestRevision;
  memoryQueryResult.textContent = "记忆已更新，请重新查询。";
  if (state.selectedBucketId === bucketId) {
    state.selectedBucketId = null;
    detail.innerHTML = '<span class="muted">选择一个 Bucket 查看详情。</span>';
  }
  await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
  setStatus("已删除 Bucket。");
}

const TASK_LABELS = {
  queued: "排队中",
  running: "运行中",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
} as const;

export function renderTasks(): void {
  taskList.innerHTML =
    [...state.tasks.values()]
      .map((task) => {
        const active = !isTerminalTask(task);
        const cancelling = state.cancellingTasks.has(task.id);
        const paused = state.pausedTasks.has(task.id);
        const error = task.errorCode === "interrupted" ? "（服务中断）" : "";
        return `<div class="task-row"><span>${escapeHtml(task.id)} · ${TASK_LABELS[task.status]}${error}${paused && active ? " · 状态跟踪已暂停，后台可能仍在运行" : ""}</span>${active ? `<button data-action="cancel-task" data-task-id="${escapeHtml(task.id)}"${cancelling ? " disabled" : ""}>${cancelling ? "取消请求中…" : "取消任务"}</button>` : ""}</div>`;
      })
      .join("") || '<span class="muted">暂无后台任务</span>';
}

/** Revision ordering is shared by SSE, polling, recovery and cancellation responses. */
function applyTask(task: TaskSnapshot, refreshTerminal = true): void {
  const previous = state.tasks.get(task.id);
  if (previous && (previous.revision >= task.revision || isTerminalTask(previous))) return;
  state.tasks.set(task.id, task);
  if (isTerminalTask(task)) {
    state.taskObservers.get(task.id)?.abort();
    state.pausedTasks.delete(task.id);
    if (refreshTerminal) {
      void Promise.all([loadHistory(), refreshBuckets(), refreshAgenda()]);
    }
  }
  // Keep a bounded recent view without dropping an active task's cancel control.
  for (const [id, snapshot] of state.tasks) {
    if (state.tasks.size <= 40) break;
    if (isTerminalTask(snapshot)) state.tasks.delete(id);
  }
  renderTasks();
}

function observeTask(task: TaskSnapshot): void {
  if (isTerminalTask(task) || state.taskObservers.has(task.id)) return;
  const controller = new AbortController();
  state.taskObservers.set(task.id, controller);
  state.pausedTasks.delete(task.id);
  renderTasks();
  void watchTask(task, (snapshot) => applyTask(snapshot), { signal: controller.signal })
    .catch(() => {
      const latest = state.tasks.get(task.id);
      if (latest && !isTerminalTask(latest)) {
        state.pausedTasks.add(task.id);
        setStatus(
          "任务状态跟踪已暂停。后台任务可能仍在运行；请刷新任务状态，不要重复发送。",
          "warning",
        );
      }
    })
    .finally(() => {
      state.taskObservers.delete(task.id);
      renderTasks();
    });
}

export async function resumeTasks(): Promise<void> {
  if (state.resumingTasks) return;
  state.resumingTasks = true;
  taskRefresh.disabled = true;
  try {
    const { tasks } = await fetchTasks();
    let terminalChanged = false;
    for (const task of tasks) {
      const previous = state.tasks.get(task.id);
      if (isTerminalTask(task) && (!previous || !isTerminalTask(previous))) terminalChanged = true;
      applyTask(task, false);
      observeTask(state.tasks.get(task.id) ?? task);
    }
    renderTasks();
    if (terminalChanged) await Promise.all([loadHistory(), refreshBuckets(), refreshAgenda()]);
  } catch (error) {
    setStatus(
      `无法恢复任务：${errorMessage(error)}。请稍后刷新任务状态，不要重复发送。`,
      "warning",
    );
  } finally {
    state.resumingTasks = false;
    taskRefresh.disabled = false;
  }
}

export async function cancelTask(id: string | undefined): Promise<void> {
  if (!id) throw new Error("任务 ID 不能为空");
  const task = state.tasks.get(id);
  if (!task || isTerminalTask(task) || state.cancellingTasks.has(id)) return;
  state.cancellingTasks.add(id);
  renderTasks();
  try {
    applyTask((await postTaskCancel(id)).task);
    // A queued/running response is not proof of cancellation; keep observing it.
    const latest = state.tasks.get(id);
    if (latest) observeTask(latest);
  } catch (error) {
    setStatus(`取消结果未确认：${errorMessage(error)}。请刷新任务状态。`, "warning");
  } finally {
    state.cancellingTasks.delete(id);
    renderTasks();
  }
}
