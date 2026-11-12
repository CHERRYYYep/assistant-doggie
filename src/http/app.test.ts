import { httpApiFixture } from "./test-fixtures.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DoggieHttpApi } from "./app.ts";
import { createDoggieApp, loadFrontendAssets } from "./app.ts";
import { HttpBoundaryError } from "./contracts.ts";

function localRequest(
  app: ReturnType<typeof createDoggieApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", "127.0.0.1:8787");
  const url = path.startsWith("http") ? path : `http://127.0.0.1:8787${path}`;
  return Promise.resolve(app.request(url, { ...init, headers }));
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("Hono serves the existing module frontend and supports HEAD correctly", async () => {
  const app = createDoggieApp(httpApiFixture([]), [
    {
      path: "/",
      contentType: "text/html; charset=utf-8",
      body: "<main>Doggie</main>",
    },
    {
      path: "/assets/app.ts",
      contentType: "text/javascript; charset=utf-8",
      body: "export const doggie = true;",
    },
  ]);

  const index = await localRequest(app, "http://127.0.0.1:8787/");
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await index.text(), "<main>Doggie</main>");

  const head = await localRequest(app, "http://127.0.0.1:8787/assets/app.ts", {
    method: "HEAD",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("frontend TypeScript assets are stripped into browser JavaScript", () => {
  const scripts = loadFrontendAssets().filter(({ path }) =>
    path.endsWith(".ts"),
  );

  assert.equal(scripts.length, 14);
  assert.ok(scripts.some((script) => script.path === "/assets/workspace.ts"));
  assert.ok(scripts.some((script) => script.path === "/assets/agents.ts"));
  for (const script of scripts) {
    assert.equal(script.contentType, "text/javascript; charset=utf-8");
    assert.doesNotMatch(script.body, /\b(?:import|export)\s+type\b/u);
    assert.doesNotMatch(script.body, /\bsatisfies\s+[A-Za-z_$]/u);
    assert.match(script.body, /\S/u);
  }
});

test("Hono routes decoded query, path and strict JSON DTOs to the API", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(httpApiFixture(calls), []);

  const query = await localRequest(
    app,
    "http://127.0.0.1:8787/api/memory/query?q=%E6%8E%A5%E5%8F%A3%20A&limit=10",
  );
  assert.equal(query.status, 200);
  const queryBody = await body(query);
  assert.equal(queryBody["query"], "接口 A");
  assert.deepEqual(queryBody["query_plan"], {
    raw_text: "接口 A",
    terms: [],
    entity_terms: [],
    topic_terms: [],
    bucket_terms: [],
    time_range: null,
    statuses: [],
    structured_filters: [],
    limit: 10,
  });

  const detail = await localRequest(
    app,
    "http://127.0.0.1:8787/api/buckets/%E6%A1%B6-1",
  );
  assert.equal(detail.status, 200);
  const detailBody = await body(detail);
  assert.equal(
    Reflect.get(
      Reflect.get(detailBody["detail"] as object, "bucket") as object,
      "id",
    ),
    "桶-1",
  );

  const chat = await localRequest(app, "http://127.0.0.1:8787/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: " 事实 " }),
  });
  assert.equal(chat.status, 200);
  const chatBody = await body(chat);
  assert.equal(
    Reflect.get(chatBody["user_message"] as object, "content"),
    "事实",
  );
  assert.deepEqual(calls, [
    'query:{"query":"接口 A","limit":10}',
    'detail:"桶-1"',
    'chat:{"message":"事实"}',
  ]);
});

test("all declared write routes dispatch and DELETE remains bodyless", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(httpApiFixture(calls), []);
  const post = (path: string, value: unknown) =>
    localRequest(app, `http://127.0.0.1:8787${path}`, {
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
    localRequest(app, "http://127.0.0.1:8787/api/buckets/b1", {
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
    ...httpApiFixture([]),
    activeBuckets: () => {
      throw new HttpBoundaryError(409, "fixture conflict");
    },
  };
  const app = createDoggieApp(api, []);

  const malformed = await localRequest(app, "http://127.0.0.1:8787/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await body(malformed), {
    ok: false,
    error: "request body must be valid JSON",
  });

  const conflict = await localRequest(
    app,
    "http://127.0.0.1:8787/api/buckets/active",
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await body(conflict), {
    ok: false,
    error: "fixture conflict",
  });

  const missing = await localRequest(app, "http://127.0.0.1:8787/not-found");
  assert.equal(missing.status, 404);
  assert.deepEqual(await body(missing), {
    ok: false,
    error: "route not found",
  });
});

test("internal invalid success data produces a sanitized 500 instead of a request error", async () => {
  const app = createDoggieApp(
    {
      ...httpApiFixture(),
      activeBuckets: () => ({
        ok: true,
        buckets: [],
        private_detail: "must not leak",
      }),
    },
    [],
  );
  const response = await localRequest(app, "/api/buckets/active");
  assert.equal(response.status, 500);
  assert.deepEqual(await body(response), {
    ok: false,
    error: "internal response contract violation",
  });
});

test("strict query and path contracts reject ambiguous inputs before dispatch", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(httpApiFixture(calls), []);
  for (const path of [
    "/api/buckets/active?unknown=true",
    "/api/buckets/active?limit=1&limit=2",
    "/api/memory/query?q=first&q=second",
    "/api/buckets/%20",
    "/api/buckets/%FF",
  ]) {
    const response = await localRequest(app, path);
    assert.equal(response.status, 400, path);
    assert.equal((await body(response))["ok"], false, path);
  }
  assert.deepEqual(calls, []);
});

test("DELETE contracts reject JSON bodies before any mutation", async () => {
  const calls: string[] = [];
  const app = createDoggieApp(httpApiFixture(calls), []);
  for (const path of ["/api/buckets/b1", "/api/entries/e1"]) {
    const response = await localRequest(app, path, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await body(response), {
      ok: false,
      error: "delete does not accept a body",
    });
  }
  assert.deepEqual(calls, []);
});
