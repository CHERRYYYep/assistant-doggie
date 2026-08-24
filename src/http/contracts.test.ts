import assert from "node:assert/strict";
import { test } from "node:test";

import { ApplicationError } from "../application/archive.ts";
import { BucketStatus, BucketType } from "../domain/types.ts";
import { StorageError } from "../storage/database.ts";
import type { BucketDetail, BucketRow } from "../storage/store.ts";
import {
  archiveRequestSchema,
  chatConfirmationRequestSchema,
  memoryQueryRequestSchema,
  projectBucketDetail,
  stableError,
} from "./contracts.ts";

const bucket: BucketRow = {
  id: "bucket-1",
  title: "接口 A",
  kind: BucketType.Experiment,
  lifecycle: BucketStatus.Active,
  summary: "压测摘要",
  tags: ["Payments"],
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:01:00.000Z",
  lastActiveAt: "2026-08-24T00:01:00.000Z",
  archivedAt: null,
};

const detail: BucketDetail = {
  bucket,
  entries: [
    {
      id: "entry-1",
      bucketId: bucket.id,
      rawText: "p99 升到 620ms",
      summary: "p99 回归",
      contentType: "text/plain",
      classificationConfidence: 0.99,
      classificationReason: "明确匹配",
      createdAt: "2026-08-24T00:01:00.000Z",
      movedFromBucketId: null,
      archiveState: "archived",
    },
  ],
  memories: [
    {
      id: "memory-1",
      bucketId: bucket.id,
      entryId: "entry-1",
      kind: "evidence",
      text: "压测报告 #12",
      status: null,
      dueAt: null,
      occurredAt: null,
      source: "llm",
      reason: null,
      createdAt: "2026-08-24T00:01:00.000Z",
      updatedAt: "2026-08-24T00:01:00.000Z",
      metadata: {},
    },
  ],
};

test("HTTP request DTOs trim values, reject extras and keep bounded defaults", () => {
  assert.deepEqual(archiveRequestSchema.parse({ text: " 事实 " }), {
    text: "事实",
  });
  assert.throws(() => archiveRequestSchema.parse({ text: "x", extra: true }));
  assert.deepEqual(memoryQueryRequestSchema.parse({ query: " 接口 A " }), {
    query: "接口 A",
    limit: 20,
    statuses: [],
    structured_filters: [],
  });
  assert.throws(() =>
    memoryQueryRequestSchema.parse({ query: "x", limit: 101 }),
  );
});

test("confirmation DTO is a strict action-discriminated contract", () => {
  assert.deepEqual(
    chatConfirmationRequestSchema.parse({
      confirmation_granted: true,
      action: "append",
      attempt_id: "attempt-1",
      text: "原文",
      bucket_id: "bucket-1",
    }),
    {
      confirmation_granted: true,
      action: "append",
      attempt_id: "attempt-1",
      text: "原文",
      bucket_id: "bucket-1",
    },
  );
  assert.throws(() =>
    chatConfirmationRequestSchema.parse({
      confirmation_granted: false,
      action: "discard",
      attempt_id: "attempt-1",
      text: "原文",
    }),
  );
  assert.throws(() =>
    chatConfirmationRequestSchema.parse({
      confirmation_granted: true,
      action: "discard",
      attempt_id: "attempt-1",
      text: "原文",
      bucket_id: "must-not-be-accepted",
    }),
  );
});

test("route projections expose stable snake_case frontend fields", () => {
  assert.deepEqual(projectBucketDetail(detail), {
    bucket: {
      id: "bucket-1",
      title: "接口 A",
      type: "experiment",
      status: "active",
      summary: "压测摘要",
      tags: ["Payments"],
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:01:00.000Z",
      last_active_at: "2026-08-24T00:01:00.000Z",
      archived_at: null,
    },
    entries: [
      {
        id: "entry-1",
        bucket_id: "bucket-1",
        raw_text: "p99 升到 620ms",
        summary: "p99 回归",
        content_type: "text/plain",
        classification_confidence: 0.99,
        classification_reason: "明确匹配",
        created_at: "2026-08-24T00:01:00.000Z",
        moved_from_bucket_id: null,
        archive_state: "archived",
      },
    ],
    memories: [
      {
        id: "memory-1",
        bucket_id: "bucket-1",
        entry_id: "entry-1",
        kind: "evidence",
        text: "压测报告 #12",
        status: null,
        due_at: null,
        occurred_at: null,
        source: "llm",
        reason: null,
        created_at: "2026-08-24T00:01:00.000Z",
        updated_at: "2026-08-24T00:01:00.000Z",
        metadata: {},
      },
    ],
  });
});

test("all boundary failures use stable JSON and do not leak unknown errors", () => {
  assert.deepEqual(stableError(StorageError.missingRecord("buckets", "x")), {
    status: 404,
    body: { ok: false, error: "buckets has no record with id x" },
  });
  assert.deepEqual(
    stableError(StorageError.archiveAttemptNotPending("attempt-1")),
    {
      status: 409,
      body: {
        ok: false,
        error: "archive attempt attempt-1 is not pending",
      },
    },
  );
  assert.deepEqual(
    stableError(
      new ApplicationError("missing_extraction", "extraction is required"),
    ),
    {
      status: 400,
      body: { ok: false, error: "extraction is required" },
    },
  );
  assert.deepEqual(stableError(new Error("secret database path")), {
    status: 500,
    body: { ok: false, error: "internal server error" },
  });
});
