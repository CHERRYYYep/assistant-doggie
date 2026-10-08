/** Every server route and JSON DTO the browser UI depends on. */

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
