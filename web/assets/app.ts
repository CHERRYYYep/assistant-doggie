/**
 * Entry point: bind DOM events to controllers, then load the initial view.
 *
 * Nothing else lives here. Rendering is in `render-*.ts`, network access in
 * `api.ts`, mutable state in `state.ts`, controllers in `views.ts`.
 */

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
  detail,
  memoryQueryButton,
  memoryQueryInput,
  newChatButton,
  refreshAgendaButton,
  refreshBucketsButton,
  setStatus,
  taskList,
  taskRefresh,
} from "./dom.ts";
import {
  confirmArchive,
  actOnClarification,
  clearClarificationReply,
  discardClarificationReply,
  retryConversationTurn,
  setConversationPreview,
  cancelTask,
  resumeTasks,
  deleteBucket,
  loadHistory,
  moveEntry,
  revokeEntry,
  refreshBuckets,
  refreshAgenda,
  advanceAgendaTodo,
  reopenAgendaTodo,
  saveAgendaTodoPlan,
  transitionAgendaTodo,
  runMemoryQuery,
  sendMessage,
  showBucket,
} from "./views.ts";
import { state } from "./state.ts";
import { showConversationMessage } from "./render-chat.ts";

import { activateWorkspace, bindWorkspaceNavigation } from "./workspace.ts";
import { bindWorkItemForm, refreshWorkItems } from "./work-items.ts";

bindWorkspaceNavigation();
bindWorkItemForm();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closestActionButton(event: Event): HTMLButtonElement | null {
  return event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>("button[data-action]")
    : null;
}

chatMessages.addEventListener("click", async (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (!button) return;
  try {
    if (button.dataset["action"]?.startsWith("clarification-")) await actOnClarification(button);
    else if (button.dataset["action"] === "chat-confirm") await confirmArchive(button);
    else if (button.dataset["action"] === "move-entry") await moveEntry(button);
    else if (button.dataset["action"] === "revoke-entry") await revokeEntry(button);
    else if (button.dataset["action"] === "show-bucket") {
      await showBucket(button.dataset["bucketId"]);
    } else if (button.dataset["action"] === "show-entry-citation" && button.dataset["entryId"]) {
      await showBucket(button.dataset["bucketId"], true, button.dataset["entryId"]);
    } else if (
      button.dataset["action"] === "show-message-citation" &&
      button.dataset["messageId"]
    ) {
      if (!showConversationMessage(button.dataset["messageId"]))
        setStatus("原文消息不在当前显示的聊天范围。", "warning");
    }
  } catch (error) {
    setStatus(errorMessage(error), "warning");
  }
});

buckets.addEventListener("click", (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (button?.dataset["action"] === "show-bucket") {
    void showBucket(button.dataset["bucketId"]).catch((error: unknown) =>
      setStatus(errorMessage(error), "warning"),
    );
  }
});

agenda.addEventListener("click", (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (!button) return;
  const action = button.dataset["action"];
  const run =
    action === "todo-transition"
      ? transitionAgendaTodo(button)
      : action === "todo-advance"
        ? advanceAgendaTodo(button)
        : action === "todo-reopen"
          ? reopenAgendaTodo(button)
          : action === "todo-save-plan"
            ? saveAgendaTodoPlan(button)
            : action === "show-todo-source"
              ? showBucket(button.dataset["bucketId"])
              : undefined;
  if (run !== undefined) {
    void run.catch((error: unknown) => setStatus(errorMessage(error), "warning"));
  }
});

detail.addEventListener("click", async (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (!button) return;
  try {
    if (button.dataset["action"] === "delete-bucket")
      await deleteBucket(button.dataset["bucketId"]);
    else if (button.dataset["action"] === "revoke-entry") await revokeEntry(button);
  } catch (error) {
    setStatus(errorMessage(error), "warning");
  }
});

const previewKey = "doggie.mainConversationPreview";
function rememberedPreview(): boolean {
  try {
    return sessionStorage.getItem(previewKey) !== "false";
  } catch {
    return true;
  }
}
conversationPreview.checked = rememberedPreview();
conversationPreview.addEventListener("change", () => {
  void setConversationPreview(conversationPreview.checked);
  try {
    sessionStorage.setItem(previewKey, String(conversationPreview.checked));
  } catch {
    /* preview remains usable without browser storage */
  }
});
conversationRetry.addEventListener("click", () => void retryConversationTurn());
conversationRefresh.addEventListener("click", () => void loadHistory());
replyClear.addEventListener("click", discardClarificationReply);
chatSend.addEventListener("click", () => void sendMessage());
chatInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 180)}px`;
});
newChatButton.addEventListener("click", () => {
  activateWorkspace("chat");
  clearClarificationReply();
  chatInput.value = "";
  chatInput.style.height = "auto";
  chatInput.focus();
  setStatus("");
});
refreshBucketsButton.addEventListener("click", () => void refreshBuckets());
refreshAgendaButton.addEventListener("click", () => void refreshAgenda(true));
memoryQueryButton.addEventListener("click", () => void runMemoryQuery());
memoryQueryInput.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runMemoryQuery();
  }
});
taskList.addEventListener("click", (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (button?.dataset["action"] === "cancel-task") {
    void cancelTask(button.dataset["taskId"]).catch((error: unknown) =>
      setStatus(errorMessage(error), "warning"),
    );
  }
});
taskRefresh.addEventListener("click", () => void resumeTasks());
void Promise.all([
  refreshBuckets(),
  refreshAgenda(),
  setConversationPreview(conversationPreview.checked),
  resumeTasks(),
  refreshWorkItems(),
]);

import { agentList, agentPropose, agentRegister, agentRefresh } from "./dom.ts";
import {
  refreshAgents,
  registerWorkspace,
  proposeAgent,
  actOnAgent,
  bindAgentConversationRefresh,
} from "./agents.ts";
bindAgentConversationRefresh((taskId) => {
  if (state.preview && state.interactions.some((card) => card.execution?.taskId === taskId))
    void loadHistory();
});
agentPropose.addEventListener("click", () => void proposeAgent());
agentRegister.addEventListener("click", () => void registerWorkspace());
agentRefresh.addEventListener("click", () => void refreshAgents());
agentList.addEventListener("click", (event: MouseEvent) => {
  const button = closestActionButton(event);
  const action = button?.dataset["action"];
  const id = button?.dataset["taskId"];
  if (
    !button ||
    !id ||
    (action !== "agent-approve" && action !== "agent-reject" && action !== "agent-cancel")
  )
    return;
  button.disabled = true;
  void actOnAgent(
    id,
    action === "agent-approve" ? "approve" : action === "agent-reject" ? "reject" : "cancel",
  ).finally(() => {
    button.disabled = false;
  });
});
void refreshAgents();
