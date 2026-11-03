import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { after, afterEach, test } from "node:test";
import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { ChatMessageDto } from "../../src/http/dto.ts";
import { installDom, StubElement } from "./dom-harness.ts";

const dom = installDom();
const { state } = await import("../assets/state.ts");
const views = await import("../assets/views.ts");
const { renderTranscript } = await import("../assets/render-chat.ts");
const originalFetch = globalThis.fetch;
after(() => dom.restore());
afterEach(async () => {
  for (const controller of state.taskObservers.values()) controller.abort();
  await setImmediate();
  state.tasks.clear();
  state.taskObservers.clear();
  state.pausedTasks.clear();
  state.cancellingTasks.clear();
  state.history = [];
  state.activeBuckets = [];
  state.selectedBucketId = null;
  state.revokingEntries.clear();
  renderTranscript([]);
  element("chat-send").disabled = false;
  element("chat-input").value = "";
  globalThis.fetch = originalFetch;
});

test("Entry revocation requires explicit confirmation, coalesces clicks and clears stale query results", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  const button = new StubElement();
  button.dataset["entryId"] = "entry-1";
  let deletes = 0;
  let release: (value: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const calls = mockServer();
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/entries/entry-1") {
      deletes++;
      return pending;
    }
    return fallback(input, init);
  };
  try {
    Object.defineProperty(globalThis, "confirm", { value: () => false, configurable: true });
    await views.revokeEntry(button as unknown as HTMLButtonElement);
    assert.equal(deletes, 0);
    Object.defineProperty(globalThis, "confirm", { value: () => true, configurable: true });
    const revoking = views.revokeEntry(button as unknown as HTMLButtonElement);
    assert.equal(button.disabled, true);
    await views.revokeEntry(button as unknown as HTMLButtonElement);
    assert.equal(deletes, 1);
    release(
      json({
        ok: true,
        entry_id: "entry-1",
        bucket_id: "bucket-1",
        correction_id: "correction-1",
        revoked_at: "2026-11-03T00:00:00.000Z",
        memory_item_ids: [],
      }),
    );
    await revoking;
    assert.equal(button.disabled, false);
    assert.match(element("memory-query-result").textContent ?? "", /重新查询/);
    assert.match(element("chat-status").textContent ?? "", /已撤销/);
    assert.ok(calls.some((call) => call.includes("/api/chat/history")));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "confirm", descriptor);
    else Reflect.deleteProperty(globalThis, "confirm");
  }
});

test("failed Entry revocation leaves existing query visible and permits an explicit retry", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "confirm");
  Object.defineProperty(globalThis, "confirm", { value: () => true, configurable: true });
  const button = new StubElement();
  button.dataset["entryId"] = "entry-1";
  element("memory-query-result").textContent = "原查询";
  globalThis.fetch = async () => json({ ok: false, error: "storage failed" }, 500);
  try {
    await assert.rejects(
      views.revokeEntry(button as unknown as HTMLButtonElement),
      /storage failed/,
    );
    assert.equal(button.disabled, false);
    assert.equal(state.revokingEntries.size, 0);
    assert.equal(element("memory-query-result").textContent, "原查询");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "confirm", descriptor);
    else Reflect.deleteProperty(globalThis, "confirm");
  }
});

test("Bucket detail ignores an older response when the user selects another Bucket", async () => {
  let release: (value: Response) => void = () => {};
  const old = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const bucket = (id: string) => ({
    id,
    title: id,
    type: "task",
    status: "active",
    summary: "",
    tags: [],
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
    last_active_at: "2026-11-03T00:00:00Z",
    archived_at: null,
  });
  globalThis.fetch = async (input) =>
    String(input).endsWith("/old")
      ? old
      : json({ ok: true, detail: { bucket: bucket("new"), entries: [], memories: [] } });
  const loading = views.showBucket("old");
  await views.showBucket("new");
  release(json({ ok: true, detail: { bucket: bucket("old"), entries: [], memories: [] } }));
  await loading;
  assert.match(element("detail").innerHTML, /new/);
  assert.doesNotMatch(element("detail").innerHTML, /old/);
});

test("revoked archive cards have no move/revoke controls and explain retained history", async () => {
  const { renderArchiveCard } = await import("../assets/render-archive.ts");
  const html = renderArchiveCard(
    {
      ok: true,
      attempt_id: "attempt",
      archive_state: "revoked",
      bucket_id: "bucket",
      entry_id: "entry",
      memory_item_ids: [],
      action: "create_new",
      confidence: 1,
      reason: "",
      question: null,
      candidate_bucket_ids: [],
      recommended_bucket_id: null,
      recommended_bucket: null,
      candidate_buckets: [],
      bucket_title: "task",
      bucket_type: "task",
      bucket: null,
      extraction: null,
      source_attempt_id: null,
    },
    "original",
  );
  assert.match(html, /已撤销/);
  assert.match(html, /聊天与审计保留/);
  assert.doesNotMatch(html, /data-action="(?:move-entry|revoke-entry)"/);
});
function element(id: string): StubElement {
  const node = dom.elements.get(id);
  assert.ok(node);
  return node;
}
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
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function openStream(signal: AbortSignal | null | undefined): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("closed")), {
          once: true,
        });
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const message = (id: string, content = "事实"): ChatMessageDto => ({
  id,
  role: "user",
  content,
  details: {},
  sequence: 1,
  tool_name: null,
  tool_call_id: null,
  created_at: "2026-10-08T00:00:00Z",
});

function mockServer(tasks: readonly TaskSnapshot[] = []): string[] {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/events")) return openStream(init?.signal);
    if (url.endsWith("/cancel"))
      return json({ ok: true, task: snapshot({ status: "cancelled", revision: 3 }) });
    if (url === "/api/tasks")
      return method === "POST"
        ? json({ ok: true, task: snapshot() }, 202)
        : json({ ok: true, tasks });
    if (url.startsWith("/api/chat/history"))
      return json({ ok: true, messages: [message("server-message")] });
    if (url.startsWith("/api/buckets/active")) return json({ ok: true, buckets: [] });
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  return calls;
}

test("sending submits once, displays queued status, then explicit cancel refreshes authoritative history and buckets", async () => {
  const calls = mockServer();
  element("chat-input").value = "一条具体事实";
  const sending = views.sendMessage();
  assert.equal(element("chat-send").disabled, true);
  await views.sendMessage();
  await sending;
  assert.equal(element("chat-send").disabled, false);
  assert.ok(element("task-list").innerHTML.includes("排队中"));
  assert.ok(element("task-list").innerHTML.includes("取消任务"));
  assert.equal(state.history[0]?.content, "一条具体事实");
  await views.cancelTask("00000000-0000-4000-8000-000000000001");
  await setImmediate();
  assert.ok(element("task-list").innerHTML.includes("已取消"));
  assert.ok(!element("task-list").innerHTML.includes("取消任务"));
  assert.equal(state.history[0]?.id, "server-message");
  assert.equal(calls.filter((call) => call === "POST /api/tasks").length, 1);
  assert.equal(calls.filter((call) => call.endsWith("/cancel")).length, 1);
  assert.ok(calls.some((call) => call.includes("/api/buckets/active")));
  assert.ok(!calls.includes("POST /api/chat"));
});

test("reload resumes recent active tasks without POST and ignores stale recovery snapshots", async () => {
  const calls = mockServer([snapshot({ status: "running", revision: 2 })]);
  await views.resumeTasks();
  await views.resumeTasks();
  assert.ok(element("task-list").innerHTML.includes("运行中"));
  assert.equal(calls.filter((call) => call.endsWith("/events")).length, 1);
  assert.ok(calls.every((call) => call.startsWith("GET")));
  await views.cancelTask("00000000-0000-4000-8000-000000000001");
  await setImmediate();
  await views.resumeTasks();
  assert.equal(state.tasks.get("00000000-0000-4000-8000-000000000001")?.status, "cancelled");
  assert.ok(!state.taskObservers.has("00000000-0000-4000-8000-000000000001"));
});

test("SSE success/failed terminal refreshes history and buckets without reading a result on the snapshot", async () => {
  for (const status of ["succeeded", "failed"] as const) {
    state.tasks.clear();
    const calls = mockServer([snapshot()]);
    const fallback = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith("/events")) return fallback(input, init);
      const task = snapshot({
        status,
        revision: 2,
        errorCode: status === "failed" ? "execution_failed" : null,
      });
      return new Response(`event: task\nid: 2\ndata: ${JSON.stringify(task)}\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    await views.resumeTasks();
    await setImmediate();
    assert.equal(state.tasks.get("00000000-0000-4000-8000-000000000001")?.status, status);
    assert.ok(calls.some((call) => call.includes("/api/chat/history")));
    assert.ok(calls.some((call) => call.includes("/api/buckets/active")));
    assert.equal(state.history[0]?.id, "server-message");
  }
});

test("uncertain submit does not retry POST and explains recovery instead of inviting duplicate sends", async () => {
  const calls = mockServer([snapshot({ status: "running", revision: 2 })]);
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/tasks" && init?.method === "POST") {
      calls.push("POST /api/tasks");
      throw new Error("network lost after acceptance");
    }
    return fallback(input, init);
  };
  element("chat-input").value = "事实";
  await views.sendMessage();
  assert.equal(calls.filter((call) => call === "POST /api/tasks").length, 1);
  assert.equal(state.tasks.get("00000000-0000-4000-8000-000000000001")?.status, "running");
  assert.ok(element("chat-status").textContent?.includes("不要重复发送"));
});

test("cancel failure leaves task active and duplicate clicks send only one cancellation", async () => {
  mockServer([snapshot()]);
  await views.resumeTasks();
  let resolve: (response: Response) => void = () => {
    throw new Error("not initialized");
  };
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  const fallback = globalThis.fetch;
  let cancels = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/cancel")) {
      cancels++;
      return response;
    }
    return fallback(input, init);
  };
  const cancelling = views.cancelTask("00000000-0000-4000-8000-000000000001");
  await views.cancelTask("00000000-0000-4000-8000-000000000001");
  assert.ok(element("task-list").innerHTML.includes("取消请求中"));
  resolve(json({ ok: false, error: "unavailable" }, 503));
  await cancelling;
  assert.equal(cancels, 1);
  assert.equal(state.tasks.get("00000000-0000-4000-8000-000000000001")?.status, "queued");
  assert.ok(element("chat-status").textContent?.includes("取消结果未确认"));
  assert.ok(element("task-list").innerHTML.includes("取消任务"));
});

test("task rendering escapes IDs and shows paused tracking/interrupted failure", () => {
  state.tasks.set(
    "hostile",
    snapshot({ id: '\"><img src=x onerror=alert(1)>', status: "running" }),
  );
  state.pausedTasks.add('\"><img src=x onerror=alert(1)>');
  state.tasks.set(
    "interrupted",
    snapshot({ id: "interrupted", status: "failed", errorCode: "interrupted" }),
  );
  views.renderTasks();
  const html = element("task-list").innerHTML;
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("跟踪已暂停"));
  assert.ok(html.includes("服务中断"));
});

test("keyed transcript reuses unchanged rows, preserves form state, updates changed cards and handles deletion/reordering", () => {
  const root = element("chat-messages");
  renderTranscript([message("a"), message("b")]);
  const a = root.nodes[0];
  const b = root.nodes[1];
  assert.ok(a);
  assert.ok(b);
  a.value = "unsaved confirmation title";
  const writes = a.writes;
  renderTranscript([message("a"), message("b"), message("c")]);
  assert.equal(root.nodes[0], a);
  assert.equal(a.writes, writes);
  assert.equal(a.value, "unsaved confirmation title");
  renderTranscript([message("b", "updated"), message("a")]);
  assert.deepEqual(root.nodes, [b, a]);
  assert.ok(b.innerHTML.includes("updated"));
  assert.equal(a.writes, writes);
  renderTranscript([message("a")]);
  assert.deepEqual(root.nodes, [a]);
  renderTranscript([]);
  assert.equal(root.nodes.length, 0);
  assert.ok(root.innerHTML.includes("empty-chat"));
});

test("keyed transcript does not jump a reader scrolled up, and supports minimal stub DOM fallback", () => {
  const root = element("chat-messages");
  root.scrollHeight = 1_000;
  root.clientHeight = 100;
  root.scrollTop = 20;
  renderTranscript([message("a")]);
  assert.equal(root.scrollTop, 20);
  const createElement = document.createElement;
  // Deliberately emulate the legacy harness that only offers innerHTML.
  Reflect.set(document, "createElement", undefined);
  try {
    renderTranscript([message("a", "<script>alert(1)</script>")]);
    assert.ok(!root.innerHTML.includes("<script>"));
    assert.ok(root.innerHTML.includes("&lt;script&gt;"));
  } finally {
    Reflect.set(document, "createElement", createElement);
  }
});

test("existing synchronous confirmation still uses its original API", async () => {
  const calls = mockServer();
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/chat/confirm") {
      calls.push("POST /api/chat/confirm");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        confirmation_granted: true,
        attempt_id: "attempt-1",
        text: "exact source",
        action: "discard",
      });
      return json({
        ok: true,
        confirmation_action: "discard",
        archive: {
          ok: true,
          attempt_id: "attempt-1",
          archive_state: "discarded",
          bucket_id: null,
          entry_id: null,
          memory_item_ids: [],
          source_attempt_id: "attempt-1",
          result_attempt_id: null,
        },
        archive_state: "discarded",
        source_attempt_id: "attempt-1",
        result_attempt_id: null,
        user_message: message("user-confirm"),
        assistant_message: message("assistant-confirm"),
        messages: [],
      });
    }
    return fallback(input, init);
  };
  const card = new StubElement();
  card.dataset["sourceText"] = "exact source";
  card.dataset["attemptId"] = "attempt-1";
  const button = new StubElement();
  button.parent = card;
  button.dataset["confirmAction"] = "discard";
  // Controlled DOM test adapter, not external application input.
  await views.confirmArchive(button as unknown as HTMLButtonElement);
  assert.ok(calls.includes("POST /api/chat/confirm"));
  assert.ok(!calls.includes("POST /api/tasks"));
  assert.equal(button.disabled, false);
});

test("real entry point binds task controls and bootstraps recovery", async () => {
  const calls = mockServer();
  await import("../assets/app.ts");
  await setImmediate();
  assert.ok(calls.includes("GET /api/tasks"));
  assert.ok(element("task-list").listeners.has("click"));
  assert.ok(element("task-refresh").listeners.has("click"));
  element("task-refresh").trigger("click", {});
  await setImmediate();
  assert.equal(calls.filter((call) => call === "GET /api/tasks").length, 2);
});

test("recovery failure has no automatic retry; explicit refresh resumes observation without resubmitting", async () => {
  const calls = mockServer([snapshot()]);
  const fallback = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (input, init) => {
    if (fail && String(input) === "/api/tasks") {
      calls.push("GET /api/tasks");
      return json({ ok: false, error: "offline" }, 503);
    }
    return fallback(input, init);
  };
  await views.resumeTasks();
  await setImmediate();
  assert.equal(calls.length, 1);
  assert.ok(element("chat-status").textContent?.includes("不要重复发送"));
  assert.equal(element("task-refresh").disabled, false);
  fail = false;
  await views.resumeTasks();
  assert.equal(state.tasks.get("00000000-0000-4000-8000-000000000001")?.status, "queued");
  assert.equal(calls.filter((call) => call === "GET /api/tasks").length, 2);
  assert.ok(calls.every((call) => call.startsWith("GET")));
});

test("recovery coalesces concurrent refresh clicks and batches terminal history refresh", async () => {
  let resolve: (response: Response) => void = () => {
    throw new Error("not initialized");
  };
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  const calls = mockServer();
  const fallback = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/tasks") {
      calls.push("GET /api/tasks");
      return response;
    }
    return fallback(input, init);
  };
  const recovery = views.resumeTasks();
  await views.resumeTasks();
  assert.equal(element("task-refresh").disabled, true);
  resolve(
    json({
      ok: true,
      tasks: Array.from({ length: 40 }, (_, index) =>
        snapshot({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          status: "succeeded",
          revision: 2,
        }),
      ),
    }),
  );
  await recovery;
  assert.equal(state.tasks.size, 40);
  assert.equal(calls.filter((call) => call === "GET /api/tasks").length, 1);
  assert.equal(calls.filter((call) => call.includes("/api/chat/history")).length, 1);
  assert.equal(calls.filter((call) => call.includes("/api/buckets/active")).length, 1);
  assert.equal(element("task-refresh").disabled, false);
});

test("late history responses cannot overwrite a newer terminal refresh", async () => {
  let resolve: (response: Response) => void = () => {
    throw new Error("not initialized");
  };
  const older = new Promise<Response>((done) => {
    resolve = done;
  });
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? older : json({ ok: true, messages: [message("newer")] });
  const first = views.loadHistory();
  await views.loadHistory();
  resolve(json({ ok: true, messages: [message("older")] }));
  await first;
  assert.equal(state.history[0]?.id, "newer");
});

test("T13 browser proposals require distinct bound approval; model output and instructions stay escaped", async () => {
  const { refreshAgents, proposeAgent, actOnAgent, renderAgentTasks } =
    await import("../assets/agents.ts");
  const instruction = "<img src=x onerror=alert(1)> summarize";
  const task = {
    id: "00000000-0000-4000-8000-000000000011",
    sessionId: "00000000-0000-4000-8000-000000000012",
    workspaceId: null,
    backend: "codex" as const,
    instruction,
    pendingActionId: "00000000-0000-4000-8000-000000000013",
    queueId: null,
    status: "pending" as const,
    output: "<script>alert(1)</script>",
    failureCode: null,
    createdAt: "2026-11-03T00:00:00Z",
    updatedAt: "2026-11-03T00:00:00Z",
  };
  const requests: { path: string; body: unknown }[] = [];
  let proposed = false;
  let approved = false;
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : null;
    requests.push({ path, body });
    if (path.endsWith("/capabilities"))
      return json({ ok: true, backends: ["codex"], permission: "read_only" });
    if (path.endsWith("/workspaces")) return json({ ok: true, workspaces: [] });
    if (path.endsWith("/approve")) {
      approved = true;
      return json(
        {
          ok: true,
          task: { ...task, status: "succeeded" },
          queueTask: snapshot({ status: "succeeded", revision: 3 }),
        },
        202,
      );
    }
    if (options?.method === "POST") {
      proposed = true;
      return json({ ok: true, task }, 201);
    }
    return json({
      ok: true,
      tasks: proposed ? [{ ...task, status: approved ? "succeeded" : "pending" }] : [],
    });
  };
  element("agent-backend").value = "codex";
  element("agent-instruction").value = instruction;
  await refreshAgents();
  await proposeAgent();
  assert.equal(requests.filter((item) => item.path.endsWith("/approve")).length, 0);
  assert.match(element("agent-list").innerHTML, /批准只读执行/);
  assert.ok(!renderAgentTasks([task]).includes("<script>"));
  assert.ok(!renderAgentTasks([task]).includes("<img "));
  element("agent-instruction").value = "edited after proposal";
  await actOnAgent(task.id, "approve");
  assert.deepEqual(requests.find((item) => item.path.endsWith("/approve"))?.body, {
    instruction,
    confirmation_granted: true,
  });
  assert.match(element("agent-list").innerHTML, /succeeded/);
});

test("T13 agent refresh schedules a follow-up when requested during an in-flight snapshot", async () => {
  const { refreshAgents } = await import("../assets/agents.ts");
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let capabilities = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith("/capabilities")) {
      capabilities++;
      if (capabilities === 1) await blocked;
      return json({ ok: true, backends: [], permission: "read_only" });
    }
    if (path.endsWith("/workspaces")) return json({ ok: true, workspaces: [] });
    return json({ ok: true, tasks: [] });
  };
  const first = refreshAgents();
  const second = refreshAgents();
  release();
  await Promise.all([first, second]);
  assert.equal(capabilities, 2);
  assert.equal(element("agent-propose").disabled, true);
});
