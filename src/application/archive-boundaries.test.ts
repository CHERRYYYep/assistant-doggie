import assert from "node:assert/strict";
import { test } from "node:test";
import { appendExisting, createNew } from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase, StorageError } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { ArchiveRuntime, type MemoryModel } from "./archive-runtime.ts";

for (const lifecycle of ["paused", "done", "archived"] as const) {
  test(`runtime rejects a target becoming ${lifecycle} while extraction is in flight`, async () => {
    const store = new Store(openDatabase(":memory:"));
    try {
      const extraction = createExtraction({
        summary: "test summary",
        evidences: ["test evidence"],
      });
      const original = store.archive(
        "test has 10 records",
        createNew(BucketType.Task, "test", 0.99, "fixture"),
        extraction,
        {
          candidateBucketIds: [],
          promptVersion: "test",
          modelName: "fake-model",
        },
      );
      assert.ok(original.bucketId);
      const targetId = original.bucketId;
      let inactiveSnapshot: unknown;
      const model: MemoryModel = {
        modelName: "fake-model",
        async classify(_text, candidates) {
          assert.deepEqual(
            candidates.map(({ id }) => id),
            [targetId],
          );
          return appendExisting(targetId, BucketType.Task, 0.99, "fixture");
        },
        async extract() {
          store.setBucketStatus(targetId, lifecycle);
          inactiveSnapshot = store.getBucketDetail(targetId);
          return extraction;
        },
      };
      const runtime = new ArchiveRuntime(store, model);
      await assert.rejects(
        runtime.archiveText("test has 20 records"),
        (error: unknown) =>
          error instanceof StorageError && error.kind === "inactive_bucket",
      );
      assert.deepEqual(store.getBucketDetail(targetId), inactiveSnapshot);
      const attempts = store.database
        .prepare("SELECT id FROM archive_attempts")
        .all();
      assert.deepEqual(
        attempts.map(({ id }) => id),
        [original.attemptId],
      );
    } finally {
      store.database.close();
    }
  });
}
