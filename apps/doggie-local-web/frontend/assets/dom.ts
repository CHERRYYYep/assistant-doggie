/** Element handles and the one-line status area, resolved once at load. */

export const chatMessages = document.querySelector("#chat-messages");
export const chatInput = document.querySelector("#chat-input");
export const chatSend = document.querySelector("#chat-send");
export const chatStatus = document.querySelector("#chat-status");
export const buckets = document.querySelector("#buckets");
export const detail = document.querySelector("#detail");
export const selectedBucketLabel = document.querySelector("#selected-bucket-label");
export const memoryQueryInput = document.querySelector("#memory-query");
export const memoryQueryButton = document.querySelector("#memory-query-button");
export const memoryQueryResult = document.querySelector("#memory-query-result");
export const newChatButton = document.querySelector("#new-chat");
export const refreshBucketsButton = document.querySelector("#refresh-buckets");

/** Text shown under the composer. `kind` is "" or "warning". */
export function setStatus(text, kind = "") {
  chatStatus.className = `chat-status ${kind}`;
  chatStatus.textContent = text || "";
}
