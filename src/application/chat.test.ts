import assert from "node:assert/strict";
import { test } from "node:test";

import { askUser, createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { ArchiveRuntime, type MemoryModel } from "./archive-runtime.ts";
import { ChatService } from "./chat.ts";
import type { ChatResponder } from "./chat-types.ts";

function setup(
  store: Store,
  overrides: Partial<MemoryModel>,
  responder?: ChatResponder,
) {
  return new ChatService(
    store,
    new ArchiveRuntime(store, {
      modelName: "chat-test",
      async classify() {
        return createNew(BucketType.Task, "测试目标", 0.99, "明确事实");
      },
      async extract() {
        return minimalExtraction("测试事实");
      },
      ...overrides,
    }),
    responder,
  );
}

test("two concurrent turns only see their own bounded history and retain source links", async () => {
  using db = openDatabase(":memory:");
  const store = new Store(db);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstText = "第一个服务修复后通过检查 100%";
  const secondText = "另一个服务也通过检查 100%";
  const seen: string[][] = [];
  const chat = setup(
    store,
    {
      async classify(text) {
        if (text === firstText) {
          started.resolve();
          await release.promise;
        }
        return createNew(BucketType.Task, text, 0.99, "明确事实");
      },
    },
    {
      async respond({ sourceText, history }) {
        seen.push(history.map(({ content }) => content));
        return { assistantText: `回复：${sourceText}` };
      },
    },
  );
  const first = chat.chat({ text: firstText });
  await started.promise;
  const second = chat.chat({ text: secondText });
  // Give the second call a chance to progress even on an implementation that
  // does not serialize the two requests.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const whileWaiting = store.listChatMessages(10).map(({ content }) => content);
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(whileWaiting, [firstText]);
  assert.deepEqual(seen, [
    [firstText],
    [firstText, a.assistantMessage.content, secondText],
  ]);
  for (const turn of [a, b]) {
    assert.equal(
      (turn.assistantMessage.details as { source_message_id?: string })
        .source_message_id,
      turn.userMessage.id,
    );
  }
});

test("cancelling a waiter never saves it and an active turn failure releases the FIFO", async () => {
  using db = openDatabase(":memory:");
  const store = new Store(db);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstText = "页面 A 的请求";
  const classified: string[] = [];
  const chat = setup(store, {
    async classify(text) {
      classified.push(text);
      if (text === firstText) {
        started.resolve();
        await release.promise;
        throw new Error("internal error with private details");
      }
      return askUser(undefined, undefined, 0.5, "测试澄清", "保存到哪里？");
    },
  });
  const first = chat.chat({ text: firstText });
  const failed = assert.rejects(first, {
    name: "ChatFailure",
    message: "internal server error",
  });
  await started.promise;
  const cancel = new AbortController();
  const waiting = chat.chat({ text: "取消等待的输入" }, cancel.signal);
  const waitingCancelled = assert.rejects(waiting, { name: "AbortError" });
  const next = chat.chat({ text: "接下来的一轮" });
  cancel.abort("caller private reason");
  release.resolve();
  await Promise.all([failed, waitingCancelled]);
  await next;
  assert.deepEqual(classified, [firstText, "接下来的一轮"]);
  assert.equal(
    store
      .listChatMessages(20)
      .some(({ content }) => content === "取消等待的输入"),
    false,
  );
  assert.equal(store.listChatMessages(20).length, 4);
});

test("confirmation waits behind an active chat and records its own user link", async () => {
  using db = openDatabase(":memory:");
  const store = new Store(db);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const firstText = "请暂时保留这条模糊的记录";
  const nextText = "新一轮等候模型回复的记录";
  const chat = setup(
    store,
    {
      async classify() {
        return askUser(undefined, undefined, 0.5, "测试确认", "保存到哪里？");
      },
    },
    {
      async respond({ sourceText }) {
        if (sourceText === nextText) {
          started.resolve();
          await release.promise;
        }
        return { assistantText: "模型输出不能覆盖确认提示" };
      },
    },
  );
  const first = await chat.chat({ text: firstText });
  assert.notEqual(first.assistantMessage.content, "模型输出不能覆盖确认提示");
  const next = chat.chat({ text: nextText });
  await started.promise;
  const confirmation = chat.confirmChat({
    action: "discard",
    rawText: firstText,
    attemptId: first.archive.attempt_id,
  });
  const previousLast = store.listChatMessages(10).at(-1)?.content;
  release.resolve();
  const [response, confirmed] = await Promise.all([next, confirmation]);
  assert.equal(previousLast, nextText);
  assert.equal(confirmed.archive.archive_state, "discarded");
  assert.equal(
    confirmed.userMessage.sequence,
    response.assistantMessage.sequence + 1,
  );
  assert.equal(
    (confirmed.assistantMessage.details as { source_message_id?: string })
      .source_message_id,
    confirmed.userMessage.id,
  );
});

test("terminal reply failure rolls back tool records but not accepted input and archived evidence", async () => {
  using db = openDatabase(":memory:");
  const store = new Store(db);
  db.exec(`
    CREATE TRIGGER fail_test_reply BEFORE INSERT ON conversation_messages
    WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test reply failure'); END;
  `);
  const chat = setup(
    store,
    {},
    {
      async respond() {
        return {
          assistantText: "最终回复",
          toolMessages: [
            {
              name: "search_memory",
              callId: "evidence",
              arguments: {},
              output: {},
            },
          ],
        };
      },
    },
  );
  await assert.rejects(
    chat.chat({ text: "已确认故障恢复并通过验证 100%" }),
    /test reply failure/u,
  );
  assert.deepEqual(
    store.listChatMessages(10).map(({ role }) => role),
    ["user"],
  );
  assert.equal(store.listBuckets().length, 1);
});
