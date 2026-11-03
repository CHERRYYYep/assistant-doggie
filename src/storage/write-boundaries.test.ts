import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendExisting,
  askUser,
  createNew,
} from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { StorageError, openDatabase } from "./database.ts";
import { Store, type ArchiveAudit } from "./store.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "write-boundaries-test",
  modelName: "fake-model",
};
const EXTRACTION = createExtraction({
  summary: "temporary test record",
  evidences: ["temporary evidence"],
  todos: ["temporary todo"],
});

function setup() {
  let tick = 0;
  const store = new Store(
    openDatabase(":memory:"),
    () => new Date(Date.UTC(2026, 10, 3, 0, 0, tick++)),
  );
  const create = (title: string) => {
    const result = store.archive(
      `${title} has 10 records`,
      createNew(BucketType.Task, title, 0.99, "test fixture"),
      EXTRACTION,
      AUDIT,
    );
    assert.ok(result.bucketId);
    assert.ok(result.entryId);
    return { bucketId: result.bucketId, entryId: result.entryId };
  };
  return { store, create };
}

/** Include exact timestamps and audit IDs to detect even partial writes. */
function snapshot(store: Store): unknown {
  return [
    "buckets",
    "entries",
    "memory_items",
    "bucket_tags",
    "archive_attempts",
    "pending_actions",
    "corrections",
    "conversation_messages",
  ].map((table) => store.database.prepare(`SELECT * FROM ${table}`).all());
}

function isInactive(error: unknown): boolean {
  return error instanceof StorageError && error.kind === "inactive_bucket";
}

for (const lifecycle of ["paused", "done", "archived"] as const) {
  test(`automatic archive rejects a ${lifecycle} target without partial writes`, () => {
    const { store, create } = setup();
    try {
      const target = create("target");
      store.setBucketStatus(target.bucketId, lifecycle);
      const before = snapshot(store);
      assert.throws(
        () =>
          store.archive(
            "target has 20 records",
            appendExisting(target.bucketId, BucketType.Task, 0.99, "append"),
            EXTRACTION,
            AUDIT,
          ),
        isInactive,
      );
      assert.deepEqual(snapshot(store), before);

      // The same target becomes writable again only after explicit reactivation.
      store.setBucketStatus(target.bucketId, "active");
      const retry = store.archive(
        "target has 20 records",
        appendExisting(target.bucketId, BucketType.Task, 0.99, "append"),
        EXTRACTION,
        AUDIT,
      );
      assert.equal(retry.archiveState, "archived");
      assert.equal(store.getBucketDetail(target.bucketId)?.entries.length, 2);
    } finally {
      store.database.close();
    }
  });

  test(`direct append and correction reject a ${lifecycle} target atomically`, () => {
    const { store, create } = setup();
    try {
      const source = create("source");
      const target = create("target");
      store.setBucketStatus(target.bucketId, lifecycle);
      const before = snapshot(store);
      assert.throws(
        () =>
          store.appendEntry({ bucketId: target.bucketId, rawText: "append" }),
        isInactive,
      );
      assert.deepEqual(snapshot(store), before);
      assert.throws(
        () => store.moveEntry(source.entryId, target.bucketId, "move record"),
        isInactive,
      );
      assert.deepEqual(snapshot(store), before);
      assert.equal(store.getEntry(source.entryId)?.bucketId, source.bucketId);
      assert.ok(store.getBucket(source.bucketId));

      store.setBucketStatus(target.bucketId, "active");
      store.moveEntry(source.entryId, target.bucketId, "move record");
      assert.equal(store.getEntry(source.entryId)?.bucketId, target.bucketId);
    } finally {
      store.database.close();
    }
  });
}

test("archive rolls back proposal and formal writes when chat projection throws", () => {
  const { store } = setup();
  try {
    for (const decision of [
      askUser(undefined, undefined, 0.5, "confirm", "where?", []),
      createNew(BucketType.Task, "target", 0.99, "test fixture"),
    ]) {
      const before = snapshot(store);
      assert.throws(
        () =>
          store.archive(
            "target has 10 records",
            decision,
            decision.action === "ask_user" ? undefined : EXTRACTION,
            AUDIT,
            () => {
              throw new Error("projection failed");
            },
          ),
        /projection failed/u,
      );
      assert.deepEqual(snapshot(store), before);
    }
  } finally {
    store.database.close();
  }
});

test("archive rolls back when chat details cannot be serialized", () => {
  const { store } = setup();
  try {
    const before = snapshot(store);
    assert.throws(() =>
      store.archive(
        "target has 10 records",
        askUser(undefined, undefined, 0.5, "confirm", "where?", []),
        undefined,
        AUDIT,
        () => ({ role: "assistant", content: "confirm", details: 1n }),
      ),
    );
    assert.deepEqual(snapshot(store), before);
    // A failed transaction leaves the connection usable, with no ghost proposal.
    store.appendChatMessage({ role: "user", content: "after rollback" });
    assert.equal(store.listChatMessages(10).length, 1);
  } finally {
    store.database.close();
  }
});
