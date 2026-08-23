/**
 * Every server route the UI depends on, in one file.
 *
 * Callers use the named endpoint functions rather than assembling URLs, so a
 * route rename is a single edit here and `tests/../ui_contract.rs` can check
 * the UI against the routes the server actually dispatches.
 */

export const ROUTES = {
  chat: "/api/chat",
  chatConfirm: "/api/chat/confirm",
  chatHistory: "/api/chat/history",
  activeBuckets: "/api/buckets/active",
  bucket: "/api/buckets/",
  memoryQuery: "/api/memory/query",
  correctionMove: "/api/corrections/move",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Fetch and decode JSON, turning any non-2xx into a thrown `Error`.
 *
 * The server always answers `{ok, error}` on failure, but a crash or a proxy
 * can still return non-JSON, so the raw body is used as the message then.
 */
export async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_) {
    data = { error: raw || `HTTP ${response.status}` };
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

/** POST a JSON body. The server requires this Content-Type on every write. */
function postJson(url, payload) {
  return jsonRequest(url, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function fetchActiveBuckets(limit = 100) {
  return jsonRequest(`${ROUTES.activeBuckets}?limit=${limit}`);
}

export function fetchBucketDetail(bucketId) {
  return jsonRequest(ROUTES.bucket + encodeURIComponent(bucketId));
}

export function fetchChatHistory(limit = 40) {
  return jsonRequest(`${ROUTES.chatHistory}?limit=${limit}`);
}

export function fetchMemoryQuery(query, limit = 20) {
  return jsonRequest(`${ROUTES.memoryQuery}?q=${encodeURIComponent(query)}&limit=${limit}`);
}

export function postChatMessage(message) {
  return postJson(ROUTES.chat, { message });
}

export function postChatConfirmation(payload) {
  return postJson(ROUTES.chatConfirm, payload);
}

export function postEntryMove(entryId, targetBucketId, commandText) {
  return postJson(ROUTES.correctionMove, {
    entry_id: entryId,
    target_bucket_id: targetBucketId,
    command_text: commandText,
  });
}

/** DELETE carries no body, so it needs no Content-Type. */
export function deleteBucketRequest(bucketId) {
  return jsonRequest(ROUTES.bucket + encodeURIComponent(bucketId), {
    method: "DELETE",
  });
}
