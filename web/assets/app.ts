/**
 * Entry point: bind DOM events to controllers, then load the initial view.
 *
 * Nothing else lives here. Rendering is in `render-*.ts`, network access in
 * `api.ts`, mutable state in `state.ts`, controllers in `views.ts`.
 */

import {
  buckets,
  chatInput,
  chatMessages,
  chatSend,
  detail,
  memoryQueryButton,
  memoryQueryInput,
  newChatButton,
  refreshBucketsButton,
  setStatus,
  taskList,
  taskRefresh,
} from "./dom.ts";
import {
  confirmArchive,
  cancelTask,
  resumeTasks,
  deleteBucket,
  loadHistory,
  moveEntry,
  refreshBuckets,
  runMemoryQuery,
  sendMessage,
  showBucket,
} from "./views.ts";

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
    if (button.dataset["action"] === "chat-confirm") await confirmArchive(button);
    else if (button.dataset["action"] === "move-entry") await moveEntry(button);
    else if (button.dataset["action"] === "show-bucket") {
      await showBucket(button.dataset["bucketId"]);
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

detail.addEventListener("click", async (event: MouseEvent) => {
  const button = closestActionButton(event);
  if (button?.dataset["action"] !== "delete-bucket") return;
  try {
    await deleteBucket(button.dataset["bucketId"]);
  } catch (error) {
    setStatus(errorMessage(error), "warning");
  }
});

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
  chatInput.value = "";
  chatInput.focus();
  setStatus("");
});
refreshBucketsButton.addEventListener("click", () => void refreshBuckets());
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
void Promise.all([refreshBuckets(), loadHistory(), resumeTasks()]);

import { agentList, agentPropose, agentRegister, agentRefresh } from "./dom.ts";
import { refreshAgents, registerWorkspace, proposeAgent, actOnAgent } from "./agents.ts";
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
