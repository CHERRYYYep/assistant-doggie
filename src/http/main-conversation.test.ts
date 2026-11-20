import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempDisposableSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { z } from "zod";
import { networkLab } from "../../tests/fixtures/main-conversation-cases.ts";
import { ArchiveRuntime } from "../application/archive-runtime.ts";
import { ChatService } from "../application/chat.ts";
import {
  ConversationContextService,
  type GroundedInput,
  type GroundedResponder,
} from "../application/conversation-context.ts";
import { MainConversationService } from "../application/main-conversation.ts";
import {
  describeCreatedGoal,
  describeUpdatedGoal,
} from "../application/work-items.ts";
import { askUser, createNew } from "../domain/classification.ts";
import type { ConversationTurn } from "../domain/main-conversation.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import type { SourceReference } from "../domain/work-item.ts";
import { ClarificationStore } from "../storage/clarifications.ts";
import { STALE_CONTEXT_MESSAGE } from "../storage/conversation.ts";
import { openDatabase, readSchemaVersion } from "../storage/database.ts";
import { MIGRATIONS, SCHEMA_KIND, SCHEMA_VERSION } from "../storage/schema.ts";
import { Store } from "../storage/store.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { ConcreteDoggieHttpApi } from "./api.ts";
import { createDoggieApp } from "./app.ts";
import {
  clarificationListResponseSchema,
  conversationTurnResponseSchema,
  chatHistoryResponseSchema,
} from "./response-schemas.ts";
import { createDoggieNodeServer } from "./server.ts";

const message = (text: string = networkLab.request): ConversationTurn => ({
  action: "message",
  text,
  requestId: randomUUID(),
});
const confirmationText = "记一下：发布前还有一项测试要确认";
function fixture(db: DatabaseSync, grounded?: GroundedResponder) {
  const store = new Store(db);
  const items = new WorkItemStore(db);
  const responderHistory: string[][] = [];
  let classified = 0;
  const archive = new ArchiveRuntime(store, {
    modelName: "fake-c2",
    async classify(text, candidates) {
      classified++;
      return text.includes("确认")
        ? askUser(
            BucketType.Task,
            undefined,
            0.6,
            "需确认",
            "保存到哪里？",
            candidates.map(({ id }) => id),
          )
        : createNew(BucketType.Task, "测试记录", 0.99, "合成记录");
    },
    async extract(text) {
      return minimalExtraction(text);
    },
  });
  const chatService = new ChatService(store, archive, {
    async respond({ history }) {
      responderHistory.push(history.map(({ content }) => content));
      return { assistantText: "合成答复" };
    },
  });
  const service = new MainConversationService(
    new ClarificationStore(db, store.conversation),
    items,
    chatService,
    grounded === undefined
      ? undefined
      : new ConversationContextService(store, grounded),
  );
  const api = new ConcreteDoggieHttpApi(store, archive, { chatService });
  const app = createDoggieApp(
    api,
    [],
    [],
    undefined,
    undefined,
    undefined,
    service,
  );
  const goal = (
    title: string,
    sources: SourceReference[] = [],
    acceptance = title,
  ) =>
    items.create(
      {
        requestId: randomUUID(),
        title,
        goal: title,
        acceptance,
        sources,
      },
      describeCreatedGoal,
    );
  const request = (path: string, body?: unknown) =>
    app.request(
      "http://localhost" + path,
      body === undefined
        ? { headers: { Host: "localhost" } }
        : {
            method: "POST",
            headers: { Host: "localhost", "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
  const post = (turn: unknown) => request("/api/conversation/turns", turn);
  const turn = async (input: ConversationTurn) => {
    const response = await post(input);
    const body: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return conversationTurnResponseSchema.parse(body).result;
  };
  const getCards = async () => {
    const response = await request("/api/conversation/clarifications");
    assert.equal(response.status, 200);
    return clarificationListResponseSchema.parse(await response.json())
      .clarifications;
  };
  const count = (
    table:
      | "entries"
      | "agent_tasks"
      | "conversation_requests"
      | "conversation_messages",
  ) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"];
  return {
    store,
    items,
    goal,
    service,
    api,
    request,
    responderHistory,
    classified: () => classified,
    turn,
    getCards,
    post,
    count,
  };
}

async function firstCard(
  f: ReturnType<typeof fixture>,
  text: string = networkLab.request,
) {
  const opened = await f.turn(message(text));
  assert.equal(opened.kind, "clarification");
  const view = (await f.getCards()).find(
    ({ id }) => id === opened.clarificationId,
  );
  assert.ok(view);
  assert.equal(view.originalMessageId, opened.userMessageId);
  return view;
}

test("N0 preview answers supplied rewrites and asks for missing text without writing business state", async () => {
  using tmp = mkdtempDisposableSync(join(tmpdir(), "doggie-n0-"));
  using db = openDatabase(join(tmp.path, "test.db"));
  const f = fixture(db);
  const text =
    "原文：客户端先发 SYN，服务端回复 SYN-ACK。请改写成简洁实验报告。";
  const draft = await f.turn(message(text));
  assert.equal(draft.kind, "answer");
  assert.deepEqual(f.responderHistory, [[text]]);
  const missing = await f.turn(message("请改写成简洁实验报告。原文："));
  assert.equal(missing.kind, "clarify");
  const save = await f.turn(message("存下来"));
  assert.equal(save.kind, "clarify");
  const history = f.store.conversation.listChatMessages(10);
  assert.match(
    history.find(({ id }) => id === missing.assistantMessageId)?.content ?? "",
    /请贴出要处理的原文/u,
  );
  assert.match(
    history.find(({ id }) => id === save.assistantMessageId)?.content ?? "",
    /哪段内容/u,
  );
  assert.deepEqual(await f.getCards(), []);
  assert.equal(f.classified(), 0);
  assert.equal(f.count("entries"), 0);
  assert.equal(f.count("agent_tasks"), 0);
  assert.deepEqual(f.items.list(), []);
});

test("C2 same-bucket TCP/UDP, interlude, database reopen and explicit supplement preserve the original request", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c2-"));
  const path = join(dir.path, "test.db");
  let cardId = "";
  let tcpId = "";
  {
    using db = openDatabase(path);
    const f = fixture(db);
    const { bucketId } = f.store.archive(
      "同主题的背景",
      createNew(BucketType.Experiment, networkLab.bucket, 1, "测试"),
      minimalExtraction("背景"),
      { modelName: "fake", promptVersion: "test", candidateBucketIds: [] },
    );
    assert.ok(bucketId);
    const source = { kind: "bucket", id: bucketId } as const;
    const tcp = f.goal(networkLab.tcp, [source]);
    const udp = f.goal(networkLab.udp, [source]);
    tcpId = tcp.id;
    const card = await firstCard(f);
    cardId = card.id;
    assert.equal(card.status, "pending");
    assert.equal(card.selected, null);
    assert.deepEqual(
      new Set(card.candidates.map(({ id }) => id)),
      new Set([tcp.id, udp.id]),
    );
    assert.equal((await f.turn(message(networkLab.question))).kind, "answer");
    assert.deepEqual(f.responderHistory, [[networkLab.question]]);
    assert.equal(f.classified(), 0);
    assert.equal((await f.getCards())[0]?.revision, 1);
  }
  {
    using db = openDatabase(path);
    const f = fixture(db);
    const [card] = await f.getCards();
    assert.ok(card);
    assert.equal(card.id, cardId);
    assert.equal(card.originalText, networkLab.request);
    assert.equal(card.revision, 1);
    const reply = await f.turn({
      action: "reply",
      requestId: randomUUID(),
      clarificationId: cardId,
      expectedRevision: 1,
      text: networkLab.supplement,
    });
    const [resolved] = await f.getCards();
    assert.equal(resolved?.selected?.id, tcpId);
    assert.equal(resolved?.latestReply, networkLab.supplement);
    assert.equal(resolved?.revision, 2);
    const detailsSchema = z.looseObject({
      reply_to_message_id: z.string(),
      kind: z.string(),
    });
    const row = f.store.conversation
      .listChatMessages(40)
      .find(({ id }) => id === reply.userMessageId);
    assert.equal(
      detailsSchema.parse(row?.details).reply_to_message_id,
      card.originalMessageId,
    );
    await f.turn({
      action: "reply",
      requestId: randomUUID(),
      clarificationId: cardId,
      expectedRevision: 2,
      text: "不要修改其他章节",
    });
    assert.equal((await f.getCards())[0]?.latestReply, "不要修改其他章节");
    assert.equal(
      f.store.conversation
        .listChatMessages(40)
        .filter(
          ({ details }) =>
            detailsSchema.safeParse(details).data?.reply_to_message_id ===
              card.originalMessageId &&
            detailsSchema.safeParse(details).data?.kind ===
              "task_clarification_reply",
        ).length,
      2,
    );
    assert.equal(f.count("entries"), 1);
    assert.equal(f.count("agent_tasks"), 0);
    assert.equal(f.classified(), 0);
  }
});

test("C2 no arbitrary title-substring binding, no duplicate-title or lone weak automatic selection", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const weak = f.goal("计算机网络课堂笔记");
  const suggestion = await firstCard(f);
  assert.deepEqual(
    suggestion.candidates.map(({ id }) => id),
    [weak.id],
  );
  await f.turn({
    action: "reply",
    requestId: randomUUID(),
    clarificationId: suggestion.id,
    expectedRevision: 1,
    text: "不是这个，是实验报告",
  });
  const rejected = (await f.getCards()).find(({ id }) => id === suggestion.id);
  assert.equal(rejected?.status, "pending");
  assert.equal(rejected?.candidates.length, 0);
  const tcp = f.goal(networkLab.tcp);
  const noCandidate = await firstCard(f, "修改那个数据库实验");
  assert.equal(noCandidate.candidates.length, 0);
  await f.turn({
    action: "reply",
    requestId: randomUUID(),
    clarificationId: noCandidate.id,
    expectedRevision: 1,
    text: `「${tcp.title}」，只改报告`,
  });
  assert.equal(
    (await f.getCards()).find(({ id }) => id === noCandidate.id)?.selected?.id,
    tcp.id,
  );
  assert.equal(
    (await firstCard(f, `修改「${tcp.title}」`)).selected?.id,
    tcp.id,
  );
  assert.equal(
    (await firstCard(f, `修改与「${tcp.title}」无关的实验`)).selected,
    null,
  );
  const duplicate = f.goal(tcp.title, [], "只处理附录");
  const ambiguous = await firstCard(f, `修改${tcp.title}`);
  assert.equal(ambiguous.selected, null);
  assert.deepEqual(
    new Set(ambiguous.candidates.map(({ id }) => id)),
    new Set([tcp.id, duplicate.id]),
  );
  await f.turn({
    action: "reply",
    requestId: randomUUID(),
    clarificationId: ambiguous.id,
    expectedRevision: 1,
    text: tcp.title,
  });
  assert.equal(
    (await f.getCards()).find(({ id }) => id === ambiguous.id)?.status,
    "pending",
  );
  await f.turn({
    action: "none",
    requestId: randomUUID(),
    clarificationId: ambiguous.id,
    expectedRevision: 2,
  });
  assert.equal(
    (await f.getCards()).find(({ id }) => id === ambiguous.id)?.candidates
      .length,
    0,
  );
  assert.equal(
    (await f.turn(message("把「服务已经恢复」改写成正式说明。"))).kind,
    "answer",
  );
  assert.equal(f.count("entries"), 0);
});

test("C2 real loopback routes reject approval fields and serialize concurrent choices and replays", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const tcp = f.goal(networkLab.tcp);
  const udp = f.goal(networkLab.udp);
  const card = await firstCard(f);
  const other = await firstCard(f, "改那个数据库实验");
  const server = createDoggieNodeServer(f.api, {
    assets: [],
    conversation: f.service,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/conversation/turns`;
  const post = async (payload: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return {
      status: response.status,
      result: (await response.json()) as unknown,
    };
  };
  try {
    assert.equal((await post({ ...message(), approve: true })).status, 400);
    const select = {
      action: "select",
      requestId: randomUUID(),
      clarificationId: card.id,
      expectedRevision: 1,
      workItemId: tcp.id,
    };
    const [a, replay] = await Promise.all([post(select), post(select)]);
    assert.equal(a.status, 200);
    assert.deepEqual(replay, a);
    const changed = { ...select, workItemId: udp.id };
    assert.equal((await post(changed)).status, 409);
    assert.equal(
      (await post({ ...changed, requestId: randomUUID() })).status,
      409,
    );
    assert.equal(
      (
        await post({
          ...select,
          requestId: randomUUID(),
          clarificationId: randomUUID(),
        })
      ).status,
      404,
    );
    assert.equal(f.count("conversation_requests"), 3);
    assert.equal(f.count("conversation_messages"), 8);
    const cards = await f.getCards();
    assert.equal(cards.find(({ id }) => id === card.id)?.selected?.id, tcp.id);
    await f.turn({
      action: "cancel",
      requestId: randomUUID(),
      clarificationId: card.id,
      expectedRevision: 2,
    });
    assert.equal(
      (await f.getCards()).find(({ id }) => id === other.id)?.status,
      "pending",
    );
    assert.equal(
      (await f.getCards()).find(({ id }) => id === card.id)?.status,
      "cancelled",
    );
    assert.equal(f.count("agent_tasks"), 0);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

test("C2 scope updates, closed goals and revoked sources cannot bind or show stale targets", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const { entryId } = f.store.archive(
    "待撤销",
    createNew(BucketType.Experiment, "网络", 1, "测试"),
    minimalExtraction("待撤销"),
    { modelName: "fake", promptVersion: "test", candidateBucketIds: [] },
  );
  assert.ok(entryId);
  const udp = f.goal(networkLab.udp, [{ kind: "entry", id: entryId }]);
  // Extra source rows must not hide an invalid source beyond an arbitrary read cap.
  const extraBuckets = Array.from(
    { length: 18 },
    (_, i) =>
      f.store.archive(
        `合成来源 ${i}`,
        createNew(BucketType.Experiment, `合成来源 ${i}`, 1, "测试"),
        minimalExtraction(`合成来源 ${i}`),
        { modelName: "fake", promptVersion: "test", candidateBucketIds: [] },
      ).bucketId,
  );
  for (const id of extraBuckets) {
    assert.ok(id);
    db.prepare("INSERT INTO work_item_sources VALUES (?,'bucket',?)").run(
      udp.id,
      id,
    );
  }
  const udpCard = await firstCard(f, `修改${udp.title}`);
  const tcp = f.goal(networkLab.tcp);
  const pending = await firstCard(f);
  assert.equal(pending.candidates.length, 2);
  f.items.update(
    tcp.id,
    {
      expectedRevision: tcp.revision,
      title: tcp.title,
      goal: "范围修改",
      acceptance: tcp.acceptance,
    },
    describeUpdatedGoal,
  );
  const consume = (id: string, workItemId: string) =>
    f.post({
      action: "select",
      requestId: randomUUID(),
      clarificationId: id,
      expectedRevision: 1,
      workItemId,
    });
  assert.equal((await consume(pending.id, tcp.id)).status, 409);
  f.store.deleteEntry(entryId, "撤销合成来源");
  let cards = await f.getCards();
  assert.equal(cards.find(({ id }) => id === udpCard.id)?.status, "stale");
  assert.equal(cards.find(({ id }) => id === udpCard.id)?.selected, null);
  assert.deepEqual(cards.find(({ id }) => id === pending.id)?.candidates, []);
  assert.equal(
    (
      await f.post({
        action: "reply",
        text: "仍旧是这条",
        requestId: randomUUID(),
        clarificationId: udpCard.id,
        expectedRevision: 1,
      })
    ).status,
    409,
  );
  await f.turn({
    action: "cancel",
    requestId: randomUUID(),
    clarificationId: pending.id,
    expectedRevision: 1,
  });
  cards = await f.getCards();
  assert.equal(cards.find(({ id }) => id === pending.id)?.status, "cancelled");
  assert.equal((await firstCard(f, `修改${udp.title}`)).selected, null);
  const currentTcp = f.items.get(tcp.id);
  const tcpCard = await firstCard(f, `修改${tcp.title}`);
  const closedTcp = f.items.transition(tcp.id, {
    expectedRevision: currentTcp.revision,
    action: "complete",
  });
  assert.equal((await firstCard(f, `修改${tcp.title}`)).selected, null);
  f.items.transition(tcp.id, {
    expectedRevision: closedTcp.revision,
    action: "reopen",
  });
  assert.equal(
    (await f.getCards()).find(({ id }) => id === tcpCard.id)?.status,
    "stale",
  );

  assert.equal(f.count("agent_tasks"), 0);
});

test("C2 transaction failure rolls back card, messages and request reservation; explicit legacy confirmation stays separate", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const input = message();
  db.exec(
    `CREATE TRIGGER fixture_fail_receipt BEFORE UPDATE ON conversation_requests BEGIN SELECT RAISE(ABORT, 'fixture failed'); END`,
  );
  assert.equal((await f.post(input)).status, 500);
  assert.equal(f.count("conversation_messages"), 0);
  assert.equal(f.count("conversation_requests"), 0);
  assert.equal((await f.getCards()).length, 0);
  db.exec("DROP TRIGGER fixture_fail_receipt");
  const result = await f.turn(input);
  assert.equal(result.kind, "clarification");
  assert.deepEqual(await f.turn(input), result);
  const archive = await f.turn(message(confirmationText));
  assert.equal(archive.kind, "archive");
  const response = await f.request("/api/chat/history");
  const history = chatHistoryResponseSchema.parse(await response.json());
  const archiveDetails = z.looseObject({
    archive: z.looseObject({ attempt_id: z.string() }),
  });
  const attemptId = history.messages.flatMap(({ details }) => {
    const found = archiveDetails.safeParse(details);
    return found.success ? [found.data.archive.attempt_id] : [];
  })[0];
  assert.ok(attemptId);
  assert.equal((await f.turn(message("好"))).kind, "clarify");
  assert.equal((await f.getCards())[0]?.revision, 1);
  assert.equal(f.count("entries"), 0);
  const discard = {
    action: "discard",
    confirmation_granted: true,
    text: confirmationText,
    attempt_id: attemptId,
  };
  assert.equal((await f.request("/api/chat/confirm", discard)).status, 200);
  assert.equal((await f.request("/api/chat/confirm", discard)).status, 409);
  assert.equal(f.count("entries"), 0);
  assert.equal(f.count("agent_tasks"), 0);
});

test("v8 migration is atomic and upgrades through C3 and reopens with old WorkItems and chat history intact", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c2-v9-"));
  const path = join(dir.path, "test.db");
  let oldId: string;
  {
    using db = new DatabaseSync(path);
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 8)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
        migration.version,
        migration.name,
        "2026-11-19",
      );
    }
    db.prepare(
      "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','8')",
    ).run(SCHEMA_KIND);
    oldId = fixture(db).goal(networkLab.tcp).id;
    db.exec(
      "CREATE INDEX ix_conversation_clarification_status ON conversation_messages(role)",
    );
  }
  assert.throws(() => openDatabase(path), /already exists/);
  {
    using db = new DatabaseSync(path);
    assert.equal(readSchemaVersion(db), 8);
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name LIKE 'conversation_clarifications'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get(),
      undefined,
    );
    db.exec("DROP INDEX ix_conversation_clarification_status");
  }
  {
    using db = openDatabase(path);
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
    const f = fixture(db);
    assert.equal(f.store.conversation.listChatMessages(40).length, 1);
    const card = await firstCard(f);
    assert.equal(card.candidates[0]?.id, oldId);
  }
  {
    using db = openDatabase(path);
    assert.equal((await fixture(db).getCards())[0]?.candidates[0]?.id, oldId);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  }
});

test("C2 ordinary turns replay a saved receipt and reserve unresolved IDs without calling the model again", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  const answered = message(networkLab.question);
  const receipt = await f.turn(answered);
  assert.deepEqual(await f.turn(answered), receipt);
  assert.equal(f.responderHistory.length, 1);
  const uncertain = message("TCP 是什么？");
  db.exec(
    `CREATE TRIGGER fixture_fail_receipt BEFORE UPDATE ON conversation_requests BEGIN SELECT RAISE(ABORT, 'fixture failed'); END`,
  );
  assert.equal((await f.post(uncertain)).status, 500);
  assert.equal(f.count("conversation_messages"), 3);
  db.exec("DROP TRIGGER fixture_fail_receipt");
  const replay = await f.post(uncertain);
  assert.equal(replay.status, 409);
  assert.match(await replay.text(), /尚未确认/);
  assert.equal(f.responderHistory.length, 2);
  assert.equal(f.count("conversation_messages"), 3);
});

test("C2 bounds pending cards and rejects ambiguous fragments outside the display window", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db);
  for (let index = 0; index < 6; index++)
    f.goal(
      index < 2 ? `${networkLab.tcp} #${index}` : `${networkLab.udp} #${index}`,
    );
  const first = await firstCard(f);
  assert.equal(first.candidates.length, 5);
  await f.turn({
    action: "reply",
    requestId: randomUUID(),
    clarificationId: first.id,
    expectedRevision: 1,
    text: networkLab.supplement,
  });
  assert.equal((await f.getCards())[0]?.selected, null);
  for (let index = 0; index < 19; index++) await f.turn(message());
  assert.equal(
    (await f.getCards()).filter(({ status }) => status === "pending").length,
    20,
  );
  const before = f.count("conversation_messages");
  const overflow = message();
  assert.equal((await f.post(overflow)).status, 409);
  assert.equal(f.count("conversation_messages"), before);
  await f.turn({
    action: "cancel",
    requestId: randomUUID(),
    clarificationId: first.id,
    expectedRevision: 2,
  });
  assert.equal((await f.turn(overflow)).kind, "clarification");
});

function c3Source(f: ReturnType<typeof fixture>, text: string, title: string) {
  const { entryId } = f.store.archive(
    text,
    createNew(BucketType.Experiment, title, 1, "测试"),
    minimalExtraction(text),
    { modelName: "fake", promptVersion: "test", candidateBucketIds: [] },
  );
  assert.ok(entryId);
  return entryId;
}

test("C3 resumes a selection after reopening SQLite with the original request, all supplements and only the selected goal evidence", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c3-"));
  const path = join(dir.path, "test.db");
  const tcpText = "抓包报告：SYN 后收到 SYN-ACK。";
  const supplements = ["只改报告中的握手段落", "保留原有术语，不增加测量值"];
  let next: ConversationTurn;
  let tcpId: string;
  let tcpEntry: string;
  {
    using db = openDatabase(path);
    const f = fixture(db);
    tcpEntry = c3Source(f, tcpText, networkLab.tcp);
    const udpEntry = c3Source(f, "UDP 报告不涉及握手。", networkLab.udp);
    const tcp = f.goal(
      networkLab.tcp,
      [{ kind: "entry", id: tcpEntry }],
      "解释握手报文来往",
    );
    tcpId = tcp.id;
    f.goal(networkLab.udp, [{ kind: "entry", id: udpEntry }]);
    const card = await firstCard(f);
    await f.turn({
      action: "select",
      requestId: randomUUID(),
      clarificationId: card.id,
      expectedRevision: 1,
      workItemId: tcp.id,
    });
    await f.turn(message(networkLab.question));
    for (const [index, text] of supplements.entries()) {
      await f.turn({
        action: "reply",
        requestId: randomUUID(),
        clarificationId: card.id,
        expectedRevision: index + 2,
        text,
      });
    }
    next = {
      action: "continue",
      requestId: randomUUID(),
      clarificationId: card.id,
      expectedRevision: 4,
    };
  }
  {
    using db = openDatabase(path);
    const seen: GroundedInput[] = [];
    const f = fixture(db, async (input) => {
      seen.push(input);
      return {
        kind: "answer",
        text: "发送 SYN 后，接收方返回 SYN-ACK。",
        quotes: [{ entryId: tcpEntry, quote: tcpText }],
      };
    });
    const result = await f.turn(next);
    assert.equal(result.kind, "clarification");
    assert.deepEqual(await f.turn(next), result);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.original, networkLab.request);
    assert.deepEqual(seen[0]?.supplements, supplements);
    assert.equal(seen[0]?.target?.id, tcpId);
    assert.equal(seen[0]?.target?.acceptance, "解释握手报文来往");
    assert.deepEqual(
      seen[0]?.evidence.map(({ entryId }) => entryId),
      [tcpEntry],
    );
    assert.equal(f.count("entries"), 2);
    assert.equal(f.count("agent_tasks"), 0);
    const rendered = f.store.conversation
      .listChatMessages(40)
      .find(({ id }) => id === result.assistantMessageId);
    assert.equal(rendered?.content, "发送 SYN 后，接收方返回 SYN-ACK。");
    assert.deepEqual(
      z
        .looseObject({
          citations: z.array(z.looseObject({ entryId: z.string() })),
        })
        .parse(rendered?.details)
        .citations.map(({ entryId }) => entryId),
      [tcpEntry],
    );
    f.store.deleteEntry(tcpEntry, "撤销抓包报告");
    const expired = f.store.conversation
      .listChatMessages(40)
      .find(({ id }) => id === result.assistantMessageId);
    assert.doesNotMatch(expired?.content ?? "", /SYN/);
    assert.deepEqual(expired?.details, {
      kind: "conversation_context_expired",
    });
    assert.equal(
      (await f.post({ ...next, requestId: randomUUID() })).status,
      409,
    );
  }
});

test("C3 publishes only verified lookup excerpts, abstains when evidence is missing and removes revoked results from history", async () => {
  using db = openDatabase(":memory:");
  let calls = 0;
  let entryId = "";
  const quote = "发布审批日期为 11 月 18 日。";
  const f = fixture(db, async ({ original, evidence }) => {
    calls++;
    assert.deepEqual(
      evidence.map((source) => source.entryId),
      [entryId],
    );
    return original.includes("号码")
      ? {
          kind: "answer",
          text: "号码为 123456",
          quotes: [{ entryId, quote: "号码为 123456" }],
        }
      : {
          kind: "answer",
          text: "并未保存的额外细节",
          quotes: [{ entryId, quote }],
        };
  });
  entryId = c3Source(f, quote, "发布审批");
  const lookup = "上次发布审批是什么时候？";
  const found = await f.turn(message(lookup));
  const row = (id: string) =>
    f.store.conversation
      .listChatMessages(40)
      .find((message) => message.id === id);
  assert.equal(found.kind, "lookup");
  assert.equal(row(found.assistantMessageId)?.content, quote);
  const gap = await f.turn(message("上次发布审批的联系人号码是多少？"));
  assert.match(row(gap.assistantMessageId)?.content ?? "", /校验|依据/);
  assert.doesNotMatch(row(gap.assistantMessageId)?.content ?? "", /123456/);
  assert.equal(calls, 2);
  const movedBucket = c3Source(f, "另一条无关记录", "新归属");
  const bucketId = f.store.getEntry(movedBucket)?.bucketId;
  assert.ok(bucketId);
  f.store.moveEntry(entryId, bucketId, "移动发布记录");
  const citationDetails = z.looseObject({
    citations: z.array(
      z.strictObject({ entryId: z.string(), bucketId: z.string() }),
    ),
  });
  assert.deepEqual(
    citationDetails.parse(row(found.assistantMessageId)?.details).citations,
    [{ entryId, bucketId }],
  );
  f.store.deleteEntry(entryId, "撤销发布记录");
  assert.deepEqual(row(found.assistantMessageId)?.details, {
    kind: "conversation_context_expired",
  });
  const empty = await f.turn(message(lookup));
  assert.match(
    row(empty.assistantMessageId)?.content ?? "",
    /没有提供足够依据/,
  );
  assert.equal(calls, 2);
  assert.equal(f.count("agent_tasks"), 0);
  assert.equal(f.classified(), 0);
});

for (const invalidation of ["source", "scope"] as const) {
  test(`C3 invalidates in-flight grounded answers after a ${invalidation} change`, async () => {
    using db = openDatabase(":memory:");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const passage = "TCP 报告正文：等待确认。";
    let entryId = "";
    const f = fixture(db, async () => {
      started.resolve();
      await release.promise;
      return {
        kind: "answer",
        text: "已经失效的改写结果",
        quotes: [{ entryId, quote: passage }],
      };
    });
    entryId = c3Source(f, passage, "任务材料");
    const tcp = f.goal(networkLab.tcp, [{ kind: "entry", id: entryId }]);
    const card = await firstCard(f, `修改「${tcp.title}」`);
    const pending = f.turn({
      action: "continue",
      requestId: randomUUID(),
      clarificationId: card.id,
      expectedRevision: card.revision,
    });
    await started.promise;
    if (invalidation === "source") f.store.deleteEntry(entryId, "测试撤销");
    else
      f.items.update(
        tcp.id,
        {
          expectedRevision: tcp.revision,
          title: tcp.title,
          goal: "新范围",
          acceptance: tcp.acceptance,
        },
        describeUpdatedGoal,
      );
    release.resolve();
    const result = await pending;
    const view = f.store.conversation
      .listChatMessages(40)
      .find(({ id }) => id === result.assistantMessageId);
    assert.equal(view?.content, STALE_CONTEXT_MESSAGE);
    assert.doesNotMatch(view?.content ?? "", /改写结果/);
    assert.deepEqual(view?.details, { kind: "conversation_context_expired" });
    assert.equal(
      db
        .prepare("SELECT 1 FROM conversation_messages WHERE content=?")
        .get("已经失效的改写结果"),
      undefined,
    );
  });
}

test("C3 v9 → v10 migration rolls back on failure and preserves existing cards on reopen", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c3-v10-"));
  const path = join(dir.path, "test.db");
  let cardId: string;
  {
    using db = new DatabaseSync(path);
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 9)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
        migration.version,
        migration.name,
        "2026-11-19",
      );
    }
    db.prepare(
      "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','9')",
    ).run(SCHEMA_KIND);
    const f = fixture(db);
    const tcp = f.goal(networkLab.tcp);
    const question = f.store.conversation.appendChatMessage({
      role: "user",
      content: networkLab.request,
      details: { kind: "task_clarification" },
    });
    const prompt = f.store.conversation.appendChatMessage({
      role: "assistant",
      content: "你指的是哪项实验？",
      details: { kind: "task_clarification" },
    });
    cardId = randomUUID();
    // Seed using the v9 contract: current application writes require the
    // current schema and cannot generate genuinely pre-migration rows.
    db.prepare(
      `INSERT INTO conversation_clarifications
        (id, original_message_id, assistant_message_id, status, revision,
         candidates_json, truncated)
       VALUES (?, ?, ?, 'pending', 1, ?, 0)`,
    ).run(
      cardId,
      question.id,
      prompt.id,
      JSON.stringify([{ id: tcp.id, scopeRevision: tcp.scopeRevision }]),
    );
    db.exec(
      "CREATE INDEX ix_conversation_supplements ON conversation_messages(role)",
    );
  }
  assert.throws(() => openDatabase(path), /already exists/);
  {
    using db = new DatabaseSync(path);
    assert.equal(readSchemaVersion(db), 9);
    assert.equal(
      db.prepare("SELECT 1 FROM schema_migrations WHERE version=10").get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='conversation_executions'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP INDEX ix_conversation_supplements");
  }
  for (let i = 0; i < 2; i++) {
    using db = openDatabase(path);
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION);
    const [card] = await fixture(db).getCards();
    assert.equal(card?.id, cardId);
    assert.equal(card.originalText, networkLab.request);
    assert.equal(card.candidates[0]?.title, networkLab.tcp);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  }
});

test("C3 reviews a uniquely named completed goal without reopening it or calling the model", async () => {
  using db = openDatabase(":memory:");
  const f = fixture(db, async () =>
    assert.fail("goal review must not call the model"),
  );
  const tcp = f.goal(networkLab.tcp, [], "核对 SYN 与 SYN-ACK 顺序");
  f.items.transition(tcp.id, {
    action: "complete",
    expectedRevision: tcp.revision,
  });
  const result = await f.turn(message(`回顾「${networkLab.tcp}」的验收要求。`));
  assert.equal(result.kind, "lookup");
  assert.equal(f.items.get(tcp.id).status, "done");
  assert.equal((await f.getCards()).length, 0);
  const row = f.store.conversation
    .listChatMessages(40)
    .find(({ id }) => id === result.assistantMessageId);
  assert.match(row?.content ?? "", /核对 SYN 与 SYN-ACK 顺序/);
  assert.equal(
    z.looseObject({ workItemId: z.uuid() }).parse(row?.details).workItemId,
    tcp.id,
  );
});
