/** Every server route and JSON DTO the browser UI depends on. */

import type { TaskSnapshot } from "../../src/domain/task.ts";
import type {
  ChatConfirmationRequest,
  ChatRequest,
  MoveEntryRequest,
} from "../../src/http/contracts.ts";
import type {
  ActiveBucketsResponse,
  BucketDetailResponse,
  ChatConfirmationResponse,
  ChatHistoryResponse,
  ChatResponse,
  DeleteBucketResponse,
  ErrorResponse,
  MemoryQueryResponse,
  MoveEntryResponse,
} from "../../src/http/dto.ts";

export const ROUTES = {
  chat: "/api/chat",
  tasks: "/api/tasks",
  chatConfirm: "/api/chat/confirm",
  chatHistory: "/api/chat/history",
  activeBuckets: "/api/buckets/active",
  bucket: "/api/buckets/",
  memoryQuery: "/api/memory/query",
  correctionMove: "/api/corrections/move",
} as const;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Fetch JSON and turn every non-2xx response into a stable browser Error. */
export async function jsonRequest<TResponse>(
  url: string,
  options: RequestInit = {},
): Promise<TResponse> {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data: unknown = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {
      ok: false,
      error: raw || `HTTP ${response.status}`,
    } satisfies ErrorResponse;
  }
  if (!response.ok) {
    throw new Error(errorMessage(data) ?? `HTTP ${response.status}`);
  }
  return data as TResponse;
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
