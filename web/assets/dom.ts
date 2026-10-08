/** Element handles and the one-line status area, resolved once at load. */

type ElementGuard<T extends Element> = (element: Element) => element is T;

function requireElement<T extends Element>(selector: string, guard: ElementGuard<T>): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Required frontend element is missing: ${selector}`);
  }
  if (!guard(element)) {
    throw new Error(`Frontend element has the wrong type: ${selector}`);
  }
  return element;
}

const isHtmlElement: ElementGuard<HTMLElement> = (element): element is HTMLElement =>
  element instanceof HTMLElement;
const isHtmlInputElement: ElementGuard<HTMLInputElement> = (element): element is HTMLInputElement =>
  element instanceof HTMLInputElement;
const isHtmlTextAreaElement: ElementGuard<HTMLTextAreaElement> = (
  element,
): element is HTMLTextAreaElement => element instanceof HTMLTextAreaElement;
const isHtmlButtonElement: ElementGuard<HTMLButtonElement> = (
  element,
): element is HTMLButtonElement => element instanceof HTMLButtonElement;

export const chatMessages = requireElement("#chat-messages", isHtmlElement);
export const chatInput = requireElement("#chat-input", isHtmlTextAreaElement);
export const chatSend = requireElement("#chat-send", isHtmlButtonElement);
export const chatStatus = requireElement("#chat-status", isHtmlElement);
export const buckets = requireElement("#buckets", isHtmlElement);
export const detail = requireElement("#detail", isHtmlElement);
export const selectedBucketLabel = requireElement("#selected-bucket-label", isHtmlElement);
export const memoryQueryInput = requireElement("#memory-query", isHtmlInputElement);
export const memoryQueryButton = requireElement("#memory-query-button", isHtmlButtonElement);
export const memoryQueryResult = requireElement("#memory-query-result", isHtmlElement);
export const newChatButton = requireElement("#new-chat", isHtmlButtonElement);
export const refreshBucketsButton = requireElement("#refresh-buckets", isHtmlButtonElement);

/** Text shown under the composer. `kind` is "" or "warning". */
export function setStatus(text: unknown, kind: "" | "warning" = ""): void {
  chatStatus.className = `chat-status ${kind}`;
  chatStatus.textContent = text ? String(text) : "";
}
