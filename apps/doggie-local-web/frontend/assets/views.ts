/**
 * Controllers: fetch from the server, update state, re-render.
 *
 * Rendering stays pure in the `render-*` modules; everything with a network
 * call or a state mutation lives here so the two never interleave.
 */

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
import { escapeHtml } from "./markdown.ts";
import { renderBucketSummary } from "./render-bucket.ts";
import { renderEmpty, renderMessage } from "./render-chat.ts";
import { renderMemoryQuery } from "./render-query.ts";
import { bucketById, state } from "./state.ts";

export async function refreshBuckets() {
  try {
    const data = await fetchActiveBuckets();
    state.activeBuckets = data.buckets || [];
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
    buckets.innerHTML = `<span class="warning">${escapeHtml(error.message)}</span>`;
  }
}

export async function showBucket(bucketId) {
  state.selectedBucketId = bucketId;
  selectedBucketLabel.textContent = "自动关联最近和热门 Bucket";
  document
    .querySelectorAll(".bucket[data-bucket-id]")
    .forEach((node) => node.classList.toggle("selected", node.dataset.bucketId === bucketId));
  try {
    const data = await fetchBucketDetail(bucketId);
    const bucket = data.detail.bucket;
    const entries = data.detail.entries || [];
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
    detail.innerHTML = `<span class="warning">${escapeHtml(error.message)}</span>`;
  }
}

export function renderHistory() {
  if (!state.history.length) {
    renderEmpty();
    return;
  }
  chatMessages.innerHTML = state.history.map(renderMessage).join("");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

export async function loadHistory() {
  try {
    const data = await fetchChatHistory();
    state.history = data.messages || [];
    renderHistory();
  } catch (error) {
    setStatus(error.message, "warning");
  }
}

export async function runMemoryQuery() {
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
    memoryQueryResult.innerHTML = `<span class="warning">${escapeHtml(error.message)}</span>`;
  }
}

export async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  chatInput.value = "";
  chatInput.style.height = "auto";
  state.history.push({
    id: `pending-${Date.now()}`,
    role: "user",
    content: text,
    pending: true,
  });
  renderHistory();
  chatSend.disabled = true;
  setStatus("正在理解、归档并生成回复…");
  try {
    await postChatMessage(text);
    await Promise.all([loadHistory(), refreshBuckets()]);
    setStatus("");
  } catch (error) {
    await loadHistory();
    setStatus(error.message, "warning");
  } finally {
    chatSend.disabled = false;
    chatInput.focus();
  }
}

export async function confirmArchive(button) {
  const card = button.closest(".archive-card");
  if (!card) return;
  const action = button.dataset.confirmAction;
  const text = card.dataset.sourceText;
  const attemptId = card.dataset.attemptId || null;
  let payload = {
    confirmation_granted: true,
    action: action === "append-alternative" ? "append" : action,
    text,
    attempt_id: attemptId,
  };
  if (action === "append") {
    payload.bucket_id = button.dataset.bucketId;
  }
  if (action === "append-alternative") {
    payload.bucket_id = card.querySelector('[data-role="alternative-bucket"]')?.value;
    if (!payload.bucket_id) throw new Error("请选择其他 Bucket");
  }
  if (action === "create") {
    payload.title = card.querySelector('[data-role="create-title"]')?.value.trim();
    payload.bucket_type = card.querySelector('[data-role="create-type"]')?.value;
    if (!payload.title) throw new Error("新 Bucket 标题不能为空");
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

export async function moveEntry(button) {
  const card = button.closest(".archive-card");
  const entryId = button.dataset.entryId;
  const targetBucketId = card?.querySelector('[data-role="move-target"]')?.value;
  if (!entryId || !targetBucketId) throw new Error("请选择目标 Bucket");
  button.disabled = true;
  try {
    await postEntryMove(entryId, targetBucketId, "用户在对话中修改了 Bucket。");
    const status = card.querySelector('[data-role="move-status"]');
    if (status)
      status.innerHTML = `<span class="success">已移动到${bucketLabel(bucketById(targetBucketId) || { id: targetBucketId })}。</span>`;
    await refreshBuckets();
  } finally {
    button.disabled = false;
  }
}

export async function deleteBucket(bucketId) {
  if (!bucketId) throw new Error("Bucket ID 不能为空");
  const bucket = bucketById(bucketId) || { id: bucketId, title: bucketId };
  if (
    !confirm(
      `确定删除 Bucket「${bucket.title || bucket.id}」吗？其中的 Entry 和结构化记忆会一并删除。`,
    )
  )
    return;
  setStatus("正在删除 Bucket…");
  await deleteBucketRequest(bucketId);
  if (state.selectedBucketId === bucketId) {
    state.selectedBucketId = null;
    detail.innerHTML = '<span class="muted">选择左侧 Bucket 查看详情。</span>';
  }
  await Promise.all([refreshBuckets(), loadHistory()]);
  setStatus("已删除 Bucket。");
}
