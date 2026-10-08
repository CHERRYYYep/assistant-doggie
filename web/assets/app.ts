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
} from "./dom.ts";
import {
  confirmArchive,
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
void Promise.all([refreshBuckets(), loadHistory()]);
