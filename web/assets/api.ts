/** Every server route and JSON DTO the browser UI depends on. */
import { MAX_RESPONSE_BYTES, validateResponse } from "./validate-response.ts";

import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { WorkItem, WorkItemAttempt } from "../../src/domain/work-item.ts";
import type {
  ChatConfirmationRequest,
  ChatRequest,
  ConversationTurnRequest,
  MoveEntryRequest,
  TodoAdvanceRequest,
  TodoPlanRequest,
  TodoReopenRequest,
  TodoTransitionRequest,
} from "../../src/http/contracts.ts";
import type {
  ActiveBucketsResponse,
  BucketDetailResponse,
  ChatConfirmationResponse,
  ChatHistoryResponse,
  ChatResponse,
  ConversationTurnResponse,
  ClarificationListResponse,
  DeleteBucketResponse,
  EntryRevocationResponse,
  MemoryQueryResponse,
  MoveEntryResponse,
  AgendaResponse,
  TodoMutationResponse,
} from "../../src/http/dto.ts";

export const ROUTES = {
  chat: "/api/chat",
  conversationTurns: "/api/conversation/turns",
  clarifications: "/api/conversation/clarifications",
  tasks: "/api/tasks",
  chatConfirm: "/api/chat/confirm",
  chatHistory: "/api/chat/history",
  activeBuckets: "/api/buckets/active",
  bucket: "/api/buckets/",
  entry: "/api/entries/",
  memoryQuery: "/api/memory/query",
  correctionMove: "/api/corrections/move",
  agenda: "/api/agenda",
  todo: "/api/todos/",
  workItems: "/api/work-items",
} as const;

type WorkItemsResponse = { readonly ok: true; readonly workItems: readonly WorkItem[] };
type WorkItemResponse = { readonly ok: true; readonly workItem: WorkItem };
export function fetchWorkItems(): Promise<WorkItemsResponse> {
  return jsonRequest(ROUTES.workItems);
}
export function createWorkItem(input: unknown): Promise<WorkItemResponse> {
  return jsonRequest(ROUTES.workItems, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}
export function postWorkItemAttempt(
  id: string,
  input: WorkItemAttempt,
): Promise<{ readonly ok: true; readonly task: import("../../src/domain/agent.ts").AgentTask }> {
  return jsonRequest(`${ROUTES.workItems}/${encodeURIComponent(id)}/attempts`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}
export function transitionWorkItem(
  id: string,
  input: { readonly expectedRevision: number; readonly action: "complete" | "reopen" | "cancel" },
): Promise<WorkItemResponse> {
  return jsonRequest(`${ROUTES.workItems}/${encodeURIComponent(id)}/transition`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export function isConflictError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 409;
}

/** Fetch JSON and turn every non-2xx response into a stable browser Error. */
export async function jsonRequest<TResponse>(
  url: string,
  options: RequestInit = {},
): Promise<TResponse> {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json")
    throw new Error(`HTTP ${response.status}: API 响应格式无效`);
  const raw = await readJsonBody(response);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`HTTP ${response.status}: API 响应格式无效`);
  }
  const pathname = new URL(url, "http://localhost").pathname;
  validateResponse(data, options.method ?? "GET", pathname, response.ok);
  if (!response.ok) {
    throw new ApiRequestError(response.status, errorMessage(data) ?? `HTTP ${response.status}`);
  }
  return data as TResponse;
}

async function readJsonBody(response: Response): Promise<string> {
  if (response.body === null) throw new Error("API 响应格式无效");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("API 响应大小超限");
      chunks.push(decoder.decode(chunk.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* disconnected transport */
    }
    reader.releaseLock();
  }
}

function errorMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const error = Reflect.get(value, "error");
  return typeof error === "string" && error !== "" ? error : undefined;
}

/** POST a JSON body. The server requires this Content-Type on every write. */
function postJson<TResponse>(url: string, payload: unknown): Promise<TResponse> {
  return jsonRequest<TResponse>(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function fetchActiveBuckets(limit = 100): Promise<ActiveBucketsResponse> {
  return jsonRequest(`${ROUTES.activeBuckets}?limit=${limit}`);
}

export function fetchBucketDetail(bucketId: string): Promise<BucketDetailResponse> {
  return jsonRequest(ROUTES.bucket + encodeURIComponent(bucketId));
}

export function fetchChatHistory(limit = 40): Promise<ChatHistoryResponse> {
  return jsonRequest(`${ROUTES.chatHistory}?limit=${limit}`);
}

export function fetchClarifications(): Promise<ClarificationListResponse> {
  return jsonRequest(ROUTES.clarifications);
}

export function postConversationTurn(
  request: ConversationTurnRequest,
): Promise<ConversationTurnResponse> {
  return postJson(ROUTES.conversationTurns, request);
}

export function fetchMemoryQuery(query: string, limit = 20): Promise<MemoryQueryResponse> {
  return jsonRequest(`${ROUTES.memoryQuery}?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function postChatMessage(request: ChatRequest): Promise<ChatResponse> {
  return postJson(ROUTES.chat, request);
}

export function postChatConfirmation(
  request: ChatConfirmationRequest,
): Promise<ChatConfirmationResponse> {
  return postJson(ROUTES.chatConfirm, request);
}

export function postEntryMove(request: MoveEntryRequest): Promise<MoveEntryResponse> {
  return postJson(ROUTES.correctionMove, request);
}

/** DELETE carries no body, so it needs no Content-Type. */
export function deleteBucketRequest(bucketId: string): Promise<DeleteBucketResponse> {
  return jsonRequest(ROUTES.bucket + encodeURIComponent(bucketId), {
    method: "DELETE",
  });
}

export function revokeEntryRequest(entryId: string): Promise<EntryRevocationResponse> {
  return jsonRequest(ROUTES.entry + encodeURIComponent(entryId), { method: "DELETE" });
}

export function fetchAgenda(includeHistory = false): Promise<AgendaResponse> {
  return jsonRequest(`${ROUTES.agenda}?include_history=${includeHistory ? "true" : "false"}`);
}

function todoUrl(todoId: string, action = ""): string {
  return `${ROUTES.todo}${encodeURIComponent(todoId)}${action}`;
}

export function postTodoTransition(
  todoId: string,
  request: TodoTransitionRequest,
): Promise<TodoMutationResponse> {
  return postJson(todoUrl(todoId, "/transition"), request);
}

export function postTodoPlan(
  todoId: string,
  request: TodoPlanRequest,
): Promise<TodoMutationResponse> {
  return postJson(todoUrl(todoId, "/plan"), request);
}

export function postTodoAdvance(
  todoId: string,
  request: TodoAdvanceRequest,
): Promise<TodoMutationResponse> {
  return postJson(todoUrl(todoId, "/advance"), request);
}

export function postTodoReopen(
  todoId: string,
  request: TodoReopenRequest,
): Promise<TodoMutationResponse> {
  return postJson(todoUrl(todoId, "/reopen"), request);
}

/** Background tasks deliberately have no result payload: history is authoritative. */
export type TaskResponse = { readonly ok: true; readonly task: TaskSnapshot };
export type TasksResponse = { readonly ok: true; readonly tasks: readonly TaskSnapshot[] };

const REQUEST_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_FIELDS = ["id", "status", "revision", "createdAt", "updatedAt", "errorCode"];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("任务响应格式无效");
  }
  return value as Record<string, unknown>;
}

function parseTask(value: unknown): TaskSnapshot {
  const task = record(value);
  const { id, status, revision, createdAt, updatedAt, errorCode } = task;
  if (
    Object.keys(task).length !== TASK_FIELDS.length ||
    Object.keys(task).some((key) => !TASK_FIELDS.includes(key)) ||
    typeof id !== "string" ||
    !UUID.test(id) ||
    (status !== "queued" &&
      status !== "running" &&
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "cancelled") ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof createdAt !== "string" ||
    createdAt.length > 64 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    typeof updatedAt !== "string" ||
    updatedAt.length > 64 ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    (errorCode !== null && errorCode !== "execution_failed" && errorCode !== "interrupted")
  )
    throw new Error("任务响应格式无效");
  return { id, status, revision, createdAt, updatedAt, errorCode };
}

function parseTaskResponse(value: unknown, expectedId?: string): TaskResponse {
  const response = record(value);
  if (response["ok"] !== true) throw new Error("任务响应格式无效");
  const task = parseTask(response["task"]);
  if (expectedId !== undefined && task.id !== expectedId) throw new Error("任务 ID 不匹配");
  return { ok: true, task };
}

/** Only task traffic gets the short observation timeout; synchronous confirmation is unchanged. */
function taskRequest(url: string, options: RequestInit = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return jsonRequest<unknown>(url, { ...options, signal, cache: "no-store" });
}

function taskPost(url: string, payload: unknown): Promise<unknown> {
  return taskRequest(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(payload) });
}

function taskUrl(id: string): string {
  return `${ROUTES.tasks}/${encodeURIComponent(id)}`;
}

export function isTerminalTask(task: TaskSnapshot): boolean {
  return task.status === "succeeded" || task.status === "failed" || task.status === "cancelled";
}

export async function postTask(request: ChatRequest): Promise<TaskResponse> {
  return parseTaskResponse(await taskPost(ROUTES.tasks, request));
}

export async function fetchTask(id: string, signal?: AbortSignal): Promise<TaskResponse> {
  return parseTaskResponse(await taskRequest(taskUrl(id), signal ? { signal } : {}), id);
}

export async function fetchTasks(): Promise<TasksResponse> {
  const response = record(await taskRequest(ROUTES.tasks));
  const tasks = response["tasks"];
  if (response["ok"] !== true || !Array.isArray(tasks) || tasks.length > 40) {
    throw new Error("任务列表格式无效");
  }
  const parsed = tasks.map(parseTask);
  if (new Set(parsed.map((task) => task.id)).size !== parsed.length) {
    throw new Error("任务列表包含重复 ID");
  }
  return { ok: true, tasks: parsed };
}

export async function postTaskCancel(id: string): Promise<TaskResponse> {
  return parseTaskResponse(await taskPost(`${taskUrl(id)}/cancel`, {}), id);
}

export type TaskWatchOptions = {
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
  readonly streamIdleMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
};

/** One SSE connection, then bounded GET polling. Never retry a POST or cancel work on disconnect. */
export async function watchTask(
  initial: TaskSnapshot,
  onSnapshot: (task: TaskSnapshot) => void,
  options: TaskWatchOptions = {},
): Promise<TaskSnapshot> {
  let current = initial;
  if (isTerminalTask(current)) return current;
  const deadline = AbortSignal.timeout(options.budgetMs ?? 300_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const accept = (task: TaskSnapshot): void => {
    if (task.id !== current.id) throw new Error("任务 ID 不匹配");
    // Duplicates, stale events and late polling responses cannot regress the UI.
    if (task.revision <= current.revision || isTerminalTask(current)) return;
    current = task;
    onSnapshot(task);
  };
  try {
    await streamTask(
      initial.id,
      accept,
      () => isTerminalTask(current),
      signal,
      options.streamIdleMs ?? 35_000,
    );
  } catch {
    // A closed/invalid/stalled stream does NOT imply that background execution stopped.
  }
  if (isTerminalTask(current)) return current;
  for (let attempt = 0; attempt < (options.maxPolls ?? 60); attempt++) {
    signal.throwIfAborted();
    try {
      accept((await fetchTask(initial.id, signal)).task);
      if (isTerminalTask(current)) return current;
    } catch {
      signal.throwIfAborted();
    }
    if (attempt + 1 < (options.maxPolls ?? 60)) {
      await delay(options.pollIntervalMs ?? 3_000, signal);
    }
  }
  throw new Error("任务状态跟踪已暂停；后台任务可能仍在运行，请刷新任务状态。不要重复发送。");
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Bounded SSE framing handles split UTF-8, CR/LF and multi-line data fields. */
async function streamTask(
  id: string,
  accept: (task: TaskSnapshot) => void,
  terminal: () => boolean,
  signal: AbortSignal,
  idleMs: number,
): Promise<void> {
  const connection = new AbortController();
  const combined = AbortSignal.any([signal, connection.signal]);
  let timer = setTimeout(() => connection.abort(), idleMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${taskUrl(id)}/events`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
      signal: combined,
    });
    if (
      !response.ok ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !== "text/event-stream" ||
      !response.body
    ) {
      throw new Error("任务事件流不可用");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let event = "";
    let revision = "";
    let data: string[] = [];
    let eventSize = 0;
    let frames = 0;
    const line = (text: string): void => {
      if (text === "") {
        if (++frames > 1_000) throw new Error("任务事件数量超限");
        if (event === "task" && data.length) {
          const task = parseTask(JSON.parse(data.join("\n")));
          if (revision !== String(task.revision)) throw new Error("任务事件版本不匹配");
          accept(task);
        }
        event = "";
        revision = "";
        data = [];
        eventSize = 0;
        return;
      }
      eventSize += text.length;
      if (eventSize > 65_536) throw new Error("任务事件大小超限");
      const colon = text.indexOf(":");
      const field = colon < 0 ? text : text.slice(0, colon);
      const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "id") revision = value;
      else if (field === "data") data.push(value);
    };
    while (!terminal()) {
      const chunk = await reader.read();
      if (chunk.done) break;
      clearTimeout(timer);
      timer = setTimeout(() => connection.abort(), idleMs);
      buffer += decoder.decode(chunk.value, { stream: true });
      // A final CR waits for the next chunk so a split CRLF counts only once.
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
        if (terminal()) return;
      }
      if (buffer.length > 65_536) throw new Error("任务事件大小超限");
    }
  } finally {
    clearTimeout(timer);
    connection.abort();
    // This only closes observation, never the explicit task cancellation endpoint.
    try {
      await reader?.cancel();
    } catch {
      /* disconnected transport */
    }
    reader?.releaseLock();
  }
}

// Agent DTO imports erase at runtime; the browser never loads Zod or Node modules.
import type {
  AgentBackend,
  AgentProposal,
  AgentTask,
  AgentWorkspace,
} from "../../src/domain/agent.ts";
const AGENT = "/api/agent";
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function isNullableId(value: unknown): value is string | null {
  return value === null || isUuid(value);
}
function isDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function parseAgentTask(value: unknown): AgentTask {
  const {
    id,
    sessionId,
    workspaceId,
    backend,
    instruction,
    pendingActionId,
    queueId,
    status,
    output,
    failureCode,
    createdAt,
    updatedAt,
  } = record(value);
  if (
    !isUuid(id) ||
    !isUuid(sessionId) ||
    !isNullableId(workspaceId) ||
    !isUuid(pendingActionId) ||
    !isNullableId(queueId) ||
    (backend !== "codex" && backend !== "claude") ||
    (status !== "pending" &&
      status !== "queued" &&
      status !== "running" &&
      status !== "succeeded" &&
      status !== "failed" &&
      status !== "cancelled" &&
      status !== "rejected") ||
    typeof instruction !== "string" ||
    instruction.length > 12000 ||
    typeof output !== "string" ||
    new TextEncoder().encode(output).length > 65536 ||
    (failureCode !== null && (typeof failureCode !== "string" || failureCode.length > 100)) ||
    !isDate(createdAt) ||
    !isDate(updatedAt)
  )
    throw new Error("Agent 响应格式无效");
  return {
    id,
    sessionId,
    workspaceId,
    backend,
    instruction,
    pendingActionId,
    queueId,
    status,
    output,
    failureCode,
    createdAt,
    updatedAt,
  };
}
function parseAgentWorkspace(value: unknown): AgentWorkspace {
  const { id, path, baseCommit, gitStatus, createdAt } = record(value);
  if (
    !isUuid(id) ||
    typeof path !== "string" ||
    path.length > 4096 ||
    typeof baseCommit !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(baseCommit) ||
    typeof gitStatus !== "string" ||
    gitStatus.length > 65536 ||
    !isDate(createdAt)
  )
    throw new Error("工作区响应无效");
  return { id, path, baseCommit, gitStatus, createdAt };
}
export async function fetchAgentCapabilities(): Promise<{ backends: AgentBackend[] }> {
  const item = record(await taskRequest(`${AGENT}/capabilities`));
  if (
    item["ok"] !== true ||
    item["permission"] !== "read_only" ||
    !Array.isArray(item["backends"]) ||
    item["backends"].length > 2 ||
    item["backends"].some((v) => v !== "claude" && v !== "codex")
  )
    throw new Error("Agent 能力响应无效");
  const backends: AgentBackend[] = item["backends"].map((name: unknown) => {
    if (name !== "codex" && name !== "claude") throw new Error("Agent 能力响应无效");
    return name;
  });
  return { backends };
}
export function fetchAgentWorkspaces(): Promise<{ workspaces: AgentWorkspace[] }> {
  return taskRequest(`${AGENT}/workspaces`).then((raw) => {
    const item = record(raw);
    const values = item["workspaces"];
    if (item["ok"] !== true || !Array.isArray(values) || values.length > 100)
      throw new Error("工作区响应无效");
    return { workspaces: values.map(parseAgentWorkspace) };
  });
}
export async function fetchAgentTasks(): Promise<{ tasks: AgentTask[] }> {
  const item = record(await taskRequest(`${AGENT}/tasks`));
  const values = item["tasks"];
  if (item["ok"] !== true || !Array.isArray(values) || values.length > 100)
    throw new Error("Agent 列表格式无效");
  const tasks = values.map(parseAgentTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length)
    throw new Error("Agent 列表包含重复 ID");
  return { tasks };
}
export async function registerAgentWorkspace(input: {
  path: string;
  bucketId?: string;
}): Promise<{ workspace: AgentWorkspace }> {
  const raw = record(await taskPost(`${AGENT}/workspaces`, input));
  if (raw["ok"] !== true) throw new Error("工作区响应无效");
  return { workspace: parseAgentWorkspace(raw["workspace"]) };
}
export async function postAgentProposal(input: AgentProposal): Promise<{ task: AgentTask }> {
  const raw = record(await taskPost(`${AGENT}/tasks`, input));
  if (raw["ok"] !== true) throw new Error("Agent 响应格式无效");
  return { task: parseAgentTask(raw["task"]) };
}
export async function postAgentAction(
  task: Pick<AgentTask, "id" | "instruction">,
  action: "approve" | "reject" | "cancel",
): Promise<{ task: AgentTask }> {
  const payload =
    action === "cancel"
      ? {}
      : {
          instruction: task.instruction,
          ...(action === "approve" ? { confirmation_granted: true } : {}),
        };
  const raw = record(
    await taskPost(`${AGENT}/tasks/${encodeURIComponent(task.id)}/${action}`, payload),
  );
  if (raw["ok"] !== true) throw new Error("Agent 响应格式无效");
  const result = parseAgentTask(raw["task"]);
  if (result.id !== task.id) throw new Error("Agent ID 不匹配");
  return { task: result };
}
