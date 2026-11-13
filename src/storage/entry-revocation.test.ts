import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createNew, appendExisting } from "../domain/classification.ts";
import { createExtraction, minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { MemoryQueryService } from "../application/query.ts";
import { DoggieMcpTools } from "../mcp/tools.ts";
import { openDatabase, StorageError } from "./database.ts";
import { MIGRATIONS, SCHEMA_KIND } from "./schema.ts";
import { Store, type ArchiveAudit } from "./store.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "revocation-test",
  modelName: "fake-model",
};
const EXTRACTION = createExtraction({
  summary: "revoked-only-summary",
  todos: ["revoked-only-todo"],
  evidences: ["revoked-only-evidence"],
  tags: ["revoked-only-tag", "shared-tag"],
});
function archive(store: Store, bucketId?: string) {
  const result = store.archive(
    "revoked-only-source",
    bucketId === undefined
      ? createNew(BucketType.Task, "independent-label", 0.99, "test")
      : appendExisting(bucketId, BucketType.Task, 0.99, "test"),
    EXTRACTION,
    AUDIT,
  );
  assert.ok(result.entryId);
  assert.ok(result.bucketId);
  return {
    entryId: result.entryId,
    bucketId: result.bucketId,
    attemptId: result.attemptId,
  };
}
function snapshot(store: Store): unknown {
  return [
    "entries",
    "memory_items",
    "bucket_tags",
    "buckets",
    "archive_attempts",
    "corrections",
    "conversation_messages",
  ].map((table) =>
    store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

test("Entry revocation preserves its source/audits while removing effective memories, tags and answers", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const first = archive(store);
    const retained = store.archive(
      "retained-source",
      appendExisting(first.bucketId, BucketType.Task, 0.99, "test"),
      createExtraction({
        summary: "retained-summary",
        tags: ["shared-tag"],
        todos: ["retained-todo"],
      }),
      AUDIT,
    );
    store.database
      .prepare("INSERT INTO bucket_tags VALUES (?, 'legacy-label', 2)")
      .run(first.bucketId);
    const beforeMemoryIds = store
      .getBucketDetail(first.bucketId)
      ?.memories.filter((memory) => memory.entryId === first.entryId)
      .map((memory) => memory.id)
      .sort();
    const outcome = store.deleteEntry(first.entryId, "revoke incorrect record");
    assert.deepEqual(outcome.memoryItemIds, beforeMemoryIds);
    assert.equal(store.getEntry(first.entryId), undefined);
    assert.equal(store.getLatestEntry()?.id, retained.entryId);
    assert.equal(
      store.getBucketDetail(first.bucketId)?.bucket.summary,
      "retained-summary",
    );
    assert.deepEqual(store.getBucket(first.bucketId)?.tags, [
      "shared-tag",
      "legacy-label",
    ]);
    assert.deepEqual(
      store.getBucketDetail(first.bucketId)?.entries.map((entry) => entry.id),
      [retained.entryId],
    );
    assert.equal(
      store
        .getBucketDetail(first.bucketId)
        ?.memories.some((memory) => memory.entryId === first.entryId),
      false,
    );
    assert.equal(
      store.database
        .prepare("SELECT raw_text FROM entries WHERE id=?")
        .get(first.entryId)?.["raw_text"],
      "revoked-only-source",
    );
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS total FROM memory_items WHERE entry_id=?")
        .get(first.entryId)?.["total"],
      outcome.memoryItemIds.length,
    );
    assert.equal(
      store.getArchiveAttempt(first.attemptId)?.archiveState,
      "revoked",
    );
    assert.equal(
      store.getArchiveAttempt(first.attemptId)?.entryId,
      first.entryId,
    );
    for (const term of [
      "revoked-only-source",
      "revoked-only-summary",
      "revoked-only-todo",
      "revoked-only-evidence",
      "revoked-only-tag",
    ]) {
      assert.deepEqual(store.searchEntryCandidates([term]), [], term);
      assert.deepEqual(store.searchBuckets(term, 10), [], term);
      assert.deepEqual(
        new MemoryQueryService(store).search(term, 10).results,
        [],
        term,
      );
      assert.doesNotMatch(
        JSON.stringify(
          new DoggieMcpTools(store).getBucketDetail(first.bucketId),
        ),
        new RegExp(term),
      );
    }
    assert.equal(
      new MemoryQueryService(store).search("retained-todo", 10).results.length,
      1,
    );
    assert.equal(store.getMemoryContextRevision(), 1);
  } finally {
    store.database.close();
  }
});

test("repeat revocation is a stable no-op and rejects further movement or extraction", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const record = archive(store);
    const first = store.deleteEntry(record.entryId, "first revocation");
    const before = snapshot(store);
    assert.deepEqual(
      store.deleteEntry(record.entryId, "retry with another text"),
      first,
    );
    assert.deepEqual(store.getEntryRevocation(record.entryId), first);
    assert.deepEqual(snapshot(store), before);
    assert.throws(
      () =>
        store.saveExtraction({
          bucketId: record.bucketId,
          entryId: record.entryId,
          extraction: EXTRACTION,
        }),
      StorageError,
    );
    assert.throws(
      () => store.moveEntry(record.entryId, record.bucketId, "move revoked"),
      StorageError,
    );
    assert.deepEqual(snapshot(store), before);
    assert.throws(() => store.deleteEntry("missing", "revoke"), StorageError);
    assert.equal(store.getEntryRevocation("missing"), undefined);
  } finally {
    store.database.close();
  }
});

test("revocation audit failure rolls back source visibility, memories, tags, summary and context", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const record = archive(store);
    store.appendChatMessage({ role: "user", content: "preserved history" });
    const before = snapshot(store);
    store.database.exec(
      "CREATE TRIGGER fail_revocation BEFORE INSERT ON corrections WHEN NEW.action='delete_entry' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END",
    );
    assert.throws(
      () => store.deleteEntry(record.entryId, "revoke"),
      /injected audit failure/u,
    );
    assert.deepEqual(snapshot(store), before);
    assert.equal(store.getMemoryContextRevision(), 0);
    assert.equal(store.listModelChatMessages(10).length, 1);
    store.database.exec("DROP TRIGGER fail_revocation");
    store.deleteEntry(record.entryId, "retry");
    assert.equal(store.getEntry(record.entryId), undefined);
  } finally {
    store.database.close();
  }
});

test("revocation invalidates model history while retaining display history; Bucket deletion also advances context", () => {
  const store = new Store(
    openDatabase(":memory:"),
    () => new Date("2026-11-03T00:00:00.000Z"),
  );
  try {
    const record = archive(store);
    store.appendChatMessage({ role: "user", content: "revoked-only-source" });
    store.appendChatMessage({
      role: "assistant",
      content: "an answer that cites the old source",
    });
    assert.equal(store.getMemoryContextRevision(), 0);
    store.deleteEntry(record.entryId, "revoke");
    assert.equal(store.getMemoryContextRevision(), 1);
    assert.equal(store.listChatMessages(10).length, 2);
    assert.deepEqual(store.listModelChatMessages(10), []);
    store.appendChatMessage({
      role: "user",
      content: "new independent question",
    });
    assert.deepEqual(
      store.listModelChatMessages(10).map((message) => message.content),
      ["new independent question"],
    );
    store.deleteBucket(record.bucketId, "delete bucket");
    assert.equal(store.getMemoryContextRevision(), 2);
    assert.deepEqual(store.listModelChatMessages(10), []);
    assert.equal(store.listChatMessages(10).length, 3);
    assert.equal(
      store.getEntryRevocation(record.entryId)?.entryId,
      record.entryId,
    );
  } finally {
    store.database.close();
  }
});

test("legacy unlinked memories stay untouched and revoked volume does not dominate popular Buckets", () => {
  let tick = 0;
  const store = new Store(
    openDatabase(":memory:"),
    () => new Date(Date.UTC(2026, 10, 3, 0, 0, tick++)),
  );
  try {
    const record = archive(store);
    const other = store.archive(
      "active",
      createNew(BucketType.Task, "active label", 0.99, "test"),
      minimalExtraction("active summary"),
      AUDIT,
    );
    assert.ok(other.bucketId);
    store.database
      .prepare(
        "INSERT INTO memory_items (id,bucket_id,entry_id,kind,text,created_at,updated_at) VALUES ('legacy-memory',?,NULL,'evidence','unknown historical source','2026-11-01','2026-11-01')",
      )
      .run(record.bucketId);
    store.deleteEntry(record.entryId, "revoke");
    assert.equal(
      store.getBucketDetail(record.bucketId)?.memories[0]?.id,
      "legacy-memory",
    );
    assert.equal(
      store.getBucketDetail(record.bucketId)?.memories[0]?.entryId,
      null,
    );
    // One legacy memory ties the active Entry volume; active Bucket remains newer.
    assert.equal(store.listPopularActiveBuckets(1)[0]?.id, other.bucketId);
  } finally {
    store.database.close();
  }
});

test("saving extraction retains explicit ownership for another Entry with the same facts", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const first = archive(store);
    const second = store.appendEntry({
      bucketId: first.bucketId,
      rawText: "independently supplied same facts",
    });
    store.saveExtraction({
      bucketId: first.bucketId,
      entryId: second.id,
      extraction: EXTRACTION,
    });
    const secondIds = store
      .getBucketDetail(first.bucketId)
      ?.memories.filter((memory) => memory.entryId === second.id)
      .map((memory) => memory.id);
    assert.ok(secondIds && secondIds.length > 0);
    store.saveExtraction({
      bucketId: first.bucketId,
      entryId: second.id,
      extraction: EXTRACTION,
    });
    assert.deepEqual(
      store
        .getBucketDetail(first.bucketId)
        ?.memories.filter((memory) => memory.entryId === second.id)
        .map((memory) => memory.id),
      secondIds,
    );
    store.deleteEntry(first.entryId, "revoke first source");
    assert.deepEqual(store.getBucket(first.bucketId)?.tags, [
      "revoked-only-tag",
      "shared-tag",
    ]);
    assert.equal(
      store.getBucketDetail(first.bucketId)?.memories.length,
      secondIds.length,
    );
    assert.equal(
      new MemoryQueryService(store).search("revoked-only-evidence", 10)
        .results[0]?.entry.id,
      second.id,
    );
  } finally {
    store.database.close();
  }
});

test("moving then revoking an Entry removes its known tag contribution from both Buckets", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const first = archive(store);
    store.archive(
      "retained",
      appendExisting(first.bucketId, BucketType.Task, 0.99, "test"),
      minimalExtraction("retained"),
      AUDIT,
    );
    const target = store.archive(
      "target",
      createNew(BucketType.Task, "target", 0.99, "test"),
      minimalExtraction("target"),
      AUDIT,
    );
    assert.ok(target.bucketId);
    store.moveEntry(first.entryId, target.bucketId, "move");
    assert.deepEqual(store.getBucket(first.bucketId)?.tags, []);
    assert.deepEqual(store.getBucket(target.bucketId)?.tags, [
      "revoked-only-tag",
      "shared-tag",
    ]);
    store.deleteEntry(first.entryId, "revoke");
    assert.deepEqual(store.getBucket(target.bucketId)?.tags, []);
    assert.deepEqual(store.searchEntryCandidates(["revoked-only-tag"]), []);
  } finally {
    store.database.close();
  }
});

test("v5 migration and database reopen preserve records and legacy orphans with durable revocation state", () => {
  const root = mkdtempSync(join(tmpdir(), "doggie-revocation-"));
  const path = join(root, "test.sqlite");
  let database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 5)) {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?,?,?)")
        .run(migration.version, migration.name, "2026-11-01");
    }
    database
      .prepare(
        "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','5')",
      )
      .run(SCHEMA_KIND);
    database
      .prepare(
        "INSERT INTO agent_sessions (id,workspace_id,backend,remote_id,created_at) VALUES ('old-session',NULL,'codex',NULL,'2026-11-01')",
      )
      .run();
    const legacyStore = new Store(database);
    const record = archive(legacyStore);
    legacyStore.appendChatMessage({ role: "user", content: "kept history" });
    database
      .prepare(
        "INSERT INTO memory_items (id,bucket_id,kind,text,created_at,updated_at) VALUES ('legacy-orphan',?,'todo','unknown legacy source','2026-11-01','2026-11-01')",
      )
      .run(record.bucketId);
    database.close();
    database = openDatabase(path);
    let store = new Store(database);
    assert.equal(
      store.getEntry(record.entryId)?.rawText,
      "revoked-only-source",
    );
    assert.equal(store.getMemoryContextRevision(), 0);
    assert.equal(
      database
        .prepare(
          "SELECT memory_revision FROM agent_sessions WHERE id='old-session'",
        )
        .get()?.["memory_revision"],
      0,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "UPDATE agent_sessions SET memory_revision=1 WHERE id='old-session'",
          )
          .run(),
      /session binding is immutable/u,
    );
    assert.equal(
      database
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get()?.["value"],
      "8",
    );
    const revocation = store.deleteEntry(
      record.entryId,
      "revoke after migration",
    );
    database.close();
    database = openDatabase(path);
    store = new Store(database);
    assert.deepEqual(
      store.deleteEntry(record.entryId, "retry after reopen"),
      revocation,
    );
    assert.equal(store.getMemoryContextRevision(), 1);
    assert.deepEqual(store.listModelChatMessages(10), []);
    assert.equal(store.listChatMessages(10).length, 1);
    assert.deepEqual(
      store
        .getBucketDetail(record.bucketId)
        ?.memories.map((memory) => memory.id),
      ["legacy-orphan"],
    );
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bucket deletion audit failure preserves context revision and effective history", () => {
  const store = new Store(openDatabase(":memory:"));
  try {
    const record = archive(store);
    store.appendChatMessage({ role: "assistant", content: "existing answer" });
    const before = snapshot(store);
    store.database.exec(
      "CREATE TRIGGER fail_bucket_delete BEFORE INSERT ON corrections WHEN NEW.action='delete_bucket' BEGIN SELECT RAISE(ABORT,'injected bucket audit failure'); END",
    );
    assert.throws(
      () => store.deleteBucket(record.bucketId, "delete bucket"),
      /injected bucket audit failure/u,
    );
    assert.deepEqual(snapshot(store), before);
    assert.equal(store.getMemoryContextRevision(), 0);
    assert.equal(store.listModelChatMessages(10).length, 1);
  } finally {
    store.database.close();
  }
});
