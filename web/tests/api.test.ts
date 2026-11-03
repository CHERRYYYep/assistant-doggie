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

test("GET helpers encode path and natural-language query parameters", async () => {
  const mock = mockFetch({ ok: true, detail: {} });
  await fetchBucketDetail("桶/1");
  await fetchMemoryQuery("接口 A & B", 7);

  assert.equal(mock.requests[0]?.url, "http://localhost/api/buckets/%E6%A1%B6%2F1");
  assert.equal(
    mock.requests[1]?.url,
    "http://localhost/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A%20%26%20B&limit=7",
  );
});

test("chat and move writes send the shared snake_case DTO as JSON", async () => {
  const mock = mockFetch({ ok: true });
  await postChatMessage({ message: "事实" });
  await postEntryMove({
    entry_id: "entry-1",
    target_bucket_id: "bucket-2",
    command_text: "用户修改 Bucket",
  });

  assert.equal(mock.requests[0]?.method, "POST");
  assert.equal(mock.requests[0]?.headers.get("content-type"), "application/json");
  assert.deepEqual(await mock.requests[0]?.json(), { message: "事实" });
  assert.deepEqual(await mock.requests[1]?.json(), {
    entry_id: "entry-1",
    target_bucket_id: "bucket-2",
    command_text: "用户修改 Bucket",
  });
});

test("confirmation preserves the discriminated request variant", async () => {
  const mock = mockFetch({ ok: true });
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
  const mock = mockFetch({ ok: true });
  await deleteBucketRequest("bucket-1");

  assert.equal(mock.requests[0]?.method, "DELETE");
  assert.equal(mock.requests[0]?.headers.has("content-type"), false);
  assert.equal(await mock.requests[0]?.text(), "");
});

test("JSON and non-JSON HTTP failures become stable Error messages", async () => {
  mockFetch({ ok: false, error: "fixture conflict" }, { status: 409 });
  await assert.rejects(jsonRequest("/api/failure"), /fixture conflict/);

  mockFetch({}, { status: 502, raw: "upstream unavailable" });
  await assert.rejects(jsonRequest("/api/failure"), /upstream unavailable/);
});

test("successful empty responses still decode to an object", async () => {
  mockFetch({}, { raw: "" });
  assert.deepEqual(await jsonRequest<Record<string, never>>("/health"), {});
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
  // Only identity and bound instruction are needed to construct this failing request.
  await assert.rejects(postAgentAction(task, "approve"), /unknown POST outcome/);
  assert.equal(requests, 1);
});
