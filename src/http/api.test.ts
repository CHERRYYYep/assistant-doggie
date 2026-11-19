import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import {
  appendExisting,
  askUser,
  createNew,
  type ClassificationResult,
} from "../domain/classification.ts";
import {
  createExtraction,
  minimalExtraction,
  type ExtractionResult,
} from "../domain/memory.ts";
import { BucketStatus, BucketType } from "../domain/types.ts";
import { LlmError } from "../llm/structured-output.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { ConcreteDoggieHttpApi, type ChatResponder } from "./api.ts";
import { createDoggieApp } from "./app.ts";

function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

class FakeModel implements MemoryModel {
  readonly modelName = "fake-http-model";
  readonly calls: string[] = [];
  classification: ClassificationResult = createNew(
    BucketType.Task,
    "默认任务",
    0.99,
    "明确的新任务",
  );
  extraction: ExtractionResult = minimalExtraction("结构化摘要");
  classificationError: Error | undefined;
  extractionError: Error | undefined;

  async classify(text: string, candidates: readonly { id: string }[]) {
    this.calls.push(
      `classify:${text}:${candidates.map(({ id }) => id).join(",")}`,
    );
    if (this.classificationError !== undefined) {
      throw this.classificationError;
    }
    return this.classification;
  }

  async extract(text: string) {
    this.calls.push(`extract:${text}`);
    if (this.extractionError !== undefined) throw this.extractionError;
    return this.extraction;
  }
}

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

function setup(options: { chatResponder?: ChatResponder } = {}) {
  const clock = steppingClock();
  const store = new Store(openDatabase(":memory:"), clock);
  const model = new FakeModel();
  const runtime = new ArchiveRuntime(store, model);
  const api = new ConcreteDoggieHttpApi(store, runtime, {
    clock,
    chatResponder: options.chatResponder,
  });
  return { store, model, runtime, api, app: createDoggieApp(api, []) };
}

async function createBucket(
  api: ConcreteDoggieHttpApi,
  model: FakeModel,
  title: string,
): Promise<{ bucketId: string; entryId: string }> {
  model.classification = createNew(
    BucketType.Task,
    title,
    0.99,
    "明确的新任务",
  );
  model.extraction = minimalExtraction(`${title}摘要`);
  const response = await api.archive({ text: `${title}事实 100%` });
  return {
    bucketId: response.bucket_id!,
    entryId: response.entry_id!,
  };
}

test("concrete API archives a complete graph and projects query-compatible JSON", async () => {
  const { store, model, api } = setup();
  model.classification = createNew(
    BucketType.Incident,
    "支付故障",
    0.98,
    "新的明确故障",
  );
  model.extraction = createExtraction({
    summary: "支付错误率升到 12%",
    evidences: ["错误率 12%"],
  });

  const archive = await api.archive({ text: "支付错误率升到 12%" });
  assert.equal(archive.archive_state, "archived");
  assert.equal(archive.bucket?.title, "支付故障");
  assert.equal(archive.memory_item_ids.length, 1);
  assert.equal(
    store.getEntry(archive.entry_id!)?.rawText,
    "支付错误率升到 12%",
  );

  const getQuery = api.memoryQuery("支付", 20);
  const postQuery = api.memoryQueryJson({
    query: "支付",
    limit: 20,
    statuses: [],
    filters: [],
  });
  assert.deepEqual(postQuery, getQuery);
  assert.deepEqual(getQuery.query_plan.bucket_terms, ["支付"]);
  assert.equal(getQuery.results[0]?.entry.id, archive.entry_id);
});

test("archive and chat project only the current Entry's ordered memory IDs in a populated Bucket", async (t) => {
  const { store, model, api } = setup();
  t.after(() => store.database.close());
  const { bucketId } = await createBucket(api, model, "接口 A");
  model.classification = appendExisting(
    bucketId,
    BucketType.Task,
    0.99,
    "同一主题",
  );
  model.extraction = createExtraction({
    summary: "测试摘要",
    evidences: ["压测报告", "验证记录"],
    todos: ["排查剩余问题"],
  });
  for (let i = 0; i < 80; i++) {
    await api.archive({ text: `接口 A 第 ${i} 次测试达到 100%` });
  }
  const hydrate = t.mock.method(store.memory, "getBucketDetail");
  const archive = await api.archive({ text: "接口 A 已完成安装验证 100%" });
  const chat = await api.chat({ message: "接口 A 已完成恢复验证 100%" });
  assert.equal(
    hydrate.mock.callCount(),
    0,
    "projection must not hydrate the Bucket",
  );

  const detail = store.getBucketDetail(bucketId);
  assert.ok(detail);
  assert.equal(detail.memories.length, 246);
  for (const snapshot of [archive, chat.archive]) {
    assert.equal(snapshot.archive_state, "archived");
    const ids: string[] = detail.memories
      .filter((item) => item.entryId === snapshot.entry_id)
      .map((item) => item.id);
    assert.equal(ids.length, 3);
    assert.deepEqual(snapshot.memory_item_ids, ids);
  }
});

test("chat confirmation card exposes all choices and hydrated history becomes non-actionable", async (t) => {
  const { store, model, api } = setup();
  const target = await createBucket(api, model, "接口 A");
  const focus = await createBucket(api, model, "当前工作区");
  model.classification = askUser(
    BucketType.Task,
    undefined,
    0.6,
    "需要确认",
    "保存到哪里？",
    [target.bucketId],
  );

  const chat = await api.chat({ message: "接口 A 更新了" });
  assert.equal(chat.archive_state, "needs_confirmation");
  assert.deepEqual(chat.archive["available_actions"], [
    "append_recommended",
    "append_alternative",
    "create_new",
    "discard",
  ]);
  assert.equal(chat.archive.recommended_bucket?.id, target.bucketId);
  assert.equal(
    (
      chat.archive["candidate_buckets"] as readonly Record<string, unknown>[]
    )[0]?.["id"],
    target.bucketId,
  );
  assert.equal(store.getBucketDetail(target.bucketId)?.entries.length, 1);

  await assert.rejects(
    api.confirmChat({
      confirmation_granted: true,
      action: "append",
      attempt_id: chat.archive.attempt_id,
      text: "接口 A 更新了 ",
      bucket_id: target.bucketId,
    }),
  );
  assert.equal(
    store.getArchiveAttempt(chat.archive.attempt_id)?.archiveState,
    "needs_confirmation",
  );

  model.extraction = createExtraction({
    summary: "确认摘要",
    evidences: ["确认事实"],
  });
  const hydrate = t.mock.method(store.memory, "getBucketDetail");
  const confirmed = await api.confirmChat({
    confirmation_granted: true,
    action: "append",
    attempt_id: chat.archive.attempt_id,
    text: "接口 A 更新了",
    bucket_id: target.bucketId,
    focus_bucket_id: focus.bucketId,
  });
  assert.equal(confirmed.archive_state, "archived");
  assert.equal(confirmed.archive.memory_item_ids.length, 1);
  assert.equal(confirmed.source_attempt_id, chat.archive.attempt_id);
  assert.equal(confirmed.result_attempt_id, confirmed.archive["attempt_id"]);
  assert.notEqual(confirmed.result_attempt_id, confirmed.source_attempt_id);
  assert.equal(
    store.getArchiveAttempt(confirmed.result_attempt_id!)?.focusBucketId,
    focus.bucketId,
  );
  assert.equal(
    confirmed.user_message.content,
    `确认保存到 Bucket ${target.bucketId}`,
  );

  const history = api.chatHistory(40);
  assert.equal(
    hydrate.mock.callCount(),
    0,
    "confirmation and history must not hydrate the Bucket",
  );
  const originalCard = history.messages.find(
    (message) =>
      message.role === "assistant" &&
      typeof message.details === "object" &&
      message.details !== null &&
      (message.details as Record<string, unknown>)["kind"] === "archive_result",
  );
  const details = originalCard?.details as Record<string, unknown>;
  const hydratedArchive = details["archive"] as Record<string, unknown>;
  assert.equal(details["pending_confirmation"], false);
  assert.equal(hydratedArchive["archive_state"], "archived");
  assert.deepEqual(hydratedArchive["available_actions"], [
    "move_entry",
    "revoke_entry",
  ]);
  assert.equal(
    (hydratedArchive["bucket"] as Record<string, unknown>)["id"],
    target.bucketId,
  );

  await assert.rejects(
    api.confirmChat({
      confirmation_granted: true,
      action: "discard",
      attempt_id: chat.archive.attempt_id,
      text: "接口 A 更新了",
    }),
  );
});

test("create and discard confirmations have explicit result attempt semantics", async () => {
  const { store, model, api } = setup();
  const focus = await createBucket(api, model, "实验工作区");
  model.classification = askUser(
    BucketType.Experiment,
    "新实验",
    0.5,
    "需要用户确认新主题",
    "是否创建？",
  );
  const createPending = await api.chat({ message: "实验数据有更新" });
  const created = await api.confirmChat({
    confirmation_granted: true,
    action: "create",
    attempt_id: createPending.archive.attempt_id,
    text: "实验数据有更新",
    title: "新实验",
    bucket_type: BucketType.Experiment,
    focus_bucket_id: focus.bucketId,
  });
  assert.equal(created.archive_state, "archived");
  assert.deepEqual(created.archive.memory_item_ids, []);
  assert.equal(
    (created.archive["bucket"] as Record<string, unknown>)["title"],
    "新实验",
  );
  assert.equal(created.result_attempt_id, created.archive["attempt_id"]);
  assert.equal(
    store.getArchiveAttempt(created.result_attempt_id!)?.focusBucketId,
    focus.bucketId,
  );

  model.classification = askUser(
    undefined,
    undefined,
    0.2,
    "信息不足",
    "是否保存？",
  );
  const discardPending = await api.chat({ message: "那个更新了" });
  const callsBeforeDiscard = model.calls.length;
  const discarded = await api.confirmChat({
    confirmation_granted: true,
    action: "discard",
    attempt_id: discardPending.archive.attempt_id,
    text: "那个更新了",
  });
  assert.equal(discarded.archive_state, "discarded");
  assert.deepEqual(discarded.archive.memory_item_ids, []);
  assert.equal(discarded.result_attempt_id, null);
  assert.equal(model.calls.length, callsBeforeDiscard);

  const history = api.chatHistory(40);
  const discardedCard = history.messages.find((message) => {
    if (typeof message.details !== "object" || message.details === null)
      return false;
    const archive = (message.details as Record<string, unknown>)["archive"];
    return (
      typeof archive === "object" &&
      archive !== null &&
      (archive as Record<string, unknown>)["attempt_id"] ===
        discardPending.archive.attempt_id
    );
  });
  const details = discardedCard?.details as Record<string, unknown>;
  const archive = details["archive"] as Record<string, unknown>;
  assert.equal(archive["archive_state"], "discarded");
  assert.equal(archive["available_actions"], undefined);
  assert.equal(archive["confirmation_options"], undefined);
});

test("classification and extraction failures preserve accepted chat messages", async () => {
  for (const failure of ["classification", "extraction"] as const) {
    const { model, app } = setup();
    const llmError = LlmError.response(
      "invalid_response",
      `${failure} failed safely`,
      false,
    );
    if (failure === "classification") {
      model.classificationError = llmError;
    } else {
      model.classification = createNew(
        BucketType.Task,
        "失败任务",
        0.99,
        "明确",
      );
      model.extractionError = llmError;
    }

    const response = await localRequest(app, "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${failure} 输入` }),
    });
    assert.equal(response.status, 500);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["ok"], false);
    assert.equal(
      (body["user_message"] as Record<string, unknown>)["content"],
      `${failure} 输入`,
    );
    assert.match(
      String((body["assistant_message"] as Record<string, unknown>)["content"]),
      /暂时无法完成这次归档/u,
    );

    const historyResponse = await localRequest(
      app,
      "/api/chat/history?limit=40",
    );
    const history = (await historyResponse.json()) as {
      messages: readonly unknown[];
    };
    assert.equal(history.messages.length, 2);
  }
});

test("confirmation execution failures preserve the accepted confirmation messages", async () => {
  const { store, model, api, app } = setup();
  const target = await createBucket(api, model, "确认失败目标");
  model.classification = askUser(
    BucketType.Task,
    undefined,
    0.5,
    "需要确认",
    "保存到哪里？",
    [target.bucketId],
  );
  const pending = await api.chat({ message: "确认失败输入" });
  model.extractionError = LlmError.response(
    "invalid_response",
    "confirmation extraction failed safely",
    false,
  );

  const response = await localRequest(app, "/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmation_granted: true,
      action: "append",
      attempt_id: pending.archive.attempt_id,
      text: "确认失败输入",
      bucket_id: target.bucketId,
    }),
  });
  assert.equal(response.status, 500);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(
    (body["user_message"] as Record<string, unknown>)["content"],
    `确认保存到 Bucket ${target.bucketId}`,
  );
  assert.match(
    String((body["assistant_message"] as Record<string, unknown>)["content"]),
    /暂时无法完成这次确认/u,
  );
  assert.equal(
    store.getArchiveAttempt(pending.archive.attempt_id)?.archiveState,
    "needs_confirmation",
  );
  const history = api.chatHistory(40);
  assert.equal(history.messages.at(-2)?.role, "user");
  assert.equal(history.messages.at(-1)?.role, "assistant");
});

test("chat tool messages round-trip through persistence and history", async () => {
  const responder: ChatResponder = {
    async respond() {
      return {
        assistantText: "已完成工具查询。",
        toolMessages: [
          {
            name: "search_memory",
            callId: "call-1",
            arguments: { query: "接口" },
            output: { count: 1 },
          },
        ],
      };
    },
  };
  const { api } = setup({ chatResponder: responder });
  const response = await api.chat({ message: "接口事实 42%" });
  assert.equal(response.tool_messages[0]?.call_id, "call-1");
  assert.equal(response.messages[1]?.role, "tool");
  assert.equal(response.messages[1]?.tool_call_id, "call-1");

  const history = api.chatHistory(40);
  const tool = history.messages.find((message) => message.role === "tool");
  assert.equal(tool?.tool_call_id, "call-1");
});

test("chat responder failure uses deterministic fallback after archive succeeds", async () => {
  const responder: ChatResponder = {
    async respond() {
      throw new Error("private responder detail");
    },
  };
  const { model, api } = setup({ chatResponder: responder });
  model.classification = createNew(
    BucketType.Knowledge,
    "发布知识",
    0.99,
    "明确知识",
  );
  model.extraction = minimalExtraction("发布版本为 1.2.3");

  const response = await api.chat({ message: "发布版本为 1.2.3" });
  assert.equal(response.ok, true);
  assert.equal(response.chat_error, "internal server error");
  assert.match(response.assistant_message.content, /已将这条内容归档/u);
});

test("inactive and deleted confirmation targets fail without resolving attempts", async () => {
  const { store, model, api, app } = setup();
  const inactive = await createBucket(api, model, "已完成目标");
  model.classification = askUser(
    undefined,
    undefined,
    0.5,
    "需要确认",
    "保存到哪里？",
    [inactive.bucketId],
  );
  const pending = await api.chat({ message: "状态更新" });
  api.setBucketStatus({
    bucket_id: inactive.bucketId,
    status: BucketStatus.Done,
  });

  const inactiveResponse = await localRequest(app, "/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmation_granted: true,
      action: "append",
      attempt_id: pending.archive.attempt_id,
      text: "状态更新",
      bucket_id: inactive.bucketId,
    }),
  });
  assert.equal(inactiveResponse.status, 409);
  assert.equal(
    store.getArchiveAttempt(pending.archive.attempt_id)?.archiveState,
    "needs_confirmation",
  );

  api.deleteBucket(inactive.bucketId);
  const deletedResponse = await localRequest(app, "/api/chat/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      confirmation_granted: true,
      action: "append",
      attempt_id: pending.archive.attempt_id,
      text: "状态更新",
      bucket_id: inactive.bucketId,
    }),
  });
  assert.equal(deletedResponse.status, 404);
  assert.equal(
    store.getArchiveAttempt(pending.archive.attempt_id)?.archiveState,
    "needs_confirmation",
  );
});

test("POST memory query accepts filters and projects structured_filters", async () => {
  const { app } = setup();
  const response = await localRequest(app, "/api/memory/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "接口",
      filters: [{ field: "memory.kind", value: "evidence" }],
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(
    (body["query_plan"] as Record<string, unknown>)["structured_filters"],
    [{ field: "memory.kind", value: "evidence" }],
  );

  const legacyField = await localRequest(app, "/api/memory/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "接口", structured_filters: [] }),
  });
  assert.equal(legacyField.status, 400);
});

test("move, status, detail, search and deletion routes use concrete services", async () => {
  const { model, api } = setup();
  const source = await createBucket(api, model, "源 Bucket");
  const target = await createBucket(api, model, "目标 Bucket");

  const moved = api.moveEntry({
    entry_id: source.entryId,
    target_bucket_id: target.bucketId,
    command_text: "移动到目标 Bucket",
  });
  assert.equal(moved.entry.bucket_id, target.bucketId);
  assert.equal(moved.source_bucket_id, source.bucketId);

  const status = api.setBucketStatus({
    bucket_id: target.bucketId,
    status: BucketStatus.Paused,
  });
  assert.equal(status.status, "paused");
  assert.equal(api.bucketDetail(target.bucketId).detail.entries.length, 2);
  assert.equal(api.searchBuckets("目标", 20).results.length, 1);

  const deleted = api.deleteBucket(target.bucketId);
  assert.deepEqual(
    new Set(deleted.deleted_entry_ids),
    new Set([source.entryId, target.entryId]),
  );
  assert.equal(deleted.updated_archive_attempt_ids.length >= 2, true);
  assert.throws(() => api.bucketDetail(target.bucketId));
});
