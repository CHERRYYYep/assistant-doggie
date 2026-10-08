import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { TaskSnapshot } from "../../src/domain/task.ts";
import { fetchTask, fetchTasks, postTask, postTaskCancel, watchTask } from "../assets/api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "queued",
    revision: 1,
    createdAt: "2026-10-08T00:00:00Z",
    updatedAt: "2026-10-08T00:00:00Z",
    errorCode: null,
    ...overrides,
  };
}

function event(task: TaskSnapshot): string {
  return `event: task\r\nid: ${task.revision}\r\ndata: ${JSON.stringify(task)}\r\n\r\n`;
}
function sse(text: string, split = false): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
  );
}
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status });

// Short, finite observation windows; no real network or timers lasting minutes.
const fast = { pollIntervalMs: 0, maxPolls: 3, budgetMs: 1_000, streamIdleMs: 100 };

test("task APIs use the new contract, encode IDs, and cancel with JSON {}", async () => {
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(String(input), "http://localhost"), init);
    requests.push(request);
    return request.url.endsWith("/tasks") && request.method === "GET"
      ? json({ ok: true, tasks: [snapshot()] })
      : json({ ok: true, task: snapshot() }, request.method === "POST" ? 202 : 200);
  };
  assert.deepEqual((await postTask({ message: "事实" })).task, snapshot());
  await fetchTask(snapshot().id);
  await postTaskCancel(snapshot().id);
  await fetchTasks();
  assert.equal(requests[0]?.url, "http://localhost/api/tasks");
  assert.deepEqual(await requests[0]?.json(), { message: "事实" });
  assert.equal(requests[1]?.url, "http://localhost/api/tasks/00000000-0000-4000-8000-000000000001");
  assert.equal(
    requests[2]?.url,
    "http://localhost/api/tasks/00000000-0000-4000-8000-000000000001/cancel",
  );
  assert.equal(requests[2]?.headers.get("content-type"), "application/json");
  assert.deepEqual(await requests[2]?.json(), {});
  assert.equal(requests[3]?.method, "GET");
});

test("task payload validation rejects invalid snapshots, IDs, oversized and duplicate lists", async () => {
  for (const invalid of [
    { ...snapshot(), revision: -1 },
    { ...snapshot(), revision: 0 },
    { ...snapshot(), id: "not-a-uuid" },
    { ...snapshot(), revision: 1.1 },
    { ...snapshot(), status: "done" },
    { ...snapshot(), errorCode: "secret" },
    { ...snapshot(), createdAt: "invalid" },
    { ...snapshot(), result: "not allowed" },
    { ...snapshot(), id: "" },
  ]) {
    globalThis.fetch = async () => json({ ok: true, task: invalid });
    await assert.rejects(postTask({ message: "事实" }), /格式无效/);
  }
  globalThis.fetch = async () =>
    json({ ok: true, task: snapshot({ id: "00000000-0000-4000-8000-000000000002" }) });
  await assert.rejects(fetchTask("expected"), /ID 不匹配/);
  for (const tasks of [Array.from({ length: 41 }, () => snapshot()), [snapshot(), snapshot()]]) {
    globalThis.fetch = async () => json({ ok: true, tasks });
    await assert.rejects(fetchTasks());
  }
});

test("split UTF-8/CRLF SSE tracks only increasing revisions and closes on terminal", async () => {
  let calls = 0;
  const updates: TaskSnapshot[] = [];
  globalThis.fetch = async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    return sse(
      ": heartbeat\r\n\r\n" +
        event(snapshot()) +
        event(snapshot({ status: "running", revision: 2 })) +
        event(snapshot()) +
        event(snapshot({ status: "succeeded", revision: 3 })) +
        event(snapshot({ status: "running", revision: 4 })),
      true,
    );
  };
  const final = await watchTask(snapshot(), (task) => updates.push(task), fast);
  assert.equal(final.status, "succeeded");
  assert.deepEqual(
    updates.map((task) => task.revision),
    [2, 3],
  );
  assert.equal(calls, 1);
});

test("disconnect polls the existing task without resubmission or cancellation", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    if (String(input).endsWith("/events"))
      return sse(event(snapshot({ status: "running", revision: 2 })));
    return json({ ok: true, task: snapshot({ status: "succeeded", revision: 3 }) });
  };
  const updates: TaskSnapshot[] = [];
  const task = await watchTask(snapshot(), (value) => updates.push(value), fast);
  assert.equal(task.status, "succeeded");
  assert.equal(urls.length, 2);
  assert.ok(urls[1]?.endsWith("00000000-0000-4000-8000-000000000001"));
});

test("malformed/wrong-ID/oversized events fall back to bounded polling", async () => {
  for (const stream of [
    "event: task\nid: 2\ndata: {bad}\n\n",
    event(snapshot({ id: "foreign", revision: 2 })),
    "event: task\nid: 99\ndata: " + JSON.stringify(snapshot()) + "\n\n",
    "data: " + "x".repeat(65_537),
  ]) {
    let gets = 0;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/events")
        ? sse(stream)
        : (gets++, json({ ok: true, task: snapshot({ status: "cancelled", revision: 2 }) }));
    assert.equal((await watchTask(snapshot(), () => {}, fast)).status, "cancelled");
    assert.equal(gets, 1);
  }
});

test("poll count is finite on persistent failures or still-running tasks", async () => {
  for (const response of [
    json({ ok: false, error: "offline" }, 503),
    json({ ok: true, task: snapshot() }),
  ]) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response.clone();
    };
    await assert.rejects(
      watchTask(snapshot(), () => {}, fast),
      /跟踪已暂停/,
    );
    assert.equal(calls, 4); // one stream attempt, three polls
  }
});

test("observation abort and time budget stop polling, never call cancel", async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls++;
    assert.ok(!String(input).endsWith("/cancel"));
    controller.abort();
    throw new Error("disconnected");
  };
  await assert.rejects(watchTask(snapshot(), () => {}, { ...fast, signal: controller.signal }));
  assert.equal(calls, 1);
  globalThis.fetch = async () => json({ ok: true, task: snapshot() });
  await assert.rejects(
    watchTask(snapshot(), () => {}, { ...fast, budgetMs: 10, pollIntervalMs: 100 }),
  );
});

test("idle SSE falls back to polling and releases its reader", async () => {
  let closed = false;
  globalThis.fetch = async (input, init) => {
    if (!String(input).endsWith("/events"))
      return json({
        ok: true,
        task: snapshot({ status: "failed", revision: 2, errorCode: "execution_failed" }),
      });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            "abort",
            () => {
              closed = true;
              controller.error(new Error("idle"));
            },
            { once: true },
          );
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const task = await watchTask(snapshot(), () => {}, { ...fast, streamIdleMs: 10 });
  assert.equal(task.status, "failed");
  assert.equal(closed, true);
});

test("terminal initial snapshots do not open an observation connection", async () => {
  globalThis.fetch = async () => {
    throw new Error("must not request");
  };
  assert.equal((await watchTask(snapshot({ status: "cancelled" }), () => {})).status, "cancelled");
});

test("poll recovery does not regress revisions and retries only GET on temporary failures", async () => {
  let polls = 0;
  const revisions: number[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    if (String(input).endsWith("/events"))
      return sse(event(snapshot({ status: "running", revision: 3 })));
    polls++;
    if (polls === 1) throw new Error("temporary offline");
    return json({
      ok: true,
      task: snapshot(polls === 2 ? { revision: 2 } : { status: "succeeded", revision: 4 }),
    });
  };
  const final = await watchTask(snapshot(), (task) => revisions.push(task.revision), fast);
  assert.equal(final.status, "succeeded");
  assert.deepEqual(revisions, [3, 4]);
  assert.equal(polls, 3);
});

test("multi-line SSE data fields decode as one task event", async () => {
  const task = snapshot({ status: "succeeded", revision: 2 });
  const lines = JSON.stringify(task, null, 2)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  globalThis.fetch = async () => sse(`event: task\nid: 2\n${lines}\n\n`);
  assert.deepEqual(await watchTask(snapshot(), () => {}, fast), task);
});

test("task path parameters are encoded even when the returned ID is rejected", async () => {
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return json({ ok: true, task: snapshot() });
  };
  await assert.rejects(fetchTask("task/一"), /ID 不匹配/);
  await assert.rejects(postTaskCancel("task/一"), /ID 不匹配/);
  assert.deepEqual(urls, ["/api/tasks/task%2F%E4%B8%80", "/api/tasks/task%2F%E4%B8%80/cancel"]);
});
