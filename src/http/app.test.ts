import assert from "node:assert/strict";
import { test } from "node:test";

import type { DoggieHttpApi } from "./app.ts";
import { createDoggieApp } from "./app.ts";
import { HttpBoundaryError } from "./contracts.ts";

function fakeApi(calls: string[]): DoggieHttpApi {
  const called = (name: string, value: unknown) => {
    calls.push(`${name}:${JSON.stringify(value)}`);
    return { ok: true, route: name, value };
  };
  return {
    activeBuckets: (limit) => called("active", limit),
    searchBuckets: (query, limit) => called("search", { query, limit }),
    chatHistory: (limit) => called("history", limit),
    memoryQuery: (query, limit) => called("query", { query, limit }),
    memoryQueryJson: (request) => called("queryJson", request),
    bucketDetail: (bucketId) => called("detail", bucketId),
    deleteBucket: (bucketId) => called("delete", bucketId),
    archive: (request) => called("archive", request),
    chat: (request) => called("chat", request),
    confirmChat: (request) => called("confirm", request),
    appendConfirmed: (request) => called("append", request),
    createConfirmed: (request) => called("create", request),
    moveEntry: (request) => called("move", request),
    setBucketStatus: (request) => called("status", request),
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("Hono serves the existing module frontend and supports HEAD correctly", async () => {
  const app = createDoggieApp(fakeApi([]), [
    {
      path: "/",
      contentType: "text/html; charset=utf-8",
      body: "<main>Doggie</main>",
    },
    {
      path: "/assets/app.js",
      contentType: "text/javascript; charset=utf-8",
      body: "export const doggie = true;",
    },
  ]);

  const index = await app.request("http://127.0.0.1:8787/");
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await index.text(), "<main>Doggie</main>");

  const head = await app.request("http://127.0.0.1:8787/assets/app.js", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("Hono routes decoded query, path and strict JSON DTOs to the API", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(fakeApi(calls), []);

  const query = await app.request(
    "http://127.0.0.1:8787/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A&limit=10",
  );
  assert.equal(query.status, 200);
  assert.deepEqual(await body(query), {
    ok: true,
    route: "query",
    value: { query: "接口 A", limit: 10 },
  });

  const detail = await app.request(
    "http://127.0.0.1:8787/api/buckets/%E6%A1%B6-1",
  );
  assert.equal(detail.status, 200);
  assert.deepEqual(await body(detail), {
    ok: true,
    route: "detail",
    value: "桶-1",
  });

  const chat = await app.request("http://127.0.0.1:8787/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: " 事实 " }),
  });
  assert.equal(chat.status, 200);
  assert.deepEqual(await body(chat), {
    ok: true,
    route: "chat",
    value: { message: "事实" },
  });
  assert.deepEqual(calls, [
    'query:{"query":"接口 A","limit":10}',
    'detail:"桶-1"',
    'chat:{"message":"事实"}',
  ]);
});

test("all declared write routes dispatch and DELETE remains bodyless", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(fakeApi(calls), []);
  const post = (path: string, value: unknown) =>
    app.request(`http://127.0.0.1:8787${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });

  const responses = await Promise.all([
    post("/api/archive", { text: "事实" }),
    post("/api/chat/confirm", {
      confirmation_granted: true,
      action: "discard",
      attempt_id: "a1",
      text: "事实",
    }),
    post("/api/corrections/move", {
      entry_id: "e1",
      target_bucket_id: "b2",
      command_text: "移到目标",
    }),
    post("/api/buckets/status", { bucket_id: "b1", status: "done" }),
    app.request("http://127.0.0.1:8787/api/buckets/b1", {
      method: "DELETE",
    }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200, 200],
  );
  assert.ok(calls.includes('delete:"b1"'));
});

test("malformed inputs and thrown handlers keep the stable JSON error shape", async () => {
  const api: DoggieHttpApi = {
    ...fakeApi([]),
    activeBuckets: () => {
      throw new HttpBoundaryError(409, "fixture conflict");
    },
  };
  const app = createDoggieApp(api, []);

  const malformed = await app.request("http://127.0.0.1:8787/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await body(malformed), {
    ok: false,
    error: "request body must be valid JSON",
  });

  const conflict = await app.request(
    "http://127.0.0.1:8787/api/buckets/active",
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await body(conflict), {
    ok: false,
    error: "fixture conflict",
  });

  const missing = await app.request("http://127.0.0.1:8787/not-found");
  assert.equal(missing.status, 404);
  assert.deepEqual(await body(missing), {
    ok: false,
    error: "route not found",
  });
});
