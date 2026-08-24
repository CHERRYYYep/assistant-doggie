import assert from "node:assert/strict";
import { test } from "node:test";

import {
  askUser,
  createNew,
  type ClassificationResult,
} from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase, StorageError } from "../storage/database.ts";
import { Store, type ArchiveAudit } from "../storage/store.ts";
import { ApplicationError, ArchiveService } from "./archive.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "classification-v2",
  modelName: "test-model",
};

function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

function setup(): { store: Store; service: ArchiveService } {
  const store = new Store(openDatabase(":memory:"), steppingClock());
  return { store, service: new ArchiveService(store) };
}

function pending(
  service: ArchiveService,
  text = "待确认的原始内容",
  classification: ClassificationResult = askUser(
    BucketType.Experiment,
    "接口 B 压测",
    0.6,
    "建议新建，但需要确认。",
    "请选择归档方式。",
    [],
  ),
): ReturnType<ArchiveService["archiveClassifiedInput"]> {
  return service.archiveClassifiedInput(text, classification, undefined, AUDIT);
}

function createBucket(service: ArchiveService, title: string): string {
  return service.archiveClassifiedInput(
    `${title} 第一条`,
    createNew(BucketType.Task, title, 0.99, "明确的新任务。"),
    minimalExtraction(`${title} 摘要`),
    AUDIT,
  ).bucketId!;
}

test("ask_user preserves a suggested new Bucket without writing formal memory", () => {
  const { store, service } = setup();
  const result = pending(service);

  assert.equal(result.archiveState, "needs_confirmation");
  assert.equal(result.bucketTitle, "接口 B 压测");
  assert.equal(result.bucketType, BucketType.Experiment);
  assert.equal(result.question, "请选择归档方式。");
  assert.deepEqual(result.candidateBucketIds, []);
  const counts = store.database
    .prepare(
      `SELECT (SELECT COUNT(*) FROM buckets) AS buckets,
              (SELECT COUNT(*) FROM entries) AS entries,
              (SELECT COUNT(*) FROM memory_items) AS memories`,
    )
    .get() as Record<string, number>;
  assert.deepEqual({ ...counts }, { buckets: 0, entries: 0, memories: 0 });
});

test("automatic actions require extraction and ask_user rejects it", () => {
  const { service } = setup();
  assert.throws(
    () =>
      service.archiveClassifiedInput(
        "明确事实",
        createNew(BucketType.Task, "任务", 0.99, "明确。"),
        undefined,
        AUDIT,
      ),
    (error: unknown) =>
      error instanceof ApplicationError && error.kind === "missing_extraction",
  );
  assert.throws(
    () =>
      service.archiveClassifiedInput(
        "模糊内容",
        askUser(undefined, undefined, 0.4, "不确定。", "请确认。"),
        minimalExtraction("不应存在"),
        AUDIT,
      ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.kind === "unexpected_extraction",
  );
});

test("confirmation requires a pending attempt and exact original text", () => {
  const { store, service } = setup();
  const attempt = pending(service);
  const targetBucketId = createBucket(service, "目标 Bucket");

  assert.throws(
    () =>
      service.confirm({
        action: "append",
        attemptId: "missing-attempt",
        rawText: "待确认的原始内容",
        targetBucketId,
        extraction: minimalExtraction("确认摘要"),
        modelName: "test-model",
      }),
    (error: unknown) =>
      error instanceof StorageError &&
      error.kind === "archive_attempt_not_found",
  );
  assert.throws(
    () =>
      service.confirm({
        action: "append",
        attemptId: attempt.attemptId,
        rawText: "被篡改的内容",
        targetBucketId,
        extraction: minimalExtraction("确认摘要"),
        modelName: "test-model",
      }),
    (error: unknown) =>
      error instanceof StorageError &&
      error.kind === "archive_attempt_text_mismatch",
  );
  assert.equal(
    store.getArchiveAttempt(attempt.attemptId)!.archiveState,
    "needs_confirmation",
  );
});

test("append and append_alternative are explicit one-shot confirmation writes", () => {
  for (const action of ["append", "append_alternative"] as const) {
    const { store, service } = setup();
    const preferred = createBucket(service, "推荐 Bucket");
    const alternative = createBucket(service, "备选 Bucket");
    const attempt = pending(
      service,
      `待确认-${action}`,
      askUser(undefined, undefined, 0.5, "有多个候选。", "请选择。", [
        preferred,
        alternative,
      ]),
    );
    const targetBucketId = action === "append" ? preferred : alternative;

    const confirmed = service.confirm({
      action,
      attemptId: attempt.attemptId,
      rawText: `待确认-${action}`,
      targetBucketId,
      extraction: minimalExtraction("用户确认后的摘要"),
      modelName: "test-model",
    });

    assert.equal(confirmed.archiveState, "archived");
    assert.equal(confirmed.bucketId, targetBucketId);
    assert.equal(confirmed.sourceAttemptId, attempt.attemptId);
    assert.equal(store.getEntry(confirmed.entryId!)!.bucketId, targetBucketId);
    const resolved = store.getArchiveAttempt(attempt.attemptId)!;
    assert.equal(resolved.archiveState, "archived");
    assert.equal(resolved.entryId, confirmed.entryId);
    assert.throws(
      () =>
        service.confirm({
          action,
          attemptId: attempt.attemptId,
          rawText: `待确认-${action}`,
          targetBucketId,
          extraction: minimalExtraction("重复确认"),
          modelName: "test-model",
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.kind === "archive_attempt_not_pending",
    );
  }
});

test("create confirmation uses explicit title and type without classification", () => {
  const { store, service } = setup();
  const attempt = pending(service, "创建确认内容");
  const confirmed = service.confirm({
    action: "create",
    attemptId: attempt.attemptId,
    rawText: "创建确认内容",
    title: "用户指定标题",
    bucketType: BucketType.Decision,
    extraction: minimalExtraction("用户确认创建"),
    modelName: "test-model",
  });

  assert.equal(confirmed.action, "create_new");
  assert.equal(confirmed.bucketTitle, "用户指定标题");
  assert.equal(confirmed.bucketType, BucketType.Decision);
  assert.equal(store.getBucket(confirmed.bucketId!)!.title, "用户指定标题");
});

test("discard resolves the attempt without creating formal memory", () => {
  const { store, service } = setup();
  const attempt = pending(service, "不需要保存的临时内容");
  const result = service.confirm({
    action: "discard",
    attemptId: attempt.attemptId,
    rawText: "不需要保存的临时内容",
  });

  assert.equal(result.archiveState, "discarded");
  assert.equal(result.sourceAttemptId, attempt.attemptId);
  assert.equal(
    store.getArchiveAttempt(attempt.attemptId)!.archiveState,
    "discarded",
  );
  const entries = store.database
    .prepare("SELECT COUNT(*) AS count FROM entries")
    .get() as {
    count: number;
  };
  assert.equal(entries.count, 0);
  assert.throws(
    () =>
      service.confirm({
        action: "discard",
        attemptId: attempt.attemptId,
        rawText: "不需要保存的临时内容",
      }),
    (error: unknown) =>
      error instanceof StorageError &&
      error.kind === "archive_attempt_not_pending",
  );
});

test("non-active and deleted confirmation targets leave the attempt pending", () => {
  for (const targetState of ["paused", "deleted"] as const) {
    const { store, service } = setup();
    const targetBucketId = createBucket(service, `目标-${targetState}`);
    if (targetState === "paused") {
      store.database
        .prepare("UPDATE buckets SET lifecycle = 'paused' WHERE id = ?")
        .run(targetBucketId);
    } else {
      store.deleteBucket(targetBucketId, "删除确认目标");
    }
    const attempt = pending(service, `待确认-${targetState}`);

    assert.throws(
      () =>
        service.confirm({
          action: "append",
          attemptId: attempt.attemptId,
          rawText: `待确认-${targetState}`,
          targetBucketId,
          extraction: minimalExtraction("不得写入"),
          modelName: "test-model",
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        (targetState === "paused"
          ? error.kind === "inactive_bucket"
          : error.kind === "missing_record"),
    );
    const unresolved = store.getArchiveAttempt(attempt.attemptId)!;
    assert.equal(unresolved.archiveState, "needs_confirmation");
    assert.equal(unresolved.resolvedAt, null);
  }
});
