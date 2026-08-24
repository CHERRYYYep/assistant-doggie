import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appendExisting,
  askUser,
  createNew,
} from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketStatus, BucketType } from "../domain/types.ts";
import { openDatabase, StorageError } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import {
  ArchiveRuntime,
  type MemoryModel,
} from "./archive-runtime.ts";

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

class FakeModel implements MemoryModel {
  readonly modelName = "fake-memory-model";
  readonly calls: string[] = [];
  classification = createNew(
    BucketType.Task,
    "默认任务",
    0.99,
    "明确的新任务",
  );
  extraction = minimalExtraction("结构化摘要");

  async classify(text: string, candidates: readonly { id: string }[]) {
    this.calls.push(`classify:${text}:${candidates.map(({ id }) => id).join(",")}`);
    return this.classification;
  }

  async extract(text: string) {
    this.calls.push(`extract:${text}`);
    return this.extraction;
  }
}

function setup() {
  const store = new Store(openDatabase(":memory:"), clock());
  const model = new FakeModel();
  const runtime = new ArchiveRuntime(store, model);
  return { store, model, runtime };
}

async function createBucket(
  runtime: ArchiveRuntime,
  model: FakeModel,
  title: string,
): Promise<string> {
  model.classification = createNew(
    BucketType.Task,
    title,
    0.99,
    "明确的新任务",
  );
  const execution = await runtime.archiveText(`${title}事实 100%`);
  return execution.result.bucketId!;
}

test("runtime combines recent and popular candidates and applies deterministic gates", async () => {
  const { store, model, runtime } = setup();
  const bucketId = await createBucket(runtime, model, "接口 A");
  model.calls.length = 0;
  model.classification = appendExisting(
    bucketId,
    BucketType.Task,
    0.99,
    "看起来相关",
  );

  const execution = await runtime.archiveText("继续");
  assert.equal(execution.result.archiveState, "needs_confirmation");
  assert.equal(store.getBucketDetail(bucketId)?.entries.length, 1);
  assert.deepEqual(model.calls, [`classify:继续:${bucketId}`]);
  assert.deepEqual(execution.result.candidateBucketIds, [bucketId]);
});

test("automatic archive classifies, extracts and writes one complete graph", async () => {
  const { store, model, runtime } = setup();
  model.classification = createNew(
    BucketType.Incident,
    "支付故障",
    0.96,
    "新的明确故障",
  );
  model.extraction = minimalExtraction("错误率升到 12%");

  const execution = await runtime.archiveText("支付错误率升到 12%");
  assert.equal(execution.result.archiveState, "archived");
  assert.equal(execution.bucket?.title, "支付故障");
  assert.equal(store.getEntry(execution.result.entryId!)?.rawText, "支付错误率升到 12%");
  assert.deepEqual(model.calls, [
    "classify:支付错误率升到 12%:",
    "extract:支付错误率升到 12%",
  ]);
});

test("confirmation binds exact text, reuses attempt audit and prevents replay", async () => {
  const { store, model, runtime } = setup();
  const bucketId = await createBucket(runtime, model, "接口 A");
  model.classification = askUser(
    BucketType.Task,
    undefined,
    0.6,
    "需要确认",
    "保存到哪里？",
    [bucketId],
  );
  const pending = await runtime.archiveText("接口 A 更新了");
  model.calls.length = 0;

  await assert.rejects(
    runtime.confirm({
      action: "append",
      attemptId: pending.result.attemptId,
      rawText: "接口 A 更新了 ",
      targetBucketId: bucketId,
    }),
    (error: unknown) =>
      error instanceof StorageError &&
      error.kind === "archive_attempt_text_mismatch",
  );
  assert.deepEqual(model.calls, []);

  const confirmed = await runtime.confirm({
    action: "append",
    attemptId: pending.result.attemptId,
    rawText: "接口 A 更新了",
    targetBucketId: bucketId,
  });
  assert.equal(confirmed.result.archiveState, "archived");
  assert.deepEqual(model.calls, ["extract:接口 A 更新了"]);
  assert.equal(
    store.getArchiveAttempt(pending.result.attemptId)?.resolvedAt !== null,
    true,
  );

  await assert.rejects(
    runtime.confirm({
      action: "discard",
      attemptId: pending.result.attemptId,
      rawText: "接口 A 更新了",
    }),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "archive_attempt_not_pending",
  );
});

test("invalid confirmation target fails before extraction and leaves attempt pending", async () => {
  const { store, model, runtime } = setup();
  const bucketId = await createBucket(runtime, model, "接口 A");
  model.classification = askUser(
    undefined,
    undefined,
    0.5,
    "需要确认",
    "保存到哪里？",
    [bucketId],
  );
  const pending = await runtime.archiveText("更新了");
  store.setBucketStatus(bucketId, BucketStatus.Done);
  model.calls.length = 0;

  await assert.rejects(
    runtime.confirm({
      action: "append",
      attemptId: pending.result.attemptId,
      rawText: "更新了",
      targetBucketId: bucketId,
    }),
    (error: unknown) =>
      error instanceof StorageError && error.kind === "inactive_bucket",
  );
  assert.deepEqual(model.calls, []);
  assert.equal(
    store.getArchiveAttempt(pending.result.attemptId)?.archiveState,
    "needs_confirmation",
  );
});
