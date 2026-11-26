import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { after, afterEach, test } from "node:test";
import type { TaskSnapshot } from "../../src/domain/task.ts";
import type { ChatMessageDto, ClarificationCardDto } from "../../src/http/dto.ts";
import { installDom, StubElement } from "./dom-harness.ts";
import type { ConversationInteraction } from "../assets/state.ts";

const dom = installDom();
const { state } = await import("../assets/state.ts");
const views = await import("../assets/views.ts");
const { renderTranscript, renderClarification, renderMessage, showConversationMessage } =
  await import("../assets/render-chat.ts");
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
  state.preview = false;
  state.interactions = [];
  state.observedConversation = null;
  state.delegateOptions = null;
  state.retryTurn = null;
  views.clearClarificationReply();
  state.activeBuckets = [];
  state.agenda = [];
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
    if (url === "/api/conversation/interactions")
      return json({
        ok: true,
        interactions: [],
        snapshot: { throughSequence: 0, prompts: [] },
      });
    if (url.startsWith("/api/buckets/active")) return json({ ok: true, buckets: [] });
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  return calls;
}

test("Agenda renders escaped TODO text and refreshes after a status mutation", async () => {
  const todo = {
    id: "todo-1",
    bucket_id: "bucket-1",
    entry_id: "entry-1",
    kind: "todo",
    text: "<script>alert(1)</script>",
    status: "open",
    scheduled_at: null,
    due_at: null,
    todo_rule: null,
    todo_raw_time: null,
    todo_occurrence: 1,
    occurred_at: null,
    source: null,
    reason: null,
    created_at: "2026-11-03T00:00:00Z",
    updated_at: "2026-11-03T00:00:00Z",
  };
  let completed = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/agenda")) {
      return json({ ok: true, now: "2026-11-03T00:00:00Z", todos: completed ? [] : [todo] });
    }
    if (url === "/api/todos/todo-1/transition") {
      completed = true;
      return json({
        ok: true,
        todo: { ...todo, status: "done", updated_at: "2026-11-03T00:00:01Z" },
        correction_id: "c1",
      });
    }
    throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
  };
  await views.refreshAgenda();
  assert.match(element("agenda").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(element("agenda").innerHTML, /<script>alert/);
  assert.match(element("agenda").innerHTML, /data-action="show-todo-source"/);
  const button = new StubElement();
  button.dataset["todoId"] = "todo-1";
  button.dataset["status"] = "done";
  button.dataset["expectedUpdatedAt"] = "2026-11-03T00:00:00Z";
  await views.transitionAgendaTodo(button as unknown as HTMLButtonElement);
  assert.equal(element("agenda").innerHTML, '<span class="muted">暂无待处理 TODO</span>');
});

test("Agenda exposes in-progress, repeating advance, plan editing, and conflict refresh", async () => {
  const todo = {
    id: "todo-repeat",
    bucket_id: "bucket-1",
    entry_id: "entry-1",
    kind: "todo",
    text: "每周回顾",
    status: "open",
    scheduled_at: "2026-11-05T09:00:00.000Z",
    due_at: "2026-11-05T10:00:00.000Z",
    todo_rule: {
      frequency: "weekly",
      interval: 1,
      weekdays: null,
      until: null,
      count: null,
    },
    todo_raw_time: null,
    todo_occurrence: 1,
    occurred_at: null,
    source: null,
    reason: null,
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z",
  };
  let agendaReads = 0;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("/api/agenda")) {
      agendaReads++;
      return json({
        ok: true,
        now: "2026-11-05T00:00:00.000Z",
        todos: agendaReads === 1 ? [todo] : [{ ...todo, text: "服务器上的最新 TODO" }],
      });
    }
    if (url === "/api/todos/todo-repeat/advance") {
      return json({ ok: false, error: "stale write" }, 409);
    }
    if (url === "/api/todos/todo-repeat/plan") {
      return json({
        ok: true,
        todo: {
          ...todo,
          scheduled_at: "2026-11-06T09:00:00.000Z",
          updated_at: "2026-11-05T00:00:01.000Z",
        },
        correction_id: "correction-1",
      });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };

  await views.refreshAgenda();
  assert.match(element("agenda").innerHTML, /开始处理/);
  assert.match(element("agenda").innerHTML, /完成并推进/);
  assert.match(element("agenda").innerHTML, /编辑计划/);

  const advance = new StubElement();
  advance.dataset["todoId"] = "todo-repeat";
  advance.dataset["expectedUpdatedAt"] = todo.updated_at;
  await assert.rejects(
    views.advanceAgendaTodo(advance as unknown as HTMLButtonElement),
    /stale write/,
  );
  assert.match(element("agenda").innerHTML, /服务器上的最新 TODO/);
  assert.ok(calls.includes("POST /api/todos/todo-repeat/advance"));
  assert.ok(agendaReads >= 2);

  const editor = new StubElement();
  const scheduled = new StubElement();
  scheduled.value = "2026-11-06T09:00";
  const due = new StubElement();
  due.value = "2026-11-06T10:00";
  const frequency = new StubElement();
  frequency.value = "daily";
  const interval = new StubElement();
  interval.value = "2";
  editor.controls.set('[data-role="todo-scheduled"]', scheduled);
  editor.controls.set('[data-role="todo-due"]', due);
  editor.controls.set('[data-role="todo-frequency"]', frequency);
  editor.controls.set('[data-role="todo-interval"]', interval);
  const save = new StubElement();
  save.dataset["todoId"] = "todo-repeat";
  save.dataset["expectedUpdatedAt"] = todo.updated_at;
  save.closest = () => editor;
  await views.saveAgendaTodoPlan(save as unknown as HTMLButtonElement);
  assert.ok(calls.includes("POST /api/todos/todo-repeat/plan"));
  const planCall = calls.at(-2) ?? "";
  assert.match(planCall, /POST \/api\/todos\/todo-repeat\/plan/);
});

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
    assert.ok(calls.some((call) => call.includes("/api/agenda")));
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
  assert.equal(element("conversation-preview").checked, true);
  assert.equal(state.preview, true);
  assert.equal(element("conversation-refresh").hidden, false);
  assert.ok(calls.includes("GET /api/conversation/interactions"));
  assert.ok(calls.includes("GET /api/tasks"));
  assert.ok(element("task-list").listeners.has("click"));
  assert.ok(element("task-refresh").listeners.has("click"));
  assert.ok(element("conversation-refresh").listeners.has("click"));
  element("conversation-preview").checked = false;
  element("conversation-preview").trigger("change", {});
  await setImmediate();
  assert.equal(state.preview, false);
  assert.equal(element("conversation-refresh").hidden, true);
  element("conversation-preview").checked = true;
  element("conversation-preview").trigger("change", {});
  await setImmediate();
  assert.equal(state.preview, true);
  assert.equal(element("conversation-refresh").hidden, false);
  element("task-refresh").trigger("click", {});
  await setImmediate();
  assert.equal(calls.filter((call) => call === "GET /api/tasks").length, 2);
  element("chat-input").value = "尚未发送的草稿";
  element("memory-query").value = "已填写的查询";
  element("memory-query-result").innerHTML = "已加载的查询结果";
  element("nav-search").trigger("click", {});
  assert.equal(element("view-search").hidden, false);
  assert.equal(element("view-chat").hidden, true);
  assert.equal(element("nav-search").attributes.get("aria-current"), "page");
  assert.equal(element("nav-chat").attributes.has("aria-current"), false);
  assert.equal(element("workspace-title").textContent, "查询记忆");
  element("nav-chat").trigger("click", {});
  assert.equal(element("view-chat").hidden, false);
  assert.equal(element("chat-input").value, "尚未发送的草稿");
  assert.equal(element("memory-query").value, "已填写的查询");
  assert.equal(element("memory-query-result").innerHTML, "已加载的查询结果");
  element("nav-agenda").trigger("click", {});
  await views.showBucket("bucket-1");
  assert.equal(element("view-memory").hidden, false);
  assert.equal(element("view-agenda").hidden, true);
  assert.equal(element("nav-memory").attributes.get("aria-current"), "page");
  element("nav-chat").trigger("click", {});
  await views.showBucket("bucket-1", false);
  assert.equal(element("view-chat").hidden, false);
  element("new-chat").trigger("click", {});
  assert.equal(element("chat-input").value, "");
  assert.equal(element("chat-input").focused, true);
  assert.equal(element("view-chat").hidden, false);
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

const tcp = {
  id: randomUUID(),
  scopeRevision: 1,
  title: 'TCP <img src=x onerror="alert(1)">',
  hint: "<svg onload=alert(1)>",
};
const card: ClarificationCardDto = {
  id: randomUUID(),
  originalMessageId: randomUUID(),
  assistantMessageId: randomUUID(),
  originalText: "帮我改那个计网实验<script>bad()</script>",
  latestReply: null,
  status: "pending",
  revision: 1,
  question: "TCP 还是 UDP？",
  candidates: [tcp],
  selected: null,
};

function migratedCard(old: ClarificationCardDto): ConversationInteraction {
  return {
    ...old,
    awaiting: null,
    promptMessageId: null,
    truncated: false,
    candidates: old.candidates.map((item) => ({ ...item, kind: "work_item" })),
    selected: old.selected === null ? null : { ...old.selected, kind: "work_item" },
  };
}

function interactionView(interactions: readonly ConversationInteraction[], throughSequence = 100) {
  return {
    ok: true,
    snapshot: {
      throughSequence,
      prompts: interactions.flatMap(({ id, revision, awaiting, promptMessageId }) =>
        awaiting !== null && promptMessageId !== null
          ? [{ interactionId: id, revision, promptMessageId }]
          : [],
      ),
    },
    interactions,
  };
}

test("C2 cards render escaped user data and stable action IDs, including after falling out of chat history", () => {
  const html = renderClarification(card);
  assert.doesNotMatch(html, /<(?:img|svg|script)/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.match(html, /都不是/);
  assert.ok(html.includes(`data-clarification-id="${card.id}"`));
  assert.ok(html.includes(`data-work-item-id="${tcp.id}"`));
  const stale = renderClarification({ ...card, status: "stale", candidates: [] });
  assert.doesNotMatch(stale, /clarification-(reply|select|none)/);
});

test("preview restores cards, keeps interludes independent, retries the same payload and refreshes 409 cards", async () => {
  let current = card;
  let mode: "ok" | "drop" | "conflict" = "ok";
  let gets = 0;
  const posts: unknown[] = [];
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  globalThis.fetch = async (url, options) => {
    switch (String(url)) {
      case "/api/chat/history?limit=40":
        return json({ ok: true, messages: [] });
      case "/api/conversation/interactions":
        gets++;
        return json(interactionView([migratedCard(current)]));
      case "/api/conversation/turns": {
        assert.equal(options?.method, "POST");
        assert.equal(new Headers(options.headers).get("content-type"), "application/json");
        const request: unknown = JSON.parse(String(options.body));
        posts.push(request);
        if (mode === "drop") throw new Error("response lost");
        if (mode === "conflict") return json({ ok: false, error: "版本已变化" }, 409);
        return json({
          ok: true,
          result: {
            kind: "clarification",
            clarificationId: current.id,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
          },
        });
      }
      default:
        throw new Error(`Unexpected route: ${String(url)}`);
    }
  };
  const element = (id: string) => {
    const node = dom.elements.get(id);
    assert.ok(node);
    return node;
  };
  const button = (action: string) => {
    const node = new StubElement();
    Object.assign(node.dataset, {
      action,
      clarificationId: card.id,
      revision: "1",
      workItemId: tcp.id,
    });
    return node as unknown as HTMLButtonElement;
  };

  await views.loadHistory();
  assert.equal(gets, 0);
  assert.equal(state.preview, false);
  await views.setConversationPreview(true);
  assert.match(element("chat-messages").nodes[0]?.innerHTML ?? "", /任务澄清/);
  const composer = element("chat-input");
  composer.value = "SYN-ACK 是什么？";
  await views.sendMessage();
  assert.deepEqual(posts[0], {
    action: "utterance",
    text: "SYN-ACK 是什么？",
    requestId: Reflect.get(Object(posts[0]), "requestId"),
    snapshot: { throughSequence: 100, prompts: [] },
  });
  assert.equal(composer.value, "");

  await views.actOnClarification(button("clarification-reply"));
  assert.equal(element("clarification-reply-context").hidden, false);
  composer.value = "抓三次握手那个，只改报告";
  mode = "drop";
  await views.sendMessage();
  assert.equal(element("conversation-retry").hidden, false);
  assert.equal(composer.value, "抓三次握手那个，只改报告");
  assert.deepEqual(posts[1], state.retryTurn);
  assert.equal(state.retryTurn?.action, "reply");
  assert.equal(Reflect.get(Object(posts[1]), "clarificationId"), card.id);
  assert.equal(Reflect.get(Object(posts[1]), "expectedRevision"), 1);

  current = {
    ...card,
    status: "resolved",
    selected: tcp,
    candidates: [],
    revision: 2,
    latestReply: composer.value,
  };
  mode = "ok";
  await views.retryConversationTurn();
  assert.deepEqual(posts[1], posts[2]);
  assert.equal(element("conversation-retry").hidden, true);
  assert.equal(element("clarification-reply-context").hidden, true);
  assert.match(element("chat-messages").nodes[0]?.innerHTML ?? "", /已选目标/);

  current = { ...current, status: "stale", selected: null };
  const previousGets = gets;
  mode = "conflict";
  await views.actOnClarification(button("clarification-select"));
  assert.equal(Reflect.get(Object(posts[3]), "expectedRevision"), 1);
  assert.ok(gets > previousGets);
  assert.equal(state.interactions[0]?.status, "stale");
  assert.equal(state.retryTurn, null);
  assert.match(element("chat-status").textContent ?? "", /版本已变化/);
});

const resolvedCard: ClarificationCardDto = {
  ...card,
  status: "resolved",
  revision: 2,
  candidates: [],
  selected: tcp,
};

test("C3 renders escaped sources and results, and removes stale output", () => {
  const evil = '"><img src=x onerror="alert(1)">';
  const taskId = randomUUID();
  const html = renderClarification({
    ...resolvedCard,
    execution: { taskId, status: "succeeded", output: evil, failureCode: null },
  });
  assert.match(html, /工具输出（未归档）/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  const stale = renderClarification({
    ...resolvedCard,
    status: "stale",
    execution: { taskId, status: "succeeded", output: "旧结果不应显示", failureCode: null },
  });
  assert.match(stale, /已失效/);
  assert.doesNotMatch(stale, /旧结果不应显示|clarification-(continue|prepare)/);

  const sourced = renderMessage({
    ...message("reply", "由本地资料支持。"),
    role: "assistant",
    details: { citations: [{ entryId: evil, bucketId: evil }, { entryId: "invalid" }] },
  });
  assert.match(sourced, /data-bucket-id="&quot;&gt;&lt;img/);
  assert.match(sourced, /data-entry-id="&quot;&gt;&lt;img/);
  assert.doesNotMatch(sourced, /<img|来源 2/);
});

test("F8 renders a persisted retry anchor and hides it after completion", () => {
  const resultMessageId = randomUUID();
  const retryable = renderClarification({
    ...resolvedCard,
    promptMessageId: randomUUID(),
    awaiting: null,
    truncated: false,
    contextResult: {
      messageId: resultMessageId,
      status: "retryable_failure",
      text: "暂时无法从资料生成答案，请稍后重试。",
    },
    retryResultMessageId: resultMessageId,
  });
  assert.match(retryable, /暂时无法从资料生成答案/);
  assert.match(retryable, /重试回答/);
  assert.match(retryable, new RegExp(`data-retry-result-message-id="${resultMessageId}"`));
  const completed = renderClarification({
    ...resolvedCard,
    promptMessageId: randomUUID(),
    awaiting: null,
    truncated: false,
    contextResult: {
      messageId: resultMessageId,
      status: "completed",
      text: "TCP 报告草稿",
    },
  });
  assert.match(completed, /TCP 报告草稿/);
  assert.doesNotMatch(completed, /重试回答|clarification-(reply|cancel|none)/);
});

test("F8 a refreshed in-progress retry reconciles with the same request ID", async () => {
  const resultMessageId = randomUUID();
  const retryRequestId = randomUUID();
  const retryCard: ConversationInteraction = {
    ...naturalCard,
    status: "resolved",
    revision: 4,
    candidates: [],
    selected: entryCandidate,
    awaiting: null,
    promptMessageId: randomUUID(),
    truncated: false,
    contextResult: {
      messageId: resultMessageId,
      status: "unknown",
      text: "暂时无法从资料生成答案，请稍后重试。",
    },
    retryResultMessageId: resultMessageId,
    retryRequestId,
  };
  const sent: unknown[] = [];
  state.preview = true;
  state.interactions = [retryCard];
  globalThis.fetch = async (input, init) => {
    switch (String(input)) {
      case "/api/conversation/turns": {
        const body: unknown = JSON.parse(String(init?.body));
        sent.push(body);
        return json({
          ok: true,
          result: {
            kind: "clarification",
            clarificationId: retryCard.id,
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
          },
        });
      }
      case "/api/chat/history?limit=40":
        return json({ ok: true, messages: [] });
      case "/api/conversation/interactions":
        return json(interactionView([retryCard]));
      default:
        throw new Error(`Unexpected request ${String(input)}`);
    }
  };
  const button = new StubElement();
  Object.assign(button.dataset, {
    action: "clarification-retry",
    clarificationId: retryCard.id,
    revision: String(retryCard.revision),
    retryResultMessageId: resultMessageId,
    retryRequestId,
  });
  assert.match(renderClarification(retryCard), /核对重试结果/);
  await views.actOnClarification(button as unknown as HTMLButtonElement);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    action: "retry_context",
    requestId: retryRequestId,
    clarificationId: retryCard.id,
    expectedRevision: retryCard.revision,
    resultMessageId,
  });
});

test("C3 continuing a selected target uses its exact card revision and loads the evidence links", async () => {
  let response: ChatMessageDto | undefined;
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    switch (String(input)) {
      case "/api/chat/history?limit=40":
        return json({ ok: true, messages: response ? [response] : [] });
      case "/api/conversation/interactions":
        return json(interactionView([migratedCard(resolvedCard)]));
      case "/api/conversation/turns":
        assert.equal(init?.method, "POST");
        writes.push(JSON.parse(String(init.body)) as unknown);
        response = {
          ...message(randomUUID(), "从实验报告中确认 SYN-ACK 在第二步。"),
          role: "assistant",
          details: { citations: [{ entryId: "entry-syn", bucketId: "bucket-net" }] },
        };
        return json({
          ok: true,
          result: {
            kind: "clarification",
            clarificationId: resolvedCard.id,
            userMessageId: randomUUID(),
            assistantMessageId: response.id,
          },
        });
      default:
        throw new Error(`Unexpected route ${String(input)}`);
    }
  };
  await views.setConversationPreview(true);
  const button = new StubElement();
  Object.assign(button.dataset, {
    action: "clarification-continue",
    clarificationId: resolvedCard.id,
    revision: String(resolvedCard.revision),
  });
  await views.actOnClarification(button as unknown as HTMLButtonElement);
  assert.deepEqual(writes, [
    {
      action: "continue",
      clarificationId: resolvedCard.id,
      expectedRevision: resolvedCard.revision,
      requestId: Reflect.get(Object(writes[0]), "requestId"),
    },
  ]);
  assert.match(String(Reflect.get(Object(writes[0]), "requestId")), /^[a-f\d-]{36}$/);
  const transcript = element("chat-messages")
    .nodes.map((node) => node.innerHTML)
    .join("");
  assert.match(transcript, /SYN-ACK 在第二步/);
  assert.match(transcript, /data-bucket-id="bucket-net" data-entry-id="entry-syn"/);
});

test("C3 requires explicit workspace and CLI and retries only the same read-only proposal", async () => {
  let current = resolvedCard;
  let drop = true;
  const requests: unknown[] = [];
  const routes: string[] = [];
  const taskId = randomUUID();
  const workspaceId = randomUUID();
  globalThis.fetch = async (input, options) => {
    const path = String(input);
    routes.push(path);
    if (path === "/api/chat/history?limit=40") return json({ ok: true, messages: [] });
    if (path === "/api/conversation/interactions")
      return json(interactionView([migratedCard(current)]));
    if (path === "/api/agent/capabilities")
      return json({ ok: true, backends: ["codex"], permission: "read_only" });
    if (path === "/api/agent/workspaces")
      return json({
        ok: true,
        workspaces: [
          {
            id: workspaceId,
            path: "/repo/<script>alert(1)</script>",
            baseCommit: "1".repeat(40),
            gitStatus: "",
            createdAt: "2026-11-19T00:00:00.000Z",
          },
        ],
      });
    if (path === "/api/agent/tasks") return json({ ok: true, tasks: [] });
    if (path === "/api/conversation/turns") {
      assert.equal(options?.method, "POST");
      const body: unknown = JSON.parse(String(options.body));
      requests.push(body);
      if (drop) throw new Error("connection lost");
      current = {
        ...current,
        revision: 3,
        execution: { taskId, status: "pending", output: null, failureCode: null },
      };
      return json({
        ok: true,
        result: {
          kind: "clarification",
          clarificationId: current.id,
          userMessageId: randomUUID(),
          assistantMessageId: randomUUID(),
        },
      });
    }
    throw new Error(`Unexpected route ${path}`);
  };

  const button = (action: string, fields: Record<string, string> = {}): StubElement => {
    const node = new StubElement();
    Object.assign(node.dataset, {
      action,
      clarificationId: current.id,
      revision: String(current.revision),
      ...fields,
    });
    return node;
  };
  const act = (node: StubElement) => views.actOnClarification(node as unknown as HTMLButtonElement);
  const composer = element("chat-input");
  await views.setConversationPreview(true);
  assert.equal(element("conversation-refresh").hidden, false);
  await act(button("clarification-reply"));
  composer.value = "只允许检查报告";
  await act(button("clarification-continue"));
  assert.match(element("chat-status").textContent ?? "", /请先发送或丢弃这张卡/);
  assert.equal(requests.length, 0);
  views.discardClarificationReply();

  await act(button("clarification-prepare"));
  const pendingForm = element("chat-messages").nodes[0]?.innerHTML ?? "";
  assert.match(pendingForm, /data-delegate-workspace.*请选择工作区/);
  assert.match(pendingForm, /data-delegate-backend.*请选择 CLI/);
  assert.match(pendingForm, /&lt;script&gt;/);
  assert.doesNotMatch(pendingForm, /<script>/);

  const form = new StubElement();
  const workspace = new StubElement();
  const backend = new StubElement();
  form.controls.set("[data-delegate-workspace]", workspace);
  form.controls.set("[data-delegate-backend]", backend);
  const submit = button("clarification-delegate");
  form.insertBefore(submit, null);
  await act(submit);
  assert.deepEqual(requests, []);
  workspace.value = workspaceId;
  backend.value = "codex";
  composer.value = "无关的主对话草稿";
  await act(submit);
  assert.equal(composer.value, "无关的主对话草稿");
  assert.equal(requests.length, 1);
  assert.equal(element("conversation-retry").hidden, false);
  const requestId = state.retryTurn?.requestId;
  assert.ok(requestId);
  assert.deepEqual(requests[0], {
    requestId,
    action: "delegate",
    clarificationId: current.id,
    expectedRevision: 2,
    backend: "codex",
    workspaceId,
  });
  drop = false;
  await views.retryConversationTurn();
  assert.deepEqual(requests, [requests[0], requests[0]]);
  assert.equal(element("conversation-retry").hidden, true);
  const submitted = element("chat-messages").nodes[0]?.innerHTML ?? "";
  assert.match(submitted, /等待批准/);
  assert.doesNotMatch(submitted, /clarification-(prepare|delegate)|agent-approve/);
  assert.equal(
    routes.some((path) => path.includes("/approve")),
    false,
  );

  const taskFocus = new StubElement();
  const focusId = `agent-task-${taskId}`;
  dom.elements.set(focusId, taskFocus);
  try {
    await act(button("clarification-agent", { taskId }));
    assert.equal(element("view-tools").hidden, false);
    assert.equal(taskFocus.focused, true);
    assert.equal(routes.at(-1), "/api/agent/tasks");
  } finally {
    dom.elements.delete(focusId);
  }
});

test("C3 citations identify the particular active Entry or report that it is unavailable", async () => {
  const bucketId = "bucket-1";
  const timestamp = "2026-11-19T00:00:00.000Z";
  const bucket = {
    id: bucketId,
    title: "计网实验",
    type: "task",
    status: "active",
    summary: "",
    tags: [],
    created_at: timestamp,
    updated_at: timestamp,
    last_active_at: timestamp,
    archived_at: null,
  };
  const entry = {
    id: "observed",
    bucket_id: bucketId,
    raw_text: "抓包结果",
    summary: null,
    content_type: "text",
    classification_confidence: null,
    classification_reason: null,
    created_at: timestamp,
    moved_from_bucket_id: null,
    archive_state: "archived",
    archived_at: timestamp,
  };
  globalThis.fetch = async () =>
    json({
      ok: true,
      detail: {
        bucket,
        entries: [{ ...entry, id: "other", raw_text: "其他记录" }, entry],
        memories: [],
      },
    });
  const detail = element("detail");
  const citation = new StubElement();
  detail.controls.set("#cited-entry", citation);
  try {
    await views.showBucket(bucketId, true, "observed");
    assert.equal(element("view-memory").hidden, false);
    assert.equal(citation.focused, true);
    assert.match(detail.innerHTML, /id="cited-entry"[\s\S]*?引用来源[\s\S]*?抓包结果/);
    assert.doesNotMatch(detail.innerHTML, /不在当前 Bucket/);
    await views.showBucket(bucketId, true, "revoked");
    assert.match(detail.innerHTML, /不在当前 Bucket 的有效记录中/);
    assert.doesNotMatch(detail.innerHTML, /id="cited-entry"/);
  } finally {
    detail.controls.delete("#cited-entry");
  }
});

const entryCandidate = {
  kind: "entry",
  id: randomUUID(),
  memoryRevision: 7,
  title: tcp.title,
  hint: tcp.hint,
  bucketId: randomUUID(),
  createdAt: "2026-11-19T00:00:00.000Z",
} as const;

const naturalCard: ConversationInteraction = {
  ...migratedCard(card),
  candidates: [entryCandidate],
  awaiting: "subject",
  promptMessageId: card.assistantMessageId,
};

test("natural turns use the rendered snapshot, display the actual association and retain stale drafts", async () => {
  let current: ConversationInteraction[] = [naturalCard];
  let sequence = 120;
  let restored = false;
  const posts: unknown[] = [];
  let history: ChatMessageDto[] = [];
  let status = 200;
  let drop = false;
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    switch (String(url)) {
      case "/api/chat/history?limit=40":
        return json({ ok: true, messages: history });
      case "/api/conversation/interactions":
        refreshes++;
        return restored
          ? json(interactionView(current, sequence))
          : json({ ok: false, error: "无法读取快照" }, 503);
      case "/api/conversation/turns": {
        posts.push(JSON.parse(String(init?.body)) as unknown);
        if (drop) throw new Error("lost response");
        if (status === 409) return json({ ok: false, error: "问题已变化" }, status);
        const userMessageId = randomUUID();
        const assistantMessageId = randomUUID();
        history = [
          {
            ...message(assistantMessageId, "TCP 报告草稿"),
            role: "assistant",
            details: {
              citations: [{ entryId: entryCandidate.id, bucketId: entryCandidate.bucketId }],
            },
          },
        ];
        current = [
          {
            ...naturalCard,
            awaiting: null,
            status: "resolved",
            selected: entryCandidate,
            candidates: [],
            revision: 2,
          },
        ];
        sequence++;
        return json({
          ok: true,
          result: {
            kind: "clarification",
            userMessageId,
            assistantMessageId,
            clarificationId: naturalCard.id,
          },
        });
      }
      default:
        throw new Error("Unexpected route " + String(url));
    }
  };
  await views.setConversationPreview(true);
  const composer = element("chat-input");
  composer.value = "抓三次握手那个，只改报告";
  await views.sendMessage();
  assert.equal(posts.length, 0);
  assert.match(element("chat-status").textContent ?? "", /先刷新对话/);
  restored = true;
  await views.loadHistory();
  const originalSnapshot = interactionView([naturalCard], 120).snapshot;
  assert.match(element("chat-messages").nodes[0]?.innerHTML ?? "", /查看原文/);
  const count = refreshes;
  drop = true;
  await views.sendMessage();
  assert.equal(refreshes, count + 1, "only refresh after the lost submission");
  assert.deepEqual(posts[0], {
    action: "utterance",
    requestId: state.retryTurn?.requestId,
    text: composer.value,
    snapshot: originalSnapshot,
  });
  assert.equal(element("clarification-reply-context").hidden, true);
  sequence += 3;
  await views.loadHistory();
  assert.notDeepEqual(state.observedConversation, originalSnapshot);
  drop = false;
  await views.retryConversationTurn();
  assert.deepEqual(posts[1], posts[0], "retry retains the same id and the original snapshot");
  assert.equal(composer.value, "");
  const html = element("chat-messages")
    .nodes.map((node) => node.innerHTML)
    .join("");
  assert.match(html, /TCP 报告草稿/);
  assert.match(html, /已关联材料/);
  assert.match(html, /data-entry-id=/);
  assert.doesNotMatch(html, /<img|<svg|clarification-prepare|clarification-continue/);

  status = 409;
  composer.value = "原文：补充段落";
  const beforeConflict = refreshes;
  await views.sendMessage();
  assert.equal(posts.length, 3, "do not reissue a stale request");
  assert.equal(refreshes, beforeConflict + 1);
  assert.equal(state.retryTurn, null);
  assert.equal(composer.value, "原文：补充段落");
  assert.match(element("chat-status").textContent ?? "", /问题已变化.*再决定是否重新发送/);
});

test("Entry candidate buttons keep their exact subject type and current unarchived material has a local citation", async () => {
  const selection = renderClarification(naturalCard);
  assert.match(selection, /data-subject-kind="entry"/);
  assert.match(selection, /查看原文/);
  assert.doesNotMatch(selection, /data-work-item-id|<img|<svg/);
  const writes: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    switch (String(input)) {
      case "/api/chat/history?limit=40":
        return json({ ok: true, messages: [] });
      case "/api/conversation/interactions":
        return json(interactionView([naturalCard]));
      case "/api/conversation/turns":
        writes.push(JSON.parse(String(init?.body)) as unknown);
        return json({
          ok: true,
          result: {
            kind: "clarification",
            userMessageId: randomUUID(),
            assistantMessageId: randomUUID(),
            clarificationId: naturalCard.id,
          },
        });
      default:
        throw new Error("Unexpected route " + String(input));
    }
  };
  await views.setConversationPreview(true);
  const button = new StubElement();
  Object.assign(button.dataset, {
    action: "clarification-select",
    clarificationId: naturalCard.id,
    revision: "1",
    subjectKind: "entry",
    subjectId: entryCandidate.id,
  });
  await views.actOnClarification(button as unknown as HTMLButtonElement);
  assert.deepEqual(writes, [
    {
      requestId: Reflect.get(Object(writes[0]), "requestId"),
      action: "utterance",
      text: "选择：" + entryCandidate.title,
      replyTo: {
        interactionId: naturalCard.id,
        revision: naturalCard.revision,
        promptMessageId: naturalCard.promptMessageId,
      },
      selection: {
        kind: "entry",
        id: entryCandidate.id,
        memoryRevision: entryCandidate.memoryRevision,
      },
    },
  ]);
  const material = message(randomUUID(), "原文：<img src=x onerror=alert(1)>");
  renderTranscript([
    material,
    {
      ...message(randomUUID(), "改写"),
      role: "assistant",
      details: {
        materialMessageIds: [material.id, '"><svg onload=alert(2)>'],
      },
    },
  ]);
  const transcript = element("chat-messages")
    .nodes.map((node) => node.innerHTML)
    .join("");
  assert.match(transcript, /本轮提供（未归档）/);
  assert.doesNotMatch(transcript, /<img|<svg/);
  assert.equal(showConversationMessage(material.id), true);
  assert.equal(element("chat-messages").nodes[0]?.focused, true);
  assert.equal(showConversationMessage("missing"), false);
});
