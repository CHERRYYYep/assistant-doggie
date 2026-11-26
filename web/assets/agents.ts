/** Agent controls: proposals need a separate explicit approval before queue admission. */
import type { AgentTask } from "../../src/domain/agent.ts";
import {
  agentBackend,
  agentWorkspace,
  agentPath,
  agentBucket,
  agentSession,
  agentInstruction,
  agentList,
  agentStatus,
  agentPropose,
} from "./dom.ts";
import { escapeHtml } from "./markdown.ts";
import {
  fetchAgentCapabilities,
  fetchAgentWorkspaces,
  fetchAgentTasks,
  registerAgentWorkspace,
  postAgentProposal,
  postAgentAction,
  fetchTask,
  watchTask,
} from "./api.ts";
import { activateWorkspace } from "./workspace.ts";

let tasks = new Map<string, AgentTask>();
const observers = new Map<string, AbortController>();
let refreshPromise: Promise<void> | undefined;
let refreshAgain = false;
let refreshConversation: ((taskId: string) => void) | undefined;
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function bindAgentConversationRefresh(refresh: (taskId: string) => void): void {
  refreshConversation = refresh;
}

export async function showAgentTask(taskId?: string): Promise<void> {
  activateWorkspace("tools", true);
  await refreshAgents();
  if (taskId === undefined) return;
  const task = document.getElementById(`agent-task-${taskId}`);
  if (task) task.focus();
  else agentStatus.textContent = `当前列表未显示任务 ${taskId}。请刷新确认。`;
}

export function renderAgentTasks(values: readonly AgentTask[]): string {
  return (
    values
      .map((task) => {
        const id = escapeHtml(task.id);
        const buttons =
          task.status === "pending"
            ? `<button data-action="agent-approve" data-task-id="${id}">批准只读执行</button><button data-action="agent-reject" data-task-id="${id}">拒绝</button>`
            : task.status === "queued" || task.status === "running"
              ? `<button data-action="agent-cancel" data-task-id="${id}">取消</button>`
              : "";
        return `<article class="agent-card" id="agent-task-${id}" tabindex="-1"><strong>${escapeHtml(task.backend)} · ${escapeHtml(task.status)}</strong><pre>${escapeHtml(task.instruction)}</pre><small>任务 ${id}<br>会话 ${escapeHtml(task.sessionId)}<br>工作区 ${escapeHtml(task.workspaceId ?? "无目录")}</small><div>${buttons}</div>${task.output ? `<pre>${escapeHtml(task.output)}</pre>` : ""}${task.failureCode ? `<p>${escapeHtml(task.failureCode)}</p>` : ""}</article>`;
      })
      .join("") || '<p class="muted">暂无 Agent 任务。创建提案后需再次批准。</p>'
  );
}
function observe(task: AgentTask): void {
  const queueId = task.queueId;
  if (!queueId || (task.status !== "queued" && task.status !== "running") || observers.has(task.id))
    return;
  const controller = new AbortController();
  observers.set(task.id, controller);
  void (async () => {
    try {
      const initial = (await fetchTask(queueId, controller.signal)).task;
      await watchTask(initial, () => refreshConversation?.(task.id), { signal: controller.signal });
      await refreshAgents();
      refreshConversation?.(task.id);
    } catch (error) {
      agentStatus.textContent = `状态跟踪暂停：${message(error)}；可刷新查看，勿重复批准。`;
    } finally {
      observers.delete(task.id);
    }
  })();
}
export function refreshAgents(): Promise<void> {
  refreshAgain = true;
  refreshPromise ??= (async () => {
    do {
      refreshAgain = false;
      await loadAgents();
    } while (refreshAgain);
  })().finally(() => {
    refreshPromise = undefined;
  });
  return refreshPromise;
}
async function loadAgents(): Promise<void> {
  try {
    const [capabilities, workspaces, result] = await Promise.all([
      fetchAgentCapabilities(),
      fetchAgentWorkspaces(),
      fetchAgentTasks(),
    ]);
    const backend = agentBackend.value;
    agentBackend.innerHTML = capabilities.backends
      .map((name) => `<option value="${name}">${name}</option>`)
      .join("");
    if (capabilities.backends.includes(backend as "codex" | "claude")) agentBackend.value = backend;
    agentPropose.disabled = capabilities.backends.length === 0;
    const workspace = agentWorkspace.value;
    agentWorkspace.innerHTML =
      '<option value="">无目录：仅搜索和记忆检索</option>' +
      workspaces.workspaces
        .map(
          (item) =>
            `<option value="${escapeHtml(item.id)}">${escapeHtml(item.path)} · ${escapeHtml(item.baseCommit.slice(0, 8))}</option>`,
        )
        .join("");
    if (workspaces.workspaces.some((item) => item.id === workspace))
      agentWorkspace.value = workspace;
    tasks = new Map(result.tasks.map((task) => [task.id, task]));
    agentList.innerHTML = renderAgentTasks(result.tasks);
    agentStatus.textContent = capabilities.backends.length
      ? "仅只读执行。任务经批准后进入后台队列；关闭页面不取消任务。"
      : "未启用 CLI；请在 .env 配置 DOGGIE_AGENT_CODEX_COMMAND 或 DOGGIE_AGENT_CLAUDE_COMMAND 后重启。";
    for (const task of result.tasks) observe(task);
  } catch (error) {
    agentStatus.textContent = message(error);
  }
}
export async function registerWorkspace(): Promise<void> {
  try {
    const result = await registerAgentWorkspace({
      path: agentPath.value,
      ...(agentBucket.value.trim() ? { bucketId: agentBucket.value.trim() } : {}),
    });
    await refreshAgents();
    agentWorkspace.value = result.workspace.id;
    agentStatus.textContent = "已登记目录和 Git 基线。目录内容改变后须重新登记并新建会话。";
  } catch (error) {
    agentStatus.textContent = message(error);
  }
}
export async function proposeAgent(): Promise<void> {
  agentPropose.disabled = true;
  try {
    if (agentBackend.value !== "codex" && agentBackend.value !== "claude")
      throw new Error("请选择已启用的 CLI");
    await postAgentProposal({
      backend: agentBackend.value,
      workspaceId: agentWorkspace.value || null,
      instruction: agentInstruction.value,
      ...(agentSession.value.trim() ? { sessionId: agentSession.value.trim() } : {}),
    });
    await refreshAgents();
  } catch (error) {
    agentStatus.textContent = `${message(error)}；若响应中断，请先刷新检查提案是否已创建。`;
  } finally {
    agentPropose.disabled = false;
  }
}
export async function actOnAgent(
  id: string,
  action: "approve" | "reject" | "cancel",
): Promise<void> {
  const task = tasks.get(id);
  if (!task) return;
  try {
    await postAgentAction(task, action);
    await refreshAgents();
    refreshConversation?.(id);
  } catch (error) {
    agentStatus.textContent = `${message(error)}；请刷新检查状态，不要重复批准。`;
  }
}
