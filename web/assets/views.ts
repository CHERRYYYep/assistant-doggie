/**
 * Controllers: fetch from the server, update state, re-render.
 *
 * Rendering stays pure in the `render-*` modules; everything with a network
 * call or a state mutation lives here so the two never interleave.
 */

import type { ChatConfirmationRequest, ChatRequest } from "../../src/http/contracts.ts";
import type { PendingChatMessageDto } from "../../src/http/dto.ts";
import type { BucketType } from "../../src/domain/types.ts";
import {
  deleteBucketRequest,
  fetchActiveBuckets,
  fetchBucketDetail,
  fetchChatHistory,
  fetchMemoryQuery,
  postChatConfirmation,
  postChatMessage,
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
} from "./dom.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { bucketLabel, renderBucketSummary } from "./render-bucket.ts";
import { renderEmpty, renderMessage } from "./render-chat.ts";
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
  try {
    const data = await fetchActiveBuckets();
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
  if (!state.history.length) {
    renderEmpty();
    return;
  }
  chatMessages.innerHTML = state.history.map(renderMessage).join("");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export async function loadHistory(): Promise<void> {
  try {
    const data = await fetchChatHistory();
    state.history = [...data.messages];
    renderHistory();
  } catch (error) {
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
    await postChatMessage(request);
    await Promise.all([loadHistory(), refreshBuckets()]);
    setStatus("");
  } catch (error) {
    await loadHistory();
    setStatus(errorMessage(error), "warning");
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
