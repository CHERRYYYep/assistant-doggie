/** Explicit work-goal controller. A goal is selected before an Agent proposal. */
import type { WorkItem } from "../../src/domain/work-item.ts";
import { domWorkItems, domWorkItemForm, setStatus } from "./dom.ts";
import { createWorkItem, fetchWorkItems, postWorkItemAttempt, transitionWorkItem } from "./api.ts";
import { escapeHtml } from "./markdown.ts";

let items: WorkItem[] = [];
let loading = false;

export async function refreshWorkItems(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    items = [...(await fetchWorkItems()).workItems];
    renderWorkItems();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "warning");
  } finally {
    loading = false;
  }
}

export function renderWorkItems(): void {
  domWorkItems.innerHTML = items.length
    ? items
        .map((item) => {
          const terminal = item.status === "done" || item.status === "cancelled";
          return `<article class="work-item-card"><div><strong>${escapeHtml(item.title)}</strong><span class="work-item-status">${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.goal)}</p><small>验收：${escapeHtml(item.acceptance)}</small><div class="work-item-actions">${terminal ? `<button data-action="work-item-reopen" data-work-item-id="${escapeHtml(item.id)}">重新打开</button>` : `<button data-action="work-item-attempt" data-work-item-id="${escapeHtml(item.id)}">创建执行提案</button><button data-action="work-item-complete" data-work-item-id="${escapeHtml(item.id)}">标记完成</button><button data-action="work-item-cancel" data-work-item-id="${escapeHtml(item.id)}">取消目标</button>`}</div></article>`;
        })
        .join("")
    : '<p class="muted">还没有工作目标。先明确一件要完成的事。</p>';
}

export async function submitWorkItem(): Promise<void> {
  const title =
    domWorkItemForm.querySelector<HTMLInputElement>("[data-role='work-title']")?.value.trim() ?? "";
  const goal =
    domWorkItemForm.querySelector<HTMLTextAreaElement>("[data-role='work-goal']")?.value.trim() ??
    "";
  const acceptance =
    domWorkItemForm
      .querySelector<HTMLInputElement>("[data-role='work-acceptance']")
      ?.value.trim() ?? "";
  if (!title || !goal || !acceptance) throw new Error("请填写目标、说明和验收要求");
  await createWorkItem({ requestId: crypto.randomUUID(), title, goal, acceptance, sources: [] });
  for (const selector of [
    "[data-role='work-title']",
    "[data-role='work-goal']",
    "[data-role='work-acceptance']",
  ]) {
    const input = domWorkItemForm.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (input !== null) input.value = "";
  }
  await refreshWorkItems();
}

export async function actOnWorkItem(
  id: string,
  action: "attempt" | "complete" | "cancel" | "reopen",
): Promise<void> {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;
  if (action === "attempt") {
    const instruction = window.prompt("本次要交给只读 Agent 做什么？", item.goal)?.trim();
    if (!instruction) return;
    await postWorkItemAttempt(id, {
      requestId: crypto.randomUUID(),
      expectedRevision: item.revision,
      backend: "codex",
      workspaceId: null,
      instruction,
    });
  } else await transitionWorkItem(id, { expectedRevision: item.revision, action });
  await refreshWorkItems();
}

domWorkItems.addEventListener("click", (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  const id = button?.dataset["workItemId"];
  const action = button?.dataset["action"];
  if (
    !button ||
    !id ||
    !["work-item-attempt", "work-item-complete", "work-item-cancel", "work-item-reopen"].includes(
      action ?? "",
    )
  )
    return;
  button.disabled = true;
  void actOnWorkItem(
    id,
    action === "work-item-attempt"
      ? "attempt"
      : action === "work-item-complete"
        ? "complete"
        : action === "work-item-cancel"
          ? "cancel"
          : "reopen",
  )
    .catch((error: unknown) =>
      setStatus(error instanceof Error ? error.message : String(error), "warning"),
    )
    .finally(() => {
      button.disabled = false;
    });
});

export function bindWorkItemForm(): void {
  domWorkItemForm
    .querySelector<HTMLButtonElement>("[data-action='create-work-item']")
    ?.addEventListener(
      "click",
      () =>
        void submitWorkItem().catch((error: unknown) =>
          setStatus(error instanceof Error ? error.message : String(error), "warning"),
        ),
    );
}
