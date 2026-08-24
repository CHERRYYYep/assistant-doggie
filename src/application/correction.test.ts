import assert from "node:assert/strict";
import { test } from "node:test";

import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase, StorageError } from "../storage/database.ts";
import {
  Store,
  type ArchiveAudit,
  type ArchiveDecision,
} from "../storage/store.ts";
import {
  CorrectionError,
  CorrectionService,
  targetTitleFromCommand,
} from "./correction.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "classification-v2",
  modelName: "test-model",
};

function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

function setup(): { store: Store; service: CorrectionService } {
  const store = new Store(openDatabase(":memory:"), steppingClock());
  return { store, service: new CorrectionService(store) };
}

function createBucket(
  store: Store,
  title: string,
): { bucketId: string; entryId: string } {
  const decision: ArchiveDecision = {
    action: "create_new",
    bucketId: undefined,
    bucketType: BucketType.Task,
    title,
    confidence: 0.99,
    reason: "测试数据。",
    question: undefined,
  };
  const outcome = store.archive(
    `${title} 的初始记录`,
    decision,
    minimalExtraction(`${title} 摘要`),
    AUDIT,
  );
  return { bucketId: outcome.bucketId!, entryId: outcome.entryId! };
}

test("explicit correction projects the durable move audit", () => {
  const { store, service } = setup();
  const target = createBucket(store, "接口稳定性");
  const source = createBucket(store, "误分类 Bucket");

  const result = service.moveEntry(
    source.entryId,
    target.bucketId,
    "移到接口稳定性里",
  );

  assert.equal(result.action, "move_entry");
  assert.equal(result.targetType, "entry");
  assert.equal(result.entryId, source.entryId);
  assert.equal(result.sourceBucketId, source.bucketId);
  assert.equal(result.targetBucketId, target.bucketId);
  assert.equal(result.entry.bucketId, target.bucketId);
  const audit = store.database
    .prepare("SELECT id, command_text FROM corrections WHERE id = ?")
    .get(result.correctionId) as { id: string; command_text: string };
  assert.equal(audit.command_text, "移到接口稳定性里");
});

test("moveLatestEntry accepts an explicit target and the final command destination", () => {
  const { store, service } = setup();
  const firstTarget = createBucket(store, "支付问题");
  const finalTarget = createBucket(store, "接口稳定性问题");
  const source = createBucket(store, "最近误分类");

  const parsed = service.moveLatestEntry(
    "刚才那条不要放到支付问题，放到接口稳定性问题里。",
  );
  assert.equal(parsed.entryId, source.entryId);
  assert.equal(parsed.targetBucketId, finalTarget.bucketId);

  const nextSource = createBucket(store, "下一条误分类");
  const explicit = service.moveLatestEntry(
    "移动最近一条",
    firstTarget.bucketId,
  );
  assert.equal(explicit.entryId, nextSource.entryId);
  assert.equal(explicit.targetBucketId, firstTarget.bucketId);
});

test("target resolution prefers an exact title and rejects ambiguous fragments", () => {
  const { store, service } = setup();
  const exact = createBucket(store, "API");
  createBucket(store, "API rollout");
  const source = createBucket(store, "待移动");

  const resolved = service.moveLatestEntry("请移到 API 中");
  assert.equal(resolved.entryId, source.entryId);
  assert.equal(resolved.targetBucketId, exact.bucketId);

  createBucket(store, "接口 A");
  createBucket(store, "接口 B");
  createBucket(store, "另一个待移动");
  assert.throws(
    () => service.moveLatestEntry("请移到 接口 中"),
    (error: unknown) =>
      error instanceof CorrectionError && error.kind === "ambiguous_target",
  );
});

test("invalid correction commands fail without a move or audit", () => {
  const { store, service } = setup();
  const source = createBucket(store, "来源");
  const before = store.getEntry(source.entryId)!;
  const correctionCount = () =>
    (
      store.database
        .prepare("SELECT COUNT(*) AS count FROM corrections")
        .get() as {
        count: number;
      }
    ).count;

  assert.throws(
    () => service.moveLatestEntry("移动最近一条"),
    (error: unknown) =>
      error instanceof CorrectionError && error.kind === "unrecognized_target",
  );
  assert.throws(
    () => service.moveLatestEntry("请移到 不存在 中"),
    (error: unknown) =>
      error instanceof CorrectionError && error.kind === "target_not_found",
  );
  assert.throws(
    () => service.moveEntry(source.entryId, source.bucketId, "不能原地移动"),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "invalid_write",
  );
  assert.throws(
    () => service.moveEntry(source.entryId, "missing", "移动到缺失 Bucket"),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "missing_record",
  );
  assert.equal(store.getEntry(source.entryId)!.bucketId, before.bucketId);
  assert.equal(correctionCount(), 0);
});

test("delete correction methods retain stable application projections", () => {
  const { store, service } = setup();
  const entryTarget = createBucket(store, "删除 Entry");
  const entryResult = service.deleteEntry(entryTarget.entryId, "删除错误记录");
  assert.deepEqual(entryResult, {
    action: "delete_entry",
    targetType: "entry",
    targetId: entryTarget.entryId,
  });
  assert.equal(store.getEntry(entryTarget.entryId), undefined);

  const bucketTarget = createBucket(store, "删除 Bucket");
  const bucketResult = service.deleteBucket(
    bucketTarget.bucketId,
    "删除错误主题",
  );
  assert.deepEqual(bucketResult, {
    action: "delete_bucket",
    targetType: "bucket",
    targetId: bucketTarget.bucketId,
  });
  assert.equal(store.getBucket(bucketTarget.bucketId), undefined);
});

test("correction target parser uses the final destination", () => {
  assert.equal(
    targetTitleFromCommand("刚才那条不要放到支付问题，放到接口稳定性问题里。"),
    "接口稳定性问题",
  );
  assert.equal(targetTitleFromCommand("请移到 API rollout 中"), "API rollout");
  assert.equal(targetTitleFromCommand("移动最近一条"), undefined);
  assert.equal(targetTitleFromCommand("放到   里"), undefined);
});
