/**
 * Controllers: fetch from the server, update state, re-render.
 *
 * Rendering stays pure in the `render-*` modules; everything with a network
 * call or a state mutation lives here so the two never interleave.
 */

import type { ChatConfirmationRequest, ChatRequest } from "../../src/http/contracts.ts";
import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { PendingChatMessageDto } from "../../src/http/dto.ts";
import type { BucketType } from "../../src/domain/types.ts";
import {
  deleteBucketRequest,
  fetchActiveBuckets,
  fetchBucketDetail,
  fetchChatHistory,
  fetchMemoryQuery,
  postChatConfirmation,
  postTask,
  postTaskCancel,
  fetchTasks,
  isTerminalTask,
  watchTask,
  postEntryMove,
} from "./api.ts";
import {
  buckets,
  chatInput,
  chatMessages,
  chatSend,
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
      detail.innerHTML = '<span class="muted">选择左侧 Bucket 查看详情。</span>';
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

export async function showBucket(bucketId: string | undefined): Promise<void> {
  if (!bucketId) throw new Error("Bucket ID 不能为空");
  state.selectedBucketId = bucketId;
  selectedBucketLabel.textContent = "自动关联最近和热门 Bucket";
  document
    .querySelectorAll<HTMLElement>(".bucket[data-bucket-id]")
    .forEach((node) => node.classList.toggle("selected", node.dataset["bucketId"] === bucketId));
  try {
    const data = await fetchBucketDetail(bucketId);
    const bucket = data.detail.bucket;
    const entries = data.detail.entries;
    detail.innerHTML =
      renderBucketSummary(bucket) +
      `<div class="detail-actions"><button data-action="delete-bucket" data-bucket-id="${escapeHtml(bucket.id)}">删除 Bucket</button></div><div class="muted detail-count">${entries.length} 条 Entry</div>` +
      entries
        .map(
          (entry) =>
            `<div class="detail-entry"><b>Entry</b><br>${renderMarkdown(entry.raw_text)}<br><span class="muted">${escapeHtml(entry.summary || "")}</span></div>`,
        )
        .join("");
  } catch (error) {
    detail.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

export function renderHistory(): void {
  renderTranscript(state.history);
}

export async function loadHistory(): Promise<void> {
  const revision = ++state.historyRequestRevision;
  try {
    const data = await fetchChatHistory();
    if (revision !== state.historyRequestRevision) return;
    state.history = [...data.messages];
    renderHistory();
  } catch (error) {
    if (revision !== state.historyRequestRevision) return;
    setStatus(errorMessage(error), "warning");
  }
}

export async function runMemoryQuery(): Promise<void> {
  const query = memoryQueryInput.value.trim();
  if (!query) {
    memoryQueryResult.textContent = "请输入自然语言查询。";
    return;
  }
  memoryQueryResult.textContent = "查询中…";
  try {
    const data = await fetchMemoryQuery(query);
    renderMemoryQuery(data);
  } catch (error) {
    memoryQueryResult.innerHTML = `<span class="warning">${escapeHtml(errorMessage(error))}</span>`;
  }
}

export async function sendMessage(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
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
    await Promise.all([loadHistory(), refreshBuckets()]);
    setStatus("已更新归档。");
  } finally {
    button.disabled = false;
  }
}

export async function moveEntry(button: HTMLButtonElement): Promise<void> {
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
    await refreshBuckets();
  } finally {
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
  if (state.selectedBucketId === bucketId) {
    state.selectedBucketId = null;
    detail.innerHTML = '<span class="muted">选择左侧 Bucket 查看详情。</span>';
  }
  await Promise.all([refreshBuckets(), loadHistory()]);
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
      void Promise.all([loadHistory(), refreshBuckets()]);
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
    if (terminalChanged) await Promise.all([loadHistory(), refreshBuckets()]);
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
