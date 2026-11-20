import assert from "node:assert/strict";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  mainConversationCases,
  networkLab,
} from "../../tests/fixtures/main-conversation-cases.ts";
import { askUser, createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { AgentStore } from "../storage/agents.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { TaskStore } from "../storage/tasks.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { ArchiveRuntime, type MemoryModel } from "./archive-runtime.ts";
import { ChatService } from "./chat.ts";
import type { ChatResponder, ChatResponderInput } from "./chat-types.ts";

function fixture(store: Store, responder: ChatResponder, gateArchive = false) {
  const archiveCalls: string[] = [];
  const model: MemoryModel = {
    modelName: "c1-fixture",
    async classify(text) {
      archiveCalls.push(`classify:${text}`);
      return gateArchive && text.startsWith("记录一下")
        ? askUser(undefined, undefined, 0.55, "待确认", "保存到哪里？")
        : createNew(BucketType.Task, "报告", 0.99, "明确记录");
    },
    async extract(text) {
      archiveCalls.push(`extract:${text}`);
      return minimalExtraction(text);
    },
  };
  return {
    service: new ChatService(
      store,
      new ArchiveRuntime(store, model),
      responder,
    ),
    archiveCalls,
  };
}

test("C1 routed chat reuses the legacy archive and never treats goal prompts, questions, edits or '好' as approval", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c1-"));
  using db = openDatabase(join(dir.path, "fixture.db"));
  const store = new Store(db);
  const seen: ChatResponderInput[] = [];
  const { service, archiveCalls } = fixture(
    store,
    {
      async respond(input) {
        seen.push(input);
        return {
          assistantText:
            input.purpose === "lookup" ? "找不到有效记录" : "合成直答",
          ...(input.purpose === "answer"
            ? {
                toolMessages: [
                  {
                    name: "search_memory",
                    callId: "unexpected",
                    arguments: {},
                    output: "不应出现在历史",
                  },
                ],
              }
            : {}),
        };
      },
    },
    true,
  );
  const archiveText = "记录一下：报告待归档 42%";
  const archive = await service.mainChat({ text: archiveText });
  assert.equal(archive.purpose.kind, "archive");
  assert.ok("archive" in archive);
  assert.equal(archive.archive.archive_state, "needs_confirmation");
  assert.match(archive.assistantMessage.content, /不保存/u);
  const pending = archive.archive.attempt_id;

  const clear = mainConversationCases.find(({ stage }) => stage === "C1");
  assert.ok(clear);
  for (const step of clear.steps) {
    assert.ok("text" in step.input);
    const turn = await service.mainChat({ text: step.input.text });
    assert.equal(turn.purpose.kind, "answer");
    assert.equal(turn.assistantMessage.content, "合成直答");
    assert.deepEqual(turn.toolMessages, []);
    assert.equal("archive" in turn, false);
  }
  const lookup = await service.mainChat({ text: "上次发布审批是什么时候？" });
  assert.equal(lookup.purpose.kind, "lookup");
  assert.equal(lookup.assistantMessage.content, "找不到有效记录");
  assert.deepEqual(
    seen.map(({ purpose }) => purpose),
    [undefined, "answer", "answer", "lookup"],
  );
  assert.ok(seen.slice(1).every(({ archive }) => archive === null));

  for (const [text, expected] of [
    [networkLab.request, "clarify"],
    [networkLab.supplement, "clarify"],
    ["好", "clarify"],
    ["只读检查 TCP 抓包报告", "propose_execution"],
  ] as const) {
    const turn = await service.mainChat({ text });
    assert.equal(turn.purpose.kind, expected);
    assert.equal("archive" in turn, false);
    assert.equal(turn.messages.length, 2);
  }
  assert.deepEqual(archiveCalls, [`classify:${archiveText}`]);
  assert.equal(seen.length, 4);
  assert.doesNotMatch(
    JSON.stringify(store.listChatMessages(40)),
    /不应出现在历史/u,
  );
  assert.deepEqual(store.listBuckets(), []);
  assert.deepEqual(new WorkItemStore(db).list(), []);
  assert.deepEqual(new AgentStore(db).tasks(), []);
  assert.deepEqual(new TaskStore(db).list(), []);
  assert.deepEqual(
    db
      .prepare("SELECT kind,status FROM pending_actions")
      .all()
      .map((row) => Object.fromEntries(Object.entries(row))),
    [{ kind: "archive", status: "pending" }],
  );

  const confirmation = await service.confirmChat({
    action: "discard",
    rawText: archiveText,
    attemptId: pending,
  });
  assert.equal(confirmation.archive.archive_state, "discarded");
  const solid = "工作记录：接口 p99 降至 31ms";
  const committed = await service.mainChat({ text: solid });
  assert.ok("archive" in committed);
  assert.equal(committed.archive.archive_state, "archived");
  assert.deepEqual(archiveCalls, [
    `classify:${archiveText}`,
    `classify:${solid}`,
    `extract:${solid}`,
  ]);
});

test("N0 transforms supplied text, asks only for missing material, and never treats saving shorthand as approval", async () => {
  using db = openDatabase(":memory:");
  const store = new Store(db);
  const seen: ChatResponderInput[] = [];
  const { service, archiveCalls } = fixture(store, {
    async respond(input) {
      seen.push(input);
      return { assistantText: "合成报告表述" };
    },
  });
  const source =
    "原文：客户端先发 SYN，服务端回复 SYN-ACK。请改写成简洁实验报告。";
  const answer = await service.mainChat({ text: source });
  assert.equal(answer.purpose.kind, "answer");
  assert.equal(answer.assistantMessage.content, "合成报告表述");
  assert.equal(seen[0]?.history.at(-1)?.content, source);
  assert.equal(seen[0]?.archive, null);
  assert.equal(seen[0]?.purpose, "answer");

  const missing = await service.mainChat({
    text: "请改写成简洁实验报告。原文：",
  });
  assert.match(missing.assistantMessage.content, /请贴出要处理的原文/u);
  const save = await service.mainChat({ text: "存下来" });
  assert.match(save.assistantMessage.content, /哪段内容/u);
  assert.doesNotMatch(save.assistantMessage.content, /回答问题、查找记录/u);
  assert.equal(seen.length, 1);
  assert.deepEqual(archiveCalls, []);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM pending_actions").get()?.["n"],
    0,
  );
  assert.deepEqual(new WorkItemStore(db).list(), []);
  assert.deepEqual(new AgentStore(db).tasks(), []);
});

for (const interrupt of ["cancel", "revoke"] as const) {
  test(
    `C1 ${interrupt} while looking up suppresses the late reply and releases the shared turn coordinator`,
    { timeout: 5000 },
    async () => {
      using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c1-"));
      using db = openDatabase(join(dir.path, "fixture.db"));
      const store = new Store(db);
      const started = Promise.withResolvers<void>();
      const unblocked = Promise.withResolvers<void>();
      const { service } = fixture(store, {
        async respond(input) {
          if (input.purpose !== "lookup") return { assistantText: "next" };
          started.resolve();
          await unblocked.promise;
          return {
            assistantText: "过期证据",
            toolMessages: [
              {
                name: "search_memory",
                callId: "late",
                arguments: {},
                output: "过期证据",
              },
            ],
          };
        },
      });
      const seeded = await service.chat({ text: "报告校验数据 42%" });
      assert.ok(seeded.archive.entry_id);
      const abort = new AbortController();
      const lookupText = "查一下上次的报告校验记录";
      const pending = service.mainChat({ text: lookupText }, abort.signal);
      const observed =
        interrupt === "cancel"
          ? assert.rejects(pending, { name: "AbortError" })
          : pending;
      await started.promise;
      const next = service.chat({ text: "另一份报告数据 100%" });
      try {
        assert.equal(store.listChatMessages(10).at(-1)?.content, lookupText);
        if (interrupt === "cancel") abort.abort();
        else store.deleteEntry(seeded.archive.entry_id, "测试撤销");
      } finally {
        unblocked.resolve();
      }
      const result = await observed;
      if (result !== undefined) {
        assert.match(result.assistantMessage.content, /记忆已更新/u);
        assert.deepEqual(result.toolMessages, []);
      }
      const legacy = await next;
      assert.equal(legacy.assistantMessage.content, "next");
      const saved = store.listChatMessages(20);
      assert.doesNotMatch(JSON.stringify(saved), /过期证据/u);
      if (interrupt === "cancel") {
        const accepted = saved.find(({ content }) => content === lookupText);
        assert.ok(accepted);
        assert.equal(legacy.userMessage.sequence, accepted.sequence + 1);
      }
    },
  );
}
