/**
 * Entry point: bind DOM events to controllers, then load the initial view.
 *
 * Nothing else lives here. Rendering is in `render-*.js`, network access in
 * `api.js`, mutable state in `state.js`, controllers in `views.js`.
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
} from "./dom.js";
import {
  confirmArchive,
  deleteBucket,
  loadHistory,
  moveEntry,
  refreshBuckets,
  runMemoryQuery,
  sendMessage,
  showBucket,
} from "./views.js";

chatMessages.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  try {
    if (button.dataset.action === "chat-confirm") await confirmArchive(button);
    else if (button.dataset.action === "move-entry") await moveEntry(button);
    else if (button.dataset.action === "show-bucket") await showBucket(button.dataset.bucketId);
  } catch (error) {
    setStatus(error.message, "warning");
  }
});
buckets.addEventListener("click", (event) => {
  const button = event.target.closest('button[data-action="show-bucket"]');
  if (button) showBucket(button.dataset.bucketId);
});
detail.addEventListener("click", async (event) => {
  const button = event.target.closest('button[data-action="delete-bucket"]');
  if (!button) return;
  try {
    await deleteBucket(button.dataset.bucketId);
  } catch (error) {
    setStatus(error.message, "warning");
  }
});
chatSend.addEventListener("click", sendMessage);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 180) + "px";
});
newChatButton.addEventListener("click", () => {
  chatInput.value = "";
  chatInput.focus();
  setStatus("");
});
refreshBucketsButton.addEventListener("click", refreshBuckets);
memoryQueryButton.addEventListener("click", runMemoryQuery);
memoryQueryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runMemoryQuery();
  }
});
Promise.all([refreshBuckets(), loadHistory()]);
