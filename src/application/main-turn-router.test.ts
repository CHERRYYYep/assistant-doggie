import assert from "node:assert/strict";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LlmApiMode, resolveLlmEndpoint } from "../llm/config.ts";
import { mainTurnRouteContract } from "../llm/contracts.ts";
import { StructuredOutputAdapter } from "../llm/structured-output.ts";
import { askUser, createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { AgentStore } from "../storage/agents.ts";
import { ClarificationStore } from "../storage/clarifications.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { ArchiveRuntime, type MemoryModel } from "./archive-runtime.ts";
import { ChatService } from "./chat.ts";
import type {
  ChatResponderInput,
  MainTurnRouter,
  MainTurnRouterInput,
} from "./chat-types.ts";
import { ConversationContextService } from "./conversation-context.ts";
import { MainConversationService } from "./main-conversation.ts";
import { StructuredMainTurnRouter } from "./main-turn-router.ts";

function fakeResponse(mode: LlmApiMode, payload: unknown) {
  const jsonText = JSON.stringify(payload);
  return mode === LlmApiMode.Responses
    ? {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: jsonText }],
          },
        ],
      }
    : {
        choices: [
          {
            finish_reason: "stop",
            message: { content: jsonText },
          },
        ],
      };
}

for (const mode of [
  LlmApiMode.Responses,
  LlmApiMode.ChatCompletions,
] as const) {
  test(`StructuredMainTurnRouter (${mode}) routes natural todo, planning, and lookup with strict JSON schema`, async () => {
    const queue = [
      fakeResponse(mode, {
        intent: "archive",
        archive_text: "明天早上8点完成计网作业",
        reason: "用户记录了带有明确时间的个人作业待办",
      }),
      fakeResponse(mode, {
        intent: "answer",
        archive_text: null,
        reason: "学习计划请求，无需归档",
      }),
      fakeResponse(mode, {
        intent: "lookup",
        archive_text: null,
        reason: "查询明天个人日程安排",
      }),
    ];
    const adapter = new StructuredOutputAdapter(
      resolveLlmEndpoint({ apiMode: mode }),
      {
        async send() {
          const next = queue.shift();
          if (next === undefined) throw new Error("queue exhausted");
          return { body: next };
        },
      },
    );
    const router = new StructuredMainTurnRouter(adapter, "fake-router-model");

    const archiveDecision = await router.route({
      text: "明天早上8点完成计网作业",
      history: [],
      fallbackReason: "purpose",
    });
    assert.deepEqual(archiveDecision, {
      intent: "archive",
      archiveText: "明天早上8点完成计网作业",
      reason: "用户记录了带有明确时间的个人作业待办",
    });

    const answerDecision = await router.route({
      text: "帮我学习 Mutex，制定一个三天的学习计划",
      history: [],
      fallbackReason: "purpose",
    });
    assert.deepEqual(answerDecision, {
      intent: "answer",
      reason: "学习计划请求，无需归档",
    });

    const lookupDecision = await router.route({
      text: "明天早上8点我有什么安排",
      history: [],
      fallbackReason: "purpose",
    });
    assert.deepEqual(lookupDecision, {
      intent: "lookup",
      reason: "查询明天个人日程安排",
    });
  });
}

test("mainTurnRouteContract rejects unknown fields and empty archive_text on archive intent", () => {
  assert.throws(() =>
    mainTurnRouteContract.parse({
      intent: "archive",
      archive_text: "   ",
      reason: "missing text",
    }),
  );
  assert.throws(() =>
    mainTurnRouteContract.parse({
      intent: "answer",
      archive_text: null,
      reason: "ok",
      extra: true,
    }),
  );
});

test("ChatService with MainTurnRouter eliminates regex dead-ends while preserving confirmation, grounding and approval boundaries", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-router-"));
  using db = openDatabase(join(dir.path, "router.db"));
  const store = new Store(db);
  const archivedTexts: string[] = [];
  const responderCalls: ChatResponderInput[] = [];
  const routerCalls: MainTurnRouterInput[] = [];
  let forceAskUser = false;

  const model: MemoryModel = {
    modelName: "router-fixture-model",
    async classify(text) {
      archivedTexts.push(text);
      return forceAskUser
        ? askUser(
            BucketType.Task,
            "计网作业",
            0.55,
            "需要确认归档位置",
            "存到哪里？",
          )
        : createNew(BucketType.Task, "计网作业", 0.96, "明确个人待办");
    },
    async extract(text) {
      return minimalExtraction(text);
    },
  };

  const router: MainTurnRouter = {
    async route(input) {
      routerCalls.push(input);
      if (input.text === "明天早上8点完成计网作业") {
        return {
          intent: "archive",
          archiveText: "明天早上8点完成计网作业",
          reason: "明确待办",
        };
      }
      if (input.text === "明天早上8点完成计网作业 存下来") {
        return {
          intent: "archive",
          archiveText: "明天早上8点完成计网作业",
          reason: "带保存指令的待办",
        };
      }
      if (input.text === "存下来") {
        const previous = [...input.history]
          .reverse()
          .find((m) => m.role === "user");
        return {
          intent: "archive",
          archiveText: previous?.content ?? "编造内容",
          reason: "保存上一条用户内容",
        };
      }
      if (input.text === "明天早上8点我有什么安排") {
        return { intent: "lookup", reason: "查询个人待办" };
      }
      if (input.text === "触发路由器故障") {
        throw new Error("router timeout");
      }
      return { intent: "answer", reason: "通用交流或规划" };
    },
  };

  const service = new ChatService(
    store,
    new ArchiveRuntime(store, model),
    {
      async respond(input) {
        responderCalls.push(input);
        if (input.archive !== null) {
          return { assistantText: "已为你记下明天早上 8 点完成计网作业。" };
        }
        if (input.purpose === "lookup") {
          return { assistantText: "你明天早上 8 点有计网作业待办。" };
        }
        return { assistantText: `自然直答：${input.sourceText}` };
      },
    },
    router,
  );

  // 1. Empty-history "存下来" must be server-blocked from archiving fabricated text
  const emptySave = await service.mainChat({ text: "存下来" });
  assert.equal(emptySave.purpose.kind, "answer");
  assert.equal("archive" in emptySave, false);
  assert.equal(archivedTexts.length, 0);
  assert.match(emptySave.assistantMessage.content, /自然直答：存下来/u);

  // 2. General planning statement goes straight to LLM answer, zero writes
  const plan = await service.mainChat({
    text: "帮我学习 Mutex，制定一个三天的学习计划",
  });
  assert.equal(plan.purpose.kind, "answer");
  assert.equal("archive" in plan, false);
  assert.equal(archivedTexts.length, 0);
  assert.match(plan.assistantMessage.content, /自然直答：帮我学习 Mutex/u);

  // 3. Natural todo statement ("明天早上8点完成计网作业") routes cleanly to ArchiveRuntime
  const todoTurn = await service.mainChat({ text: "明天早上8点完成计网作业" });
  assert.equal(todoTurn.purpose.kind, "archive");
  assert.ok("archive" in todoTurn);
  assert.equal(todoTurn.archive.archive_state, "archived");
  assert.equal(
    todoTurn.assistantMessage.content,
    "已为你记下明天早上 8 点完成计网作业。",
  );
  assert.deepEqual(archivedTexts, ["明天早上8点完成计网作业"]);

  // 4. Trailing save ("明天早上8点完成计网作业 存下来") with confirmation gate binds clean archiveText
  forceAskUser = true;
  const trailingSave = await service.mainChat({
    text: "明天早上8点完成计网作业 存下来",
  });
  assert.equal(trailingSave.purpose.kind, "archive");
  assert.ok("archive" in trailingSave);
  assert.equal(trailingSave.archive.archive_state, "needs_confirmation");
  assert.equal(
    trailingSave.userMessage.content,
    "明天早上8点完成计网作业 存下来",
  );
  assert.equal(
    Reflect.get(trailingSave.assistantMessage.details as object, "source_text"),
    "明天早上8点完成计网作业",
  );
  const confirmed = await service.confirmChat({
    action: "create",
    title: "计网作业确认桶",
    bucketType: BucketType.Task,
    rawText: "明天早上8点完成计网作业",
    attemptId: trailingSave.archive.attempt_id,
  });
  assert.equal(confirmed.archive.archive_state, "archived");

  // 5. Two-turn "存下来" after a real prior user message succeeds through ArchiveRuntime
  forceAskUser = false;
  const followSave = await service.mainChat({ text: "存下来" });
  assert.equal(followSave.purpose.kind, "archive");
  assert.ok("archive" in followSave);
  assert.equal(followSave.archive.archive_state, "archived");

  // 6. Lookup routes cleanly to read-only lookup responder
  const lookup = await service.mainChat({ text: "明天早上8点我有什么安排" });
  assert.equal(lookup.purpose.kind, "lookup");
  assert.equal(
    lookup.assistantMessage.content,
    "你明天早上 8 点有计网作业待办。",
  );

  // 7. Bare approvals ("好", "批准", "执行吧", "保存吧") NEVER invoke turnRouter or archive
  const routerCallsBeforeApproval = routerCalls.length;
  const archivesBeforeApproval = archivedTexts.length;
  for (const bare of ["好", "批准", "执行吧", "保存吧"]) {
    const turn = await service.mainChat({ text: bare });
    assert.equal(turn.purpose.kind, "answer");
    assert.equal("archive" in turn, false);
  }
  assert.equal(routerCalls.length, routerCallsBeforeApproval);
  assert.equal(archivedTexts.length, archivesBeforeApproval);

  // 8. Router transport failure fails closed on writes and degrades to read-only answer
  const failedRouter = await service.mainChat({ text: "触发路由器故障" });
  assert.equal(failedRouter.purpose.kind, "answer");
  assert.equal("archive" in failedRouter, false);
  assert.equal(archivedTexts.length, archivesBeforeApproval);
  assert.match(
    failedRouter.assistantMessage.content,
    /自然直答：触发路由器故障/u,
  );
  assert.deepEqual(new WorkItemStore(db).list(), []);
  assert.deepEqual(new AgentStore(db).tasks(), []);
});

test("MainConversationService natural utterance uses MainTurnRouter for natural todos and general chat", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-mc-router-"));
  using db = openDatabase(join(dir.path, "mc.db"));
  const store = new Store(db);
  const model: MemoryModel = {
    modelName: "mc-router-fixture",
    async classify() {
      return createNew(BucketType.Task, "计网作业", 0.95, "明确待办");
    },
    async extract(text) {
      return minimalExtraction(text);
    },
  };
  const chatService = new ChatService(
    store,
    new ArchiveRuntime(store, model),
    {
      async respond(input) {
        return {
          assistantText:
            input.archive !== null
              ? "已帮你记下明天早上 8 点的计网作业。"
              : `已回答：${input.sourceText}`,
        };
      },
    },
    {
      async route(input) {
        return input.text.includes("计网作业")
          ? {
              intent: "archive",
              archiveText: input.text,
              reason: "个人待办",
            }
          : { intent: "answer", reason: "普通聊天" };
      },
    },
  );
  const conversation = new MainConversationService(
    new ClarificationStore(db, store.conversation),
    new WorkItemStore(db),
    chatService,
    new ConversationContextService(store),
  );

  const todoReceipt = await conversation.turn({
    requestId: crypto.randomUUID(),
    action: "utterance",
    text: "明天早上8点完成计网作业",
  });
  assert.equal(todoReceipt.kind, "archive");
  assert.equal(store.listBuckets().length, 1);

  const chatReceipt = await conversation.turn({
    requestId: crypto.randomUUID(),
    action: "utterance",
    text: "帮我学习 Mutex，制定一个三天的学习计划",
  });
  assert.equal(chatReceipt.kind, "answer");
  assert.equal(store.listBuckets().length, 1);
});
