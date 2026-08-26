import assert from "node:assert/strict";
import { test } from "node:test";

import { minimalExtraction } from "../domain/memory.ts";
import { BucketStatus, BucketType } from "../domain/types.ts";
import { openDatabase, StorageError } from "../storage/database.ts";
import {
  Store,
  type ArchiveAudit,
  type ArchiveDecision,
} from "../storage/store.ts";
import { BucketStatusService } from "./status.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "classification-v2",
  modelName: "test-model",
};

function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

function setup(): {
  store: Store;
  service: BucketStatusService;
  bucketId: string;
} {
  const store = new Store(openDatabase(":memory:"), steppingClock());
  const decision: ArchiveDecision = {
    action: "create_new",
    bucketId: undefined,
    bucketType: BucketType.Task,
    title: "生命周期测试",
    confidence: 0.99,
    reason: "测试。",
    question: undefined,
  };
  const archive = store.archive(
    "生命周期初始记录",
    decision,
    minimalExtraction("初始摘要"),
    AUDIT,
  );
  return {
    store,
    service: new BucketStatusService(store),
    bucketId: archive.bucketId!,
  };
}

test("all valid Bucket lifecycle values are explicit and reversible", () => {
  const { store, service, bucketId } = setup();
  const initial = store.getBucket(bucketId)!;
  const detailBefore = store.getBucketDetail(bucketId)!;

  for (const status of [
    BucketStatus.Paused,
    BucketStatus.Done,
    BucketStatus.Archived,
    BucketStatus.Active,
  ]) {
    const before = store.getBucket(bucketId)!;
    const updated = service.setStatus(bucketId, status);
    assert.equal(updated.lifecycle, status);
    assert.ok(updated.updatedAt > before.updatedAt);
    assert.equal(updated.lastActiveAt, initial.lastActiveAt);
    assert.equal(updated.archivedAt === null, status !== BucketStatus.Archived);
  }

  const detailAfter = store.getBucketDetail(bucketId)!;
  assert.deepEqual(detailAfter.entries, detailBefore.entries);
  assert.deepEqual(detailAfter.memories, detailBefore.memories);
  const corrections = store.database
    .prepare("SELECT COUNT(*) AS count FROM corrections")
    .get() as { count: number };
  assert.equal(corrections.count, 0);
});

test("non-active Buckets leave active and popular projections until restored", () => {
  for (const status of [
    BucketStatus.Paused,
    BucketStatus.Done,
    BucketStatus.Archived,
  ]) {
    const { store, service, bucketId } = setup();
    service.setStatus(bucketId, status);
    assert.equal(
      store.listActiveBuckets(10).some((bucket) => bucket.id === bucketId),
      false,
    );
    assert.equal(
      store
        .listPopularActiveBuckets(10)
        .some((bucket) => bucket.id === bucketId),
      false,
    );
    service.setStatus(bucketId, BucketStatus.Active);
    assert.equal(
      store.listActiveBuckets(10).some((bucket) => bucket.id === bucketId),
      true,
    );
  }
});

test("setting a missing Bucket status is typed and has no side effects", () => {
  const { store, service } = setup();
  const before = store.listBuckets();
  assert.throws(
    () => service.setStatus("missing-bucket", BucketStatus.Archived),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );
  assert.deepEqual(store.listBuckets(), before);
});
