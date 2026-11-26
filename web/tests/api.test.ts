import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  deleteBucketRequest,
  fetchBucketDetail,
  fetchMemoryQuery,
  jsonRequest,
  postChatConfirmation,
  postChatMessage,
  postEntryMove,
} from "../assets/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  body: unknown,
  options: { readonly status?: number; readonly raw?: string } = {},
): { readonly requests: Request[] } {
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost"), init);
    requests.push(request);
    return new Response(options.raw ?? JSON.stringify(body), {
      status: options.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { requests };
}

const bucket = {
  id: "bucket-1",
  title: "接口 A",
  type: "experiment",
  status: "active",
  summary: "摘要",
  tags: [],
  created_at: "2026-11-03T00:00:00.000Z",
  updated_at: "2026-11-03T00:00:00.000Z",
  last_active_at: "2026-11-03T00:00:00.000Z",
  archived_at: null,
};
const entry = {
  id: "entry-1",
  bucket_id: bucket.id,
  raw_text: "事实",
  summary: null,
  content_type: "text/plain",
  classification_confidence: 0.9,
  classification_reason: "匹配",
  created_at: bucket.created_at,
  moved_from_bucket_id: null,
  archive_state: "archived",
  archived_at: bucket.created_at,
};
const message = {
  id: "message-1",
  sequence: 1,
  role: "user",
  content: "事实",
  tool_name: null,
  tool_call_id: null,
  details: null,
  created_at: bucket.created_at,
};
const archive = {
  ok: true,
  attempt_id: "attempt-1",
  archive_state: "archived",
  bucket_id: bucket.id,
  entry_id: entry.id,
  memory_item_ids: [],
  action: "append_existing",
  confidence: 0.9,
  reason: "匹配",
  question: null,
  candidate_bucket_ids: [bucket.id],
  recommended_bucket_id: bucket.id,
  recommended_bucket: null,
  candidate_buckets: [],
  bucket_title: bucket.title,
  bucket_type: bucket.type,
  bucket,
  extraction: null,
  source_attempt_id: null,
};
const chat = {
  ok: true,
  archive,
  archive_state: archive.archive_state,
  user_message: message,
  tool_messages: [],
  assistant_message: { ...message, id: "message-2", sequence: 2, role: "assistant" },
  messages: [message],
  chat_error: null,
};
const query = {
  ok: true,
  query: "接口 A & B",
  query_plan: {
    raw_text: "接口 A & B",
    terms: [],
    entity_terms: [],
    topic_terms: [],
    bucket_terms: [],
    time_range: null,
    statuses: [],
    structured_filters: [],
    limit: 7,
  },
  total_entries: 0,
  total_buckets: 0,
  results: [],
  buckets: [],
  evidence: [],
  answer: "未找到",
};

test("GET helpers encode path and natural-language query parameters", async () => {
  const detailMock = mockFetch({ ok: true, detail: { bucket, entries: [entry], memories: [] } });
  await fetchBucketDetail("桶/1");
  assert.equal(detailMock.requests[0]?.url, "http://localhost/api/buckets/%E6%A1%B6%2F1");
  const queryMock = mockFetch(query);
  await fetchMemoryQuery("接口 A & B", 7);
  assert.equal(
    queryMock.requests[0]?.url,
    "http://localhost/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A%20%26%20B&limit=7",
  );
});

test("chat and move writes send the shared snake_case DTO as JSON", async () => {
  const chatMock = mockFetch(chat);
  await postChatMessage({ message: "事实" });
  assert.equal(chatMock.requests[0]?.method, "POST");
  assert.equal(chatMock.requests[0]?.headers.get("content-type"), "application/json");
  assert.deepEqual(await chatMock.requests[0]?.json(), { message: "事实" });
  const moveMock = mockFetch({
    ok: true,
    correction_id: "correction-1",
    source_bucket_id: bucket.id,
    target_bucket_id: "bucket-2",
    entry: { ...entry, bucket_id: "bucket-2" },
  });
  await postEntryMove({
    entry_id: "entry-1",
    target_bucket_id: "bucket-2",
    command_text: "用户修改 Bucket",
  });
  assert.deepEqual(await moveMock.requests[0]?.json(), {
    entry_id: "entry-1",
    target_bucket_id: "bucket-2",
    command_text: "用户修改 Bucket",
  });
});

test("confirmation preserves the discriminated request variant", async () => {
  const mock = mockFetch({
    ok: true,
    confirmation_action: "create",
    archive,
    archive_state: "archived",
    source_attempt_id: "attempt-1",
    result_attempt_id: "attempt-2",
    user_message: message,
    assistant_message: chat.assistant_message,
    messages: [message, chat.assistant_message],
  });
  await postChatConfirmation({
    confirmation_granted: true,
    action: "create",
    attempt_id: "attempt-1",
    text: "事实",
    title: "接口压测",
    bucket_type: "experiment",
  });
  assert.deepEqual(await mock.requests[0]?.json(), {
    confirmation_granted: true,
    action: "create",
    attempt_id: "attempt-1",
    text: "事实",
    title: "接口压测",
    bucket_type: "experiment",
  });
});

test("DELETE remains bodyless and does not add a JSON Content-Type", async () => {
  const mock = mockFetch({
    ok: true,
    bucket_id: bucket.id,
    deleted_entry_ids: [entry.id],
    deleted_memory_item_ids: [],
    updated_archive_attempt_ids: [],
    correction_id: "correction-1",
  });
  await deleteBucketRequest("bucket-1");
  assert.equal(mock.requests[0]?.method, "DELETE");
  assert.equal(mock.requests[0]?.headers.has("content-type"), false);
  assert.equal(await mock.requests[0]?.text(), "");
});

test("HTTP errors preserve only validated stable JSON messages", async () => {
  mockFetch({ ok: false, error: "fixture conflict" }, { status: 409 });
  await assert.rejects(jsonRequest("/api/failure"), /fixture conflict/);
  mockFetch({}, { status: 502, raw: "upstream unavailable" });
  await assert.rejects(jsonRequest("/api/failure"), /API 响应格式无效/);
  mockFetch({ ok: false, error: "failed", internal_stack: "secret" }, { status: 500 });
  await assert.rejects(jsonRequest("/api/failure"), /API 响应格式无效/);
});

test("successful JSON requires the complete route contract and envelope", async () => {
  for (const invalid of [
    {},
    { ok: false, error: "failure disguised as success" },
    { ok: true, service: "wrong" },
    { ok: true, service: "doggie-local-web", unexpected: true },
  ]) {
    mockFetch(invalid);
    await assert.rejects(jsonRequest("/health"), /API 响应格式无效/);
  }
  mockFetch({}, { raw: "" });
  await assert.rejects(jsonRequest("/health"), /API 响应格式无效/);
  mockFetch({ ok: true, service: "doggie-local-web" });
  assert.deepEqual(await jsonRequest("/health"), { ok: true, service: "doggie-local-web" });
  mockFetch({ ok: true });
  await assert.rejects(jsonRequest("/api/unknown"), /API 响应格式无效/);
  mockFetch({ ok: true, detail: {} });
  await assert.rejects(fetchBucketDetail("bucket-1"), /API 响应格式无效/);
});

test("JSON traffic rejects wrong media type, invalid UTF-8 and excessive response bytes", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, service: "doggie-local-web" }), {
      headers: { "Content-Type": "text/html" },
    });
  await assert.rejects(jsonRequest("/health"), /API 响应格式无效/);
  globalThis.fetch = async () =>
    new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(jsonRequest("/health"));
  globalThis.fetch = async () =>
    new Response(" ".repeat(8 * 1024 * 1024 + 1), {
      headers: { "Content-Type": "application/json" },
    });
  await assert.rejects(jsonRequest("/health"), /响应大小超限/);
});

test("T13 client rejects malformed agent/workspace identity and never retries an approval POST", async () => {
  const { fetchAgentTasks, registerAgentWorkspace, postAgentAction } =
    await import("../assets/api.ts");
  mockFetch({ ok: true, tasks: [{ id: "forged" }] });
  await assert.rejects(fetchAgentTasks(), /Agent/);
  mockFetch({ ok: true, workspace: { id: "forged", path: "/tmp/repo", baseCommit: "bad" } });
  await assert.rejects(registerAgentWorkspace({ path: "/tmp/repo" }), /工作区/);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("unknown POST outcome");
  };
  const task = { id: "00000000-0000-4000-8000-000000000021", instruction: "original instruction" };
  await assert.rejects(postAgentAction(task, "approve"), /unknown POST outcome/);
  assert.equal(requests, 1);
});
