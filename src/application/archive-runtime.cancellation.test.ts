import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { inspect } from "node:util";

import {
  appendExisting,
  askUser,
  createNew,
  type ClassificationResult,
} from "../domain/classification.ts";
import { minimalExtraction, type ExtractionResult } from "../domain/memory.ts";
import { BucketType, type BucketView } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import {
  ArchiveRuntime,
  type MemoryModel,
  type RuntimeConfirmationRequest,
} from "./archive-runtime.ts";
import { ArchiveService } from "./archive.ts";

const secret = "private-cancellation-reason";
const text = "接口 A 错误率升到 12%";

class CancellationModel implements MemoryModel {
  readonly modelName = "fake-cancellation-model";
  readonly calls: {
    readonly kind: "classify" | "extract";
    readonly signal: AbortSignal | undefined;
  }[] = [];
  classification = createNew(BucketType.Task, "新任务", 0.99, "明确事实");
  onClassify: (() => Promise<ClassificationResult>) | undefined;
  onExtract: (() => Promise<ExtractionResult>) | undefined;

  async classify(
    _text: string,
    _candidates: readonly BucketView[],
    signal?: AbortSignal,
  ): Promise<ClassificationResult> {
    this.calls.push({ kind: "classify", signal });
    return this.onClassify === undefined
      ? this.classification
      : this.onClassify();
  }

  async extract(
    _text: string,
    signal?: AbortSignal,
  ): Promise<ExtractionResult> {
    this.calls.push({ kind: "extract", signal });
    return this.onExtract === undefined
      ? minimalExtraction("错误率 12%")
      : this.onExtract();
  }
}

function setup(t: TestContext) {
  const database = openDatabase(":memory:");
  t.after(() => database.close());
  const store = new Store(database);
  const model = new CancellationModel();
  const runtime = new ArchiveRuntime(store, model);
  const service = new ArchiveService(store);
  const audit = {
    candidateBucketIds: [],
    promptVersion: "test-v1",
    modelName: model.modelName,
  } as const;
  const seeded = service.archiveClassifiedInput(
    "基线事实 100%",
    createNew(BucketType.Task, "接口 A", 0.99, "明确事实"),
    minimalExtraction("基线摘要"),
    audit,
  );
  const bucketId = seeded.bucketId;
  assert.ok(bucketId);
  const pending = service.archiveClassifiedInput(
    text,
    askUser(undefined, undefined, 0.5, "需要选择", "存哪里？", [bucketId]),
    undefined,
    { ...audit, candidateBucketIds: [bucketId] },
  );
  return {
    database,
    store,
    model,
    runtime,
    bucketId,
    attemptId: pending.attemptId,
  };
}

/** Compare full rows, not just counts: cancellation must not change dual audit. */
function snapshot(database: DatabaseSync) {
  return [
    "buckets",
    "bucket_tags",
    "entries",
    "memory_items",
    "archive_attempts",
    "pending_actions",
    "corrections",
  ].map((table) =>
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

function sanitizedAbort(error: unknown): boolean {
  assert.ok(error instanceof DOMException);
  assert.equal(error.name, "AbortError");
  assert.equal(error.message, "The operation was aborted");
  assert.doesNotMatch(inspect(error), /private-cancellation-reason/u);
  assert.equal(error.cause, undefined);
  return true;
}

function confirmation(
  action: "append" | "create" | "discard",
  attemptId: string,
  bucketId: string,
): RuntimeConfirmationRequest {
  const binding = { attemptId, rawText: text };
  if (action === "append")
    return { ...binding, action, targetBucketId: bucketId };
  if (action === "create")
    return { ...binding, action, title: "新任务", bucketType: BucketType.Task };
  return { ...binding, action };
}

for (const method of [
  "archive",
  "append",
  "create",
  "confirm_append",
  "confirm_create",
  "confirm_discard",
] as const) {
  test(`pre-aborted ${method} performs no model calls or persistent writes`, async (t) => {
    const { database, model, runtime, bucketId, attemptId } = setup(t);
    const before = snapshot(database);
    const signal = AbortSignal.abort({ secret });
    let pending: Promise<unknown>;
    if (method === "archive")
      pending = runtime.archiveText(text, bucketId, signal);
    else if (method === "append")
      pending = runtime.appendConfirmed(text, bucketId, bucketId, signal);
    else if (method === "create")
      pending = runtime.createConfirmed(
        text,
        "新任务",
        BucketType.Task,
        bucketId,
        signal,
      );
    else
      pending = runtime.confirm(
        confirmation(
          method === "confirm_append"
            ? "append"
            : method === "confirm_create"
              ? "create"
              : "discard",
          attemptId,
          bucketId,
        ),
        signal,
      );
    await assert.rejects(pending, sanitizedAbort);
    assert.deepEqual(model.calls, []);
    assert.deepEqual(snapshot(database), before);
  });
}

for (const action of ["ask_user", "create", "append", "failure"] as const) {
  test(`cancelled ${action} classification cannot extract or persist even if model ignores signal`, async (t) => {
    const { database, model, runtime, bucketId } = setup(t);
    const before = snapshot(database);
    const controller = new AbortController();
    model.onClassify = async () => {
      controller.abort(new Error(secret));
      if (action === "failure") throw new Error(secret);
      if (action === "ask_user")
        return askUser(undefined, undefined, 0.5, "需要选择", "存哪里？", []);
      if (action === "append")
        return appendExisting(bucketId, BucketType.Task, 0.99, "明确事实");
      return model.classification;
    };
    await assert.rejects(
      runtime.archiveText(text, bucketId, controller.signal),
      sanitizedAbort,
    );
    assert.deepEqual(model.calls, [
      { kind: "classify", signal: controller.signal },
    ]);
    assert.deepEqual(snapshot(database), before);
  });
}

for (const method of [
  "archive_create",
  "archive_append",
  "explicit_append",
  "explicit_create",
  "confirm_append",
  "confirm_create",
] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`cancelled extraction in ${method} (${outcome}) leaves all data and pending audits unchanged`, async (t) => {
      const { database, store, model, runtime, bucketId, attemptId } = setup(t);
      const before = snapshot(database);
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const extraction = Promise.withResolvers<ExtractionResult>();
      model.onExtract = () => {
        started.resolve();
        return extraction.promise;
      };
      if (method === "archive_append")
        model.classification = appendExisting(
          bucketId,
          BucketType.Task,
          0.99,
          "明确事实",
        );
      let pending: Promise<unknown>;
      if (method === "archive_create" || method === "archive_append")
        pending = runtime.archiveText(text, bucketId, controller.signal);
      else if (method === "explicit_append")
        pending = runtime.appendConfirmed(
          text,
          bucketId,
          bucketId,
          controller.signal,
        );
      else if (method === "explicit_create")
        pending = runtime.createConfirmed(
          text,
          "新任务",
          BucketType.Task,
          bucketId,
          controller.signal,
        );
      else
        pending = runtime.confirm(
          confirmation(
            method === "confirm_append" ? "append" : "create",
            attemptId,
            bucketId,
          ),
          controller.signal,
        );
      await started.promise;
      controller.abort(new Error(secret));
      if (outcome === "resolve")
        extraction.resolve(minimalExtraction("迟到的模型结果"));
      else extraction.reject(new Error(secret));
      await assert.rejects(pending, sanitizedAbort);
      assert.equal(model.calls.at(-1)?.kind, "extract");
      for (const call of model.calls)
        assert.equal(call.signal, controller.signal);
      assert.deepEqual(snapshot(database), before);
      assert.equal(store.getPendingAction(attemptId)?.status, "pending");
      assert.equal(
        store.getArchiveAttempt(attemptId)?.archiveState,
        "needs_confirmation",
      );
      // A cancelled durable confirmation remains usable, not silently rejected.
      if (method === "confirm_append" || method === "confirm_create") {
        model.onExtract = undefined;
        const saved = await runtime.confirm(
          confirmation(
            method === "confirm_append" ? "append" : "create",
            attemptId,
            bucketId,
          ),
        );
        assert.equal(saved.result.archiveState, "archived");
        assert.equal(store.getPendingAction(attemptId)?.status, "executed");
      }
    });
  }
}

for (const action of ["append", "create", "discard"] as const) {
  test(`confirm ${action} rechecks cancellation after reads, before model/write`, async (t) => {
    const { database, store, model, runtime, bucketId, attemptId } = setup(t);
    const before = snapshot(database);
    const controller = new AbortController();
    const original = store.requirePendingArchiveAttempt.bind(store);
    t.mock.method(
      store,
      "requirePendingArchiveAttempt",
      (id: string, rawText: string) => {
        const attempt = original(id, rawText);
        controller.abort(secret);
        return attempt;
      },
    );
    await assert.rejects(
      runtime.confirm(
        confirmation(action, attemptId, bucketId),
        controller.signal,
      ),
      sanitizedAbort,
    );
    assert.deepEqual(model.calls, []);
    assert.deepEqual(snapshot(database), before);
  });
}

test("cancellation during explicit confirmation prevents cleanup from writing a rejection", async (t) => {
  const { database, store, model, runtime, bucketId } = setup(t);
  const before = snapshot(database);
  const controller = new AbortController();
  const original = store.requirePendingArchiveAttempt.bind(store);
  let writtenAttempt: string | undefined;
  t.mock.method(
    store,
    "requirePendingArchiveAttempt",
    (id: string, rawText: string) => {
      const attempt = original(id, rawText);
      writtenAttempt = id;
      controller.abort(secret);
      return attempt;
    },
  );
  await assert.rejects(
    runtime.appendConfirmed(text, bucketId, bucketId, controller.signal),
    sanitizedAbort,
  );
  assert.ok(writtenAttempt);
  assert.equal(store.getPendingAction(writtenAttempt)?.status, "pending");
  assert.equal(
    store.getArchiveAttempt(writtenAttempt)?.archiveState,
    "needs_confirmation",
  );
  const after = snapshot(database);
  // The proposal predates cancellation; no Entry/Memory or rejection may follow.
  assert.deepEqual(after.slice(0, 4), before.slice(0, 4));
  assert.deepEqual(after[6], before[6]);
  assert.deepEqual(model.calls, [
    { kind: "extract", signal: controller.signal },
  ]);
});

test("legacy focus positions and live optional signals preserve successful archive workflows", async (t) => {
  const { store, model, runtime, bucketId, attemptId } = setup(t);
  const controller = new AbortController();
  const automatic = await runtime.archiveText(
    text,
    bucketId,
    controller.signal,
  );
  const appended = await runtime.appendConfirmed(
    text,
    bucketId,
    bucketId,
    controller.signal,
  );
  const created = await runtime.createConfirmed(
    text,
    "新任务",
    BucketType.Task,
    bucketId,
    controller.signal,
  );
  const confirmed = await runtime.confirm(
    confirmation("append", attemptId, bucketId),
    controller.signal,
  );
  for (const execution of [automatic, appended, created, confirmed]) {
    assert.equal(execution.result.archiveState, "archived");
    assert.equal(
      store.getArchiveAttempt(execution.result.attemptId)?.focusBucketId,
      bucketId,
    );
  }
  for (const call of model.calls) assert.equal(call.signal, controller.signal);
});
