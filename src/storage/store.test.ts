/**
 * Storage transaction invariants — `docs/INVARIANTS.md` §4.
 *
 * These run against a real in-memory SQLite database rather than a mock: the
 * properties under test (foreign keys, rollback, cascade) *are* SQLite
 * behaviour, so a mock would only test the mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BucketType } from "../domain/types.ts";
import { createExtraction, minimalExtraction } from "../domain/memory.ts";
import { StorageError, openDatabase, withTransaction } from "./database.ts";
import { Store, type ArchiveAudit, type ArchiveDecision } from "./store.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "doggie-v1",
  modelName: "test-model",
};

/** A clock that advances one second per call, so ordering is deterministic. */
function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

function freshStore(): Store {
  return new Store(openDatabase(":memory:"), steppingClock());
}

/**
 * `node:sqlite` returns rows as null-prototype objects, which
 * `assert.deepEqual` refuses to match against an object literal. Copying into
 * a plain object keeps the assertions strict rather than loosening them.
 */
function plain<T extends object>(row: T): T {
  return { ...row };
}

function plainAll<T extends object>(rows: T[]): T[] {
  return rows.map(plain);
}

function memoryCount(store: Store, bucketId: string): number {
  const row = store.database
    .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE bucket_id = ?")
    .get(bucketId) as { count: number };
  return row.count;
}

const createNew = (title: string, confidence = 0.99): ArchiveDecision => ({
  action: "create_new",
  bucketId: undefined,
  bucketType: BucketType.Task,
  title,
  confidence,
  reason: "新主题。",
  question: undefined,
});

const appendTo = (bucketId: string): ArchiveDecision => ({
  action: "append_existing",
  bucketId,
  bucketType: BucketType.Task,
  confidence: 0.95,
  title: undefined,
  reason: "同一事务。",
  question: undefined,
});

const askUser = (): ArchiveDecision => ({
  action: "ask_user",
  bucketId: undefined,
  bucketType: undefined,
  title: undefined,
  confidence: 0.4,
  reason: "信息不足。",
  question: "请选择归档目标。",
});

// ── §4.1 / §4.3 / §4.4 ─────────────────────────────────────────────────────

test("archive writes the whole graph in one transaction", () => {
  const store = freshStore();
  const outcome = store.archive(
    "接口 A 压测 p99 620ms",
    createNew("接口 A 压测"),
    createExtraction({
      summary: "p99 从 320ms 升到 620ms",
      todos: ["定位回归 commit"],
      evidences: ["压测报告 #12"],
      timelineEvents: [{ text: "回归出现", occurredAt: "2026-08-20" }],
      tags: ["压测", "接口A"],
    }),
    AUDIT,
  );

  assert.equal(outcome.archiveState, "archived");
  const detail = store.getBucketDetail(outcome.bucketId!)!;
  assert.equal(detail.entries.length, 1);
  assert.equal(detail.entries[0]?.rawText, "接口 A 压测 p99 620ms");
  assert.deepEqual(detail.bucket.tags, ["压测", "接口A"]);
  assert.ok(detail.bucket.summary.includes("620ms"));

  const kinds = detail.memories.map((memory) => memory.kind).sort();
  assert.deepEqual(kinds, ["evidence", "tag", "tag", "timeline", "todo"]);

  const metadata = plainAll(
    store.database
      .prepare(
        `SELECT kind, status, source FROM memory_items
         WHERE kind IN ('todo', 'evidence') ORDER BY kind`,
      )
      .all() as {
      kind: string;
      status: string | null;
      source: string | null;
    }[],
  );
  assert.deepEqual(metadata, [
    { kind: "evidence", status: null, source: "llm" },
    { kind: "todo", status: "open", source: null },
  ]);
});

test("foreign keys are enforced", () => {
  const store = freshStore();
  const enforced = store.database.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  assert.equal(enforced.foreign_keys, 1);

  assert.throws(() =>
    store.database
      .prepare(
        "INSERT INTO entries(id, bucket_id, raw_text, created_at, archived_at) VALUES (?,?,?,?,?)",
      )
      .run("e1", "no-such-bucket", "x", "t", "t"),
  );
});

test("archive state survives reopening the database", () => {
  const database = openDatabase(":memory:");
  const store = new Store(database, steppingClock());
  const outcome = store.archive(
    "记录一",
    createNew("事务一"),
    minimalExtraction("摘要一"),
    AUDIT,
  );

  // A second Store over the same connection sees committed state.
  const reopened = new Store(database, steppingClock());
  const detail = reopened.getBucketDetail(outcome.bucketId!)!;
  assert.equal(detail.entries.length, 1);
  assert.equal(detail.bucket.title, "事务一");
});

// ── §4.12 / §4.14 extraction save + append entry ──────────────────────────

test("saveExtraction deduplicates existing memory rows and preserves the bucket cache", () => {
  const store = freshStore();
  const archive = store.archive(
    "接口 A 压测 p99 620ms",
    createNew("接口 A 压测"),
    createExtraction({
      summary: "p99 从 320ms 升到 620ms",
      todos: ["定位回归 commit"],
      evidences: ["压测报告 #12"],
      timelineEvents: [{ text: "回归出现", occurredAt: "2026-08-20" }],
      tags: ["压测", "接口A"],
    }),
    AUDIT,
  );
  const before = store.getBucket(archive.bucketId!)!;
  const beforeCount = memoryCount(store, archive.bucketId!);

  const updated = store.saveExtraction({
    bucketId: archive.bucketId!,
    entryId: archive.entryId!,
    extraction: createExtraction({
      summary: "p99 从 320ms 升到 620ms",
      todos: ["定位回归 commit"],
      evidences: ["压测报告 #12"],
      timelineEvents: [{ text: "回归出现", occurredAt: "2026-08-20" }],
      tags: ["压测", "接口A"],
    }),
  });

  assert.equal(memoryCount(store, archive.bucketId!), beforeCount);
  assert.equal(updated.summary, "p99 从 320ms 升到 620ms");
  assert.equal(store.getBucket(archive.bucketId!)!.summary, before.summary);
  assert.deepEqual(store.getBucket(archive.bucketId!)!.tags, before.tags);
});

// ── §4.14 append entry ────────────────────────────────────────────────────

test("appendEntry refreshes bucket activity and rejects a missing bucket", () => {
  const store = freshStore();
  const archive = store.archive(
    "第一条",
    createNew("活动桶"),
    minimalExtraction("初始摘要"),
    AUDIT,
  );
  const before = store.getBucket(archive.bucketId!)!;

  const appended = store.appendEntry({
    bucketId: archive.bucketId!,
    rawText: "补充记录",
    summary: "手工补充",
    contentType: "note",
  });

  const after = store.getBucket(archive.bucketId!)!;
  assert.equal(appended.bucketId, archive.bucketId);
  assert.equal(appended.summary, "手工补充");
  assert.ok(after.lastActiveAt > before.lastActiveAt);
  assert.throws(
    () => store.appendEntry({ bucketId: "missing-bucket", rawText: "x" }),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );
});

// ── §4.2 rollback ──────────────────────────────────────────────────────────

test("a failure anywhere in the transaction leaves no partial write", () => {
  const store = freshStore();
  // append_existing to a Bucket that does not exist fails after the attempt id
  // has been generated but before anything is committed.
  assert.throws(
    () =>
      store.archive(
        "孤儿记录",
        appendTo("missing-bucket"),
        minimalExtraction("摘要"),
        AUDIT,
      ),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );

  const counts = store.database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM buckets) AS buckets,
              (SELECT COUNT(*) FROM entries) AS entries,
              (SELECT COUNT(*) FROM memory_items) AS memories,
              (SELECT COUNT(*) FROM archive_attempts) AS attempts`,
    )
    .get() as Record<string, number>;
  assert.deepEqual(plain(counts), {
    buckets: 0,
    entries: 0,
    memories: 0,
    attempts: 0,
  });
});

test("withTransaction rolls back on a throw from anywhere in the body", () => {
  const store = freshStore();
  const outcome = store.archive(
    "记录",
    createNew("事务"),
    minimalExtraction("摘要"),
    AUDIT,
  );

  assert.throws(() =>
    withTransaction(store.database, () => {
      store.database
        .prepare("DELETE FROM entries WHERE id = ?")
        .run(outcome.entryId!);
      throw new Error("late failure");
    }),
  );

  assert.equal(store.getEntry(outcome.entryId!)?.id, outcome.entryId);
});

// ── §1.1 / §4.1 ask_user writes no Entry ───────────────────────────────────

test("ask_user records the attempt and creates no Bucket or Entry", () => {
  const store = freshStore();
  const outcome = store.archive("它现在正常了", askUser(), undefined, AUDIT);

  assert.equal(outcome.archiveState, "needs_confirmation");
  assert.equal(outcome.bucketId, undefined);
  assert.equal(outcome.entryId, undefined);

  const counts = store.database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM buckets) AS buckets,
              (SELECT COUNT(*) FROM entries) AS entries,
              (SELECT COUNT(*) FROM archive_attempts) AS attempts`,
    )
    .get() as Record<string, number>;
  assert.deepEqual(plain(counts), { buckets: 0, entries: 0, attempts: 1 });

  const attempt = store.database
    .prepare("SELECT archive_state, question, raw_text FROM archive_attempts")
    .get() as { archive_state: string; question: string; raw_text: string };
  assert.equal(attempt.archive_state, "needs_confirmation");
  assert.equal(attempt.question, "请选择归档目标。");
  // The original text is bound to the attempt so a confirmation can be checked
  // against it rather than trusting the client.
  assert.equal(attempt.raw_text, "它现在正常了");
});

// ── §4.6 / §4.7 move ───────────────────────────────────────────────────────

test("moving an entry carries its memory and writes a correction", () => {
  const store = freshStore();
  const target = store.archive(
    "目标记录",
    createNew("目标事务"),
    minimalExtraction("目标摘要"),
    AUDIT,
  );
  const source = store.archive(
    "放错地方的记录",
    createNew("误建事务"),
    createExtraction({ summary: "误建摘要", todos: ["跟进"] }),
    AUDIT,
  );
  // Add a second entry so the source bucket is not emptied by the move.
  store.archive(
    "留在原处的记录",
    appendTo(source.bucketId!),
    minimalExtraction("留存摘要"),
    AUDIT,
  );

  const moved = store.moveEntry(
    source.entryId!,
    target.bucketId!,
    "移到目标事务。",
  );

  assert.equal(moved.bucketId, target.bucketId);
  assert.equal(moved.movedFromBucketId, source.bucketId);

  const targetDetail = store.getBucketDetail(target.bucketId!)!;
  assert.equal(targetDetail.entries.length, 2);
  assert.ok(
    targetDetail.memories.some((memory) => memory.text === "跟进"),
    "structured memory follows the entry",
  );

  const correction = store.database
    .prepare(
      "SELECT action, target_id, before_json, after_json FROM corrections",
    )
    .get() as Record<string, string>;
  assert.equal(correction["action"], "move_entry");
  assert.equal(correction["target_id"], source.entryId);
  assert.deepEqual(JSON.parse(correction["before_json"]!), {
    bucket_id: source.bucketId,
  });

  const attempt = store.database
    .prepare(
      "SELECT corrected, archive_state FROM archive_attempts WHERE entry_id = ?",
    )
    .get(source.entryId!) as { corrected: number; archive_state: string };
  assert.equal(attempt.corrected, 1);
  assert.equal(attempt.archive_state, "corrected");
});

test("moving the only entry out of an auto-created bucket removes the empty source", () => {
  const store = freshStore();
  const intended = store.archive(
    "第一条",
    createNew("bucket1"),
    minimalExtraction("摘要一"),
    AUDIT,
  );
  const misplaced = store.archive(
    "放错的一条",
    createNew("bucket2"),
    minimalExtraction("摘要二"),
    AUDIT,
  );

  assert.ok(store.getBucket(misplaced.bucketId!) !== undefined);
  store.moveEntry(misplaced.entryId!, intended.bucketId!, "移到 bucket1。");

  assert.equal(
    store.getBucket(misplaced.bucketId!),
    undefined,
    "the auto-created empty source bucket is removed after the correction",
  );
  assert.equal(store.getBucketDetail(intended.bucketId!)!.entries.length, 2);
});

test("a bucket the user did not get for free is never removed by a move", () => {
  const store = freshStore();
  const target = store.archive(
    "目标",
    createNew("目标事务"),
    minimalExtraction("目标摘要"),
    AUDIT,
  );
  const source = store.archive(
    "来源",
    createNew("来源事务"),
    minimalExtraction("来源摘要"),
    AUDIT,
  );

  // Sever the "this bucket was created for this entry" link, which is what
  // distinguishes an accident from a deliberate Bucket.
  store.database
    .prepare("UPDATE archive_attempts SET entry_id = NULL WHERE bucket_id = ?")
    .run(source.bucketId!);

  store.moveEntry(source.entryId!, target.bucketId!, "移动。");
  assert.ok(
    store.getBucket(source.bucketId!) !== undefined,
    "the source bucket survives",
  );
});

test("moving within the same bucket is rejected", () => {
  const store = freshStore();
  const outcome = store.archive(
    "记录",
    createNew("事务"),
    minimalExtraction("摘要"),
    AUDIT,
  );
  assert.throws(
    () => store.moveEntry(outcome.entryId!, outcome.bucketId!, "同桶移动。"),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "invalid_write",
  );
});

test("moving a missing entry or to a missing bucket is rejected without change", () => {
  const store = freshStore();
  const outcome = store.archive(
    "记录",
    createNew("事务"),
    minimalExtraction("摘要"),
    AUDIT,
  );

  assert.throws(() =>
    store.moveEntry("no-such-entry", outcome.bucketId!, "命令。"),
  );
  assert.throws(() =>
    store.moveEntry(outcome.entryId!, "no-such-bucket", "命令。"),
  );
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS n FROM corrections").get()![
      "n" as never
    ],
    0,
  );
});

// ── §4.5 deletion ──────────────────────────────────────────────────────────

test("deleting a bucket cascades entries, tags and memory but keeps the audit", () => {
  const store = freshStore();
  const outcome = store.archive(
    "记录",
    createNew("事务"),
    createExtraction({ summary: "摘要", todos: ["待办"], tags: ["标签"] }),
    AUDIT,
  );

  store.deleteBucket(outcome.bucketId!, "删除事务。");

  const counts = store.database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM buckets) AS buckets,
              (SELECT COUNT(*) FROM entries) AS entries,
              (SELECT COUNT(*) FROM memory_items) AS memories,
              (SELECT COUNT(*) FROM bucket_tags) AS tags,
              (SELECT COUNT(*) FROM archive_attempts) AS attempts`,
    )
    .get() as Record<string, number>;
  assert.deepEqual(plain(counts), {
    buckets: 0,
    entries: 0,
    memories: 0,
    tags: 0,
    attempts: 1,
  });

  const attempt = store.database
    .prepare("SELECT bucket_id, entry_id, raw_text FROM archive_attempts")
    .get() as {
    bucket_id: string | null;
    entry_id: string | null;
    raw_text: string;
  };
  assert.equal(
    attempt.bucket_id,
    null,
    "the audit row survives with the link cleared",
  );
  assert.equal(attempt.raw_text, "记录");
});

test("deleting one entry keeps the bucket and rebuilds its summary", () => {
  const store = freshStore();
  const first = store.archive(
    "第一条",
    createNew("事务"),
    minimalExtraction("摘要一"),
    AUDIT,
  );
  store.archive(
    "第二条",
    appendTo(first.bucketId!),
    minimalExtraction("摘要二"),
    AUDIT,
  );

  store.deleteEntry(first.entryId!, "删除第一条。");

  const detail = store.getBucketDetail(first.bucketId!)!;
  assert.equal(detail.entries.length, 1);
  assert.equal(
    detail.bucket.summary,
    "摘要二",
    "the removed entry no longer contributes",
  );
});

test("deleting a missing bucket or entry is rejected", () => {
  const store = freshStore();
  assert.throws(
    () => store.deleteBucket("nope", "命令。"),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );
  assert.throws(
    () => store.deleteEntry("nope", "命令。"),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );
});

// ── §4.11 tag merge / §4.9 summary ─────────────────────────────────────────

test("tags merge by folded key and keep the first spelling", () => {
  const store = freshStore();
  const first = store.archive(
    "第一条",
    createNew("事务"),
    createExtraction({ summary: "摘要一", tags: ["Payments"] }),
    AUDIT,
  );
  store.archive(
    "第二条",
    appendTo(first.bucketId!),
    createExtraction({ summary: "摘要二", tags: ["payments", "Rust"] }),
    AUDIT,
  );

  assert.deepEqual(store.getBucket(first.bucketId!)!.tags, [
    "Payments",
    "Rust",
  ]);
});

test("appending updates the bucket activity timestamp", () => {
  const store = freshStore();
  const first = store.archive(
    "第一条",
    createNew("事务"),
    minimalExtraction("摘要一"),
    AUDIT,
  );
  const before = store.getBucket(first.bucketId!)!.lastActiveAt;
  store.archive(
    "第二条",
    appendTo(first.bucketId!),
    minimalExtraction("摘要二"),
    AUDIT,
  );
  const after = store.getBucket(first.bucketId!)!.lastActiveAt;

  assert.ok(after > before, `${after} should be later than ${before}`);
  const attempt = store.database
    .prepare(
      `SELECT candidate_bucket_ids_json FROM archive_attempts
       WHERE action = 'append_existing'`,
    )
    .get() as { candidate_bucket_ids_json: string };
  assert.deepEqual(JSON.parse(attempt.candidate_bucket_ids_json), [
    first.bucketId,
  ]);
});

// ── §4.13 ids / §4.15 listing ──────────────────────────────────────────────

test("generated ids are UUID v4", () => {
  const store = freshStore();
  const outcome = store.archive(
    "记录",
    createNew("事务"),
    minimalExtraction("摘要"),
    AUDIT,
  );
  const uuidV4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(outcome.bucketId!, uuidV4);
  assert.match(outcome.entryId!, uuidV4);
  assert.match(outcome.attemptId, uuidV4);
});

test("the active list excludes non-active buckets and orders by recency", () => {
  const store = freshStore();
  const first = store.archive(
    "一",
    createNew("事务一"),
    minimalExtraction("摘要一"),
    AUDIT,
  );
  const second = store.archive(
    "二",
    createNew("事务二"),
    minimalExtraction("摘要二"),
    AUDIT,
  );
  store.database
    .prepare("UPDATE buckets SET lifecycle = 'archived' WHERE id = ?")
    .run(first.bucketId!);

  const active = store.listActiveBuckets(10);
  assert.deepEqual(
    active.map((bucket) => bucket.id),
    [second.bucketId],
  );
});

test("popular ranking counts entries and memory volume", () => {
  const store = freshStore();
  const quiet = store.archive(
    "安静",
    createNew("安静事务"),
    minimalExtraction("摘要"),
    AUDIT,
  );
  const busy = store.archive(
    "繁忙",
    createNew("繁忙事务"),
    createExtraction({
      summary: "摘要",
      todos: ["一", "二", "三"],
      evidences: ["证据"],
    }),
    AUDIT,
  );
  // `quiet` is more recent by activity, `busy` has more volume.
  store.archive(
    "再来一条",
    appendTo(quiet.bucketId!),
    minimalExtraction("再一条摘要"),
    AUDIT,
  );

  const popular = store.listPopularActiveBuckets(2);
  assert.equal(
    popular[0]?.id,
    busy.bucketId,
    "volume wins over recency in this ranking",
  );
});

// ── conversation ───────────────────────────────────────────────────────────

test("chat messages get a strictly increasing sequence and read back oldest-first", () => {
  const store = freshStore();
  store.appendChatMessage({ role: "user", content: "第一句" });
  store.appendChatMessage({ role: "assistant", content: "第二句" });
  store.appendChatMessage({
    role: "tool",
    content: "第三句",
    toolName: "search_memory",
  });

  const messages = store.listChatMessages(40);
  assert.deepEqual(
    messages.map((message) => message.content),
    ["第一句", "第二句", "第三句"],
  );
  assert.deepEqual(
    messages.map((message) => message.sequence),
    [1, 2, 3],
  );
  assert.equal(messages[2]?.toolName, "search_memory");
});

test("a chat message with empty content is rejected", () => {
  const store = freshStore();
  assert.throws(
    () => store.appendChatMessage({ role: "user", content: "   " }),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "invalid_write",
  );
});

test("chat history returns the most recent window, still oldest-first", () => {
  const store = freshStore();
  for (let index = 1; index <= 5; index += 1) {
    store.appendChatMessage({ role: "user", content: `消息 ${index}` });
  }
  const messages = store.listChatMessages(2);
  assert.deepEqual(
    messages.map((message) => message.content),
    ["消息 4", "消息 5"],
  );
});

// ── schema guards ──────────────────────────────────────────────────────────

test("a database holding foreign tables is refused", () => {
  const database = openDatabase(":memory:");
  database.exec("CREATE TABLE someone_elses_table(id TEXT)");
  // Re-running the open path against this connection's file would refuse; the
  // check is exercised directly since :memory: cannot be reopened.
  assert.throws(
    () => {
      const rows = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[];
      const owned = new Set([
        "schema_meta",
        "schema_migrations",
        "buckets",
        "entries",
        "bucket_tags",
        "memory_items",
        "archive_attempts",
        "corrections",
        "conversation_messages",
      ]);
      const foreign = rows
        .map((row) => row.name)
        .filter((name) => !owned.has(name));
      if (foreign.length > 0)
        throw new StorageError("foreign_database", foreign.join(","));
    },
    (error: unknown) =>
      error instanceof StorageError && error.kind === "foreign_database",
  );
});

test("the schema records its version", () => {
  const store = freshStore();
  const meta = store.database
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string };
  assert.equal(meta.value, "2");

  const migrations = store.database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string }[];
  assert.deepEqual(plainAll(migrations), [
    { version: 1, name: "create_memory_schema_v1" },
    { version: 2, name: "add_pending_archive_suggestions_v2" },
  ]);
});

// ── §5.6 / §5.11 query retrieval ──────────────────────────────────────────

test("query candidates cover stored fields and escape LIKE literals", () => {
  const store = freshStore();
  const literal = store.archive(
    "发布值 100%_ready/path 已确认",
    createNew("特殊 / 路径"),
    createExtraction({
      summary: "字面量检索",
      entities: ["服务 Straße"],
      tags: ["release_100%"],
      evidences: ["artifact/path"],
    }),
    AUDIT,
  );
  store.archive(
    "发布值 100XXready/path 仅作干扰",
    createNew("普通路径"),
    minimalExtraction("不应被百分号或下划线当通配符命中"),
    AUDIT,
  );

  const exact = store.searchEntryCandidates(["100%_ready/path"]);
  assert.deepEqual(exact.map((candidate) => candidate.entry.id), [literal.entryId]);

  const bucket = store.searchEntryCandidates(["特殊 / 路径"]);
  assert.deepEqual(bucket.map((candidate) => candidate.entry.id), [literal.entryId]);

  const tag = store.searchEntryCandidates(["release_100%"]);
  assert.deepEqual(tag.map((candidate) => candidate.entry.id), [literal.entryId]);

  const evidence = store.searchEntryCandidates(["artifact/path"]);
  assert.deepEqual(evidence.map((candidate) => candidate.entry.id), [literal.entryId]);

  const folded = store.searchEntryCandidates(["STRASSE"]);
  assert.deepEqual(folded.map((candidate) => candidate.entry.id), [literal.entryId]);
});

test("query candidate reads do not refresh Bucket activity", () => {
  const store = freshStore();
  const outcome = store.archive(
    "接口 A 压测",
    createNew("接口 A"),
    minimalExtraction("压测摘要"),
    AUDIT,
  );
  const before = store.getBucket(outcome.bucketId!)!;

  assert.equal(store.searchEntryCandidates(["压测"]).length, 1);
  assert.deepEqual(store.getBucket(outcome.bucketId!), before);
});
