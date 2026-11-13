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

export const taskList = requireElement("#task-list", isHtmlElement);
export const taskRefresh = requireElement("#task-refresh", isHtmlButtonElement);
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
export const agenda = requireElement("#agenda", isHtmlElement);
export const refreshAgendaButton = requireElement("#refresh-agenda", isHtmlButtonElement);

/** Text shown under the composer. `kind` is "" or "warning". */
export function setStatus(text: unknown, kind: "" | "warning" = ""): void {
  chatStatus.className = `chat-status ${kind}`;
  chatStatus.textContent = text ? String(text) : "";
}

const isSelect: ElementGuard<HTMLSelectElement> = (element): element is HTMLSelectElement =>
  element instanceof HTMLSelectElement;
export const agentBackend = requireElement("#agent-backend", isSelect);
export const agentWorkspace = requireElement("#agent-workspace", isSelect);
export const agentPath = requireElement("#agent-path", isHtmlInputElement);
export const agentBucket = requireElement("#agent-bucket", isHtmlInputElement);
export const agentSession = requireElement("#agent-session", isHtmlInputElement);
export const agentInstruction = requireElement("#agent-instruction", isHtmlTextAreaElement);
export const agentPropose = requireElement("#agent-propose", isHtmlButtonElement);
export const agentRegister = requireElement("#agent-register", isHtmlButtonElement);
export const agentRefresh = requireElement("#agent-refresh", isHtmlButtonElement);
export const agentList = requireElement("#agent-list", isHtmlElement);
export const agentStatus = requireElement("#agent-status", isHtmlElement);
export const domWorkItems = requireElement("#work-items", isHtmlElement);
export const domWorkItemForm = requireElement("#work-item-form", isHtmlElement);

/** Stable view nodes remain mounted while moving between workspaces. */
export const workspacePanels = {
  chat: requireElement("#view-chat", isHtmlElement),
  memory: requireElement("#view-memory", isHtmlElement),
  agenda: requireElement("#view-agenda", isHtmlElement),
  search: requireElement("#view-search", isHtmlElement),
  tools: requireElement("#view-tools", isHtmlElement),
} as const;
export const workspaceButtons = {
  chat: requireElement("#nav-chat", isHtmlButtonElement),
  memory: requireElement("#nav-memory", isHtmlButtonElement),
  agenda: requireElement("#nav-agenda", isHtmlButtonElement),
  search: requireElement("#nav-search", isHtmlButtonElement),
  tools: requireElement("#nav-tools", isHtmlButtonElement),
} as const;
export const workspaceTitle = requireElement("#workspace-title", isHtmlElement);
