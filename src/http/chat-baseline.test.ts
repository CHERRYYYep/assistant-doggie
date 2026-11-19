import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

import { networkLab } from "../../tests/fixtures/main-conversation-cases.ts";
import { createMemoryHarnessTools } from "../agent/harness.ts";
import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import type { ChatResponder } from "../application/chat-types.ts";
import { MemoryTools } from "../application/memory-tools.ts";
import { describeCreatedGoal } from "../application/work-items.ts";
import {
  appendExisting,
  askUser,
  createNew,
} from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { AgentStore } from "../storage/agents.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { TaskStore } from "../storage/tasks.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { ConcreteDoggieHttpApi } from "./api.ts";
import { createDoggieApp } from "./app.ts";
import * as schemas from "./response-schemas.ts";

const fixtureModel: MemoryModel = {
  modelName: "fake-c0-baseline",
  async classify() {
    return createNew(BucketType.Task, networkLab.bucket, 0.99, "合成明确记录");
  },
  async extract(text) {
    return createExtraction({ summary: text, evidences: [text] });
  },
};

function setup(store: Store, model: MemoryModel, chatResponder: ChatResponder) {
  const runtime = new ArchiveRuntime(store, model);
  const app = createDoggieApp(
    new ConcreteDoggieHttpApi(store, runtime, { chatResponder }),
    [],
  );
  function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Host", "localhost");
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    return app.request(`http://localhost${path}`, { ...init, headers });
  }
  function startChat(message: string, signal?: AbortSignal) {
    return request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
  async function chat(message: string) {
    const response = await startChat(message);
    assert.equal(response.status, 200);
    return schemas.chatResponseSchema.parse(await response.json());
  }
  async function history() {
    const response = await request("/api/chat/history");
    assert.equal(response.status, 200);
    return schemas.chatHistoryResponseSchema.parse(await response.json());
  }
  return { request, startChat, chat, history };
}

test("C0 legacy chat commits actionable records before answering, but confirmation masks answers and has no WorkItem binding", async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), "doggie-c0-"));
  using db = openDatabase(join(directory.path, "fixture.db"));
  const store = new Store(db);
  const workItems = new WorkItemStore(db);
  const calls: string[] = [];
  const reviewAnswer = "这是合成模型生成的回答";
  let bucketId: string | undefined;
  const { chat, request } = setup(
    store,
    {
      ...fixtureModel,
      async classify(text) {
        calls.push(`classify:${text}`);
        if (bucketId === undefined) return fixtureModel.classify(text, []);
        if (text === "那个任务继续") {
          return appendExisting(bucketId, undefined, 0.99, "模拟高置信度误判");
        }
        return askUser(
          BucketType.Task,
          undefined,
          0.6,
          "需要先选择归档位置",
          "保存到哪里？",
          [bucketId],
        );
      },
      async extract(text) {
        calls.push(`extract:${text}`);
        return fixtureModel.extract(text);
      },
    },
    {
      async respond({ sourceText, archive }) {
        assert.ok(archive);
        calls.push(`answer:${sourceText}`);
        if (archive["archive_state"] === "archived") {
          assert.equal(typeof archive["entry_id"], "string");
          assert.ok(store.getEntry(String(archive["entry_id"])));
        }
        return { assistantText: reviewAnswer };
      },
    },
  );

  const record = "计网实验完成 100%，报告正文待校对";
  const archived = await chat(record);
  assert.equal(archived.archive_state, "archived");
  assert.equal(archived.chat_error, null);
  assert.equal(archived.assistant_message.content, reviewAnswer);
  assert.ok(archived.archive.entry_id);
  assert.ok(archived.archive.memory_item_ids.length > 0);
  bucketId = archived.archive.bucket_id ?? undefined;
  assert.ok(bucketId);
  const originalWorkItems = [networkLab.tcp, networkLab.udp].map((title) =>
    workItems.create(
      {
        requestId: randomUUID(),
        title,
        goal: `校对 ${title} 的报告`,
        acceptance: "只改报告",
        sources: [{ kind: "bucket", id: bucketId }],
      },
      describeCreatedGoal,
    ),
  );

  const proposals = [];
  const pendingTexts = [
    "那个任务继续",
    networkLab.request,
    networkLab.question,
    networkLab.supplement,
    "好",
  ];
  for (const message of pendingTexts) {
    const pending = await chat(message);
    assert.equal(pending.chat_error, null);
    assert.equal(pending.archive_state, "needs_confirmation");
    assert.equal(pending.archive.action, "ask_user");
    assert.equal(pending.archive.entry_id, null);
    assert.deepEqual(pending.archive.available_actions, [
      "append_recommended",
      "append_alternative",
      "create_new",
      "discard",
    ]);
    assert.match(pending.assistant_message.content, /推荐 Bucket：/u);
    assert.notEqual(pending.assistant_message.content, reviewAnswer);
    assert.deepEqual(pending.user_message.details, {
      kind: "user_input",
      requested_focus_bucket_id: null,
    });
    proposals.push(pending.archive.attempt_id);
  }
  assert.deepEqual(calls, [
    `classify:${record}`,
    `extract:${record}`,
    `answer:${record}`,
    ...pendingTexts.flatMap((message) => [
      `classify:${message}`,
      `answer:${message}`,
    ]),
  ]);
  assert.equal(new Set(proposals).size, pendingTexts.length);
  for (const id of proposals) {
    assert.equal(
      store.getArchiveAttempt(id)?.archiveState,
      "needs_confirmation",
    );
    assert.equal(store.getPendingAction(id)?.status, "pending");
  }
  const taskProposal = proposals[1];
  assert.ok(taskProposal);
  const confirm = (rawText: string) =>
    request("/api/chat/confirm", {
      method: "POST",
      body: JSON.stringify({
        action: "discard",
        confirmation_granted: true,
        attempt_id: taskProposal,
        text: rawText,
      }),
    });
  assert.equal((await confirm(networkLab.supplement)).status, 409);
  assert.equal(store.getPendingAction(taskProposal)?.status, "pending");
  const discarded = await confirm(networkLab.request);
  assert.equal(discarded.status, 200);
  const confirmation = schemas.chatConfirmationResponseSchema.parse(
    await discarded.json(),
  );
  assert.equal(confirmation.source_attempt_id, taskProposal);
  assert.equal(confirmation.archive_state, "discarded");
  assert.equal(confirmation.result_attempt_id, null);
  assert.equal(store.getPendingAction(taskProposal)?.status, "rejected");
  assert.equal(
    store.getArchiveAttempt(taskProposal)?.archiveState,
    "discarded",
  );
  assert.equal((await confirm(networkLab.request)).status, 409);
  const supplementProposal = proposals[3];
  assert.ok(supplementProposal);
  assert.equal(store.getPendingAction(supplementProposal)?.status, "pending");
  assert.equal(store.getBucketDetail(bucketId)?.entries.length, 1);
  for (const item of originalWorkItems)
    assert.deepEqual(workItems.get(item.id), item);
  assert.deepEqual(new AgentStore(db).tasks(), []);
  assert.deepEqual(new TaskStore(db).list(), []);
});

test(
  "C0 cancelling HTTP chat before archive commit keeps only the accepted input",
  { timeout: 5000 },
  async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "doggie-c0-"));
    using db = openDatabase(join(directory.path, "fixture.db"));
    const store = new Store(db);
    const extracting = Promise.withResolvers<AbortSignal | undefined>();
    const late =
      Promise.withResolvers<Awaited<ReturnType<MemoryModel["extract"]>>>();
    const message = "计网报告延迟 120ms";
    let answers = 0;
    const { history, startChat } = setup(
      store,
      {
        ...fixtureModel,
        async extract(_text, signal) {
          extracting.resolve(signal);
          return late.promise;
        },
      },
      {
        async respond() {
          answers += 1;
          return { assistantText: "不应调用" };
        },
      },
    );
    const controller = new AbortController();
    const run = startChat(message, controller.signal);
    const signal = await extracting.promise;
    try {
      const admitted = (await history()).messages;
      assert.deepEqual(
        admitted.map(({ role, content }) => [role, content]),
        [["user", message]],
      );
      controller.abort();
      assert.equal(signal?.aborted, true);
      // A fake that ignores the signal can finish; its late value must be ignored.
      late.resolve(createExtraction({ summary: "迟到结果" }));
      await run;
      assert.deepEqual((await history()).messages, admitted);
    } finally {
      controller.abort();
      late.resolve(createExtraction({ summary: "迟到结果" }));
      await run;
    }
    assert.deepEqual(store.listBuckets(), []);
    assert.equal(answers, 0);
    assert.deepEqual(db.prepare("SELECT id FROM archive_attempts").all(), []);
    assert.deepEqual(db.prepare("SELECT id FROM pending_actions").all(), []);
  },
);

test(
  "C0 cancelling HTTP chat after archive commit keeps the Entry and drops late answer and tool messages",
  { timeout: 5000 },
  async () => {
    using directory = mkdtempDisposableSync(join(tmpdir(), "doggie-c0-"));
    using db = openDatabase(join(directory.path, "fixture.db"));
    const store = new Store(db);
    const answering =
      Promise.withResolvers<Parameters<ChatResponder["respond"]>[0]>();
    const late =
      Promise.withResolvers<Awaited<ReturnType<ChatResponder["respond"]>>>();
    const { history, startChat } = setup(store, fixtureModel, {
      async respond(request) {
        answering.resolve(request);
        return late.promise;
      },
    });
    const controller = new AbortController();
    const run = startChat("计网报告已更新，结果 100%", controller.signal);
    const { archive, signal } = await answering.promise;
    const lateAnswer = {
      assistantText: "迟到回答",
      toolMessages: [
        {
          name: "search_memory",
          callId: "late",
          arguments: {},
          output: { marker: "迟到证据" },
        },
      ],
    };
    try {
      assert.ok(archive);
      const entryId = archive["entry_id"];
      assert.equal(typeof entryId, "string");
      assert.ok(store.getEntry(String(entryId)));
      controller.abort();
      assert.equal(signal?.aborted, true);
      late.resolve(lateAnswer);
      const response = await run;
      assert.equal(response.status, 200);
      const body = schemas.chatResponseSchema.parse(await response.json());
      assert.equal(body.archive.entry_id, entryId);
      assert.equal(body.archive_state, "archived");
      assert.equal(body.chat_error, null);
      assert.match(body.assistant_message.content, /已将这条内容归档/u);
      assert.deepEqual(body.tool_messages, []);
    } finally {
      controller.abort();
      late.resolve(lateAnswer);
      await run;
    }
    const saved = (await history()).messages;
    assert.deepEqual(
      saved.map(({ role }) => role),
      ["user", "assistant"],
    );
    assert.doesNotMatch(JSON.stringify(saved), /迟到回答|迟到证据/u);
  },
);

test("C0 revoked evidence leaves both responder history and the actual read-only tool, while UI history keeps the record", async () => {
  using directory = mkdtempDisposableSync(join(tmpdir(), "doggie-c0-"));
  using db = openDatabase(join(directory.path, "fixture.db"));
  const store = new Store(db);
  const record = "报告校验指纹 synthetic-4807";
  const search = createMemoryHarnessTools(new MemoryTools(store.memory)).find(
    ({ name }) => name === "search_memory",
  );
  assert.ok(search);
  const seenHistory: string[][] = [];
  let archiveQuestions = false;
  const { chat, request, history } = setup(
    store,
    {
      ...fixtureModel,
      async classify(text) {
        return archiveQuestions
          ? askUser(undefined, undefined, 0.6, "需确认", "保存到哪里？")
          : fixtureModel.classify(text, []);
      },
    },
    {
      async respond({ history }) {
        seenHistory.push(history.map(({ content }) => content));
        const args = { query: "synthetic-4807" };
        return {
          assistantText: "合成检索回答",
          toolMessages: [
            {
              name: search.name,
              callId: "lookup",
              arguments: args,
              output: z.json().parse(await search.execute(args)),
            },
          ],
        };
      },
    },
  );
  const before = await chat(record);
  const id = before.archive.entry_id;
  assert.ok(id);
  const original = schemas.memoryQueryResponseSchema.parse(
    before.tool_messages[0]?.output,
  );
  assert.ok(
    original.evidence.some(
      (item) => item.entry_id === id && item.text === record,
    ),
  );
  const revoked = await request(`/api/entries/${id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.equal(
    schemas.revokeEntryResponseSchema.parse(await revoked.json()).entry_id,
    id,
  );

  archiveQuestions = true;
  const after = await chat("之前的报告校验指纹是什么？");
  const result = schemas.memoryQueryResponseSchema.parse(
    after.tool_messages[0]?.output,
  );
  assert.equal(result.total_entries, 0);
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(seenHistory.at(-1), ["之前的报告校验指纹是什么？"]);
  const ui = (await history()).messages;
  assert.ok(ui.some(({ content }) => content === record));
  const oldAssistant = ui.find(({ id }) => id === before.assistant_message.id);
  const details = z
    .object({ archive: schemas.archiveProjectionSchema })
    .parse(oldAssistant?.details);
  assert.equal(details.archive.archive_state, "revoked");
  assert.deepEqual(details.archive.memory_item_ids, []);
});
