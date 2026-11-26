import assert from "node:assert/strict";
import { test } from "node:test";

import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store, type ArchiveAudit } from "../storage/store.ts";
import {
  boundedToolResult,
  DoggieMcpTools,
  getBucketDetailInputSchema,
  MAX_MCP_TOOL_OUTPUT_BYTES,
  proposeEntryInputSchema,
  searchMemoryInputSchema,
} from "./tools.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "test-v1",
  modelName: "test-model",
};

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 25, 0, 0, tick++));
}

function setup() {
  const store = new Store(openDatabase(":memory:"), clock());
  const outcome = store.archive(
    "接口 A 压测达到 100 QPS",
    {
      action: "create_new",
      bucketId: undefined,
      bucketType: BucketType.Experiment,
      title: "接口 A 压测",
      confidence: 0.99,
      reason: "明确实验记录",
      question: undefined,
    },
    createExtraction({
      summary: "接口 A 达到 100 QPS",
      evidences: ["压测报告"],
      tags: ["接口A", "压测"],
    }),
    AUDIT,
  );
  return {
    store,
    bucketId: outcome.bucketId!,
    tools: new DoggieMcpTools(store, () => new Date("2026-08-25T00:00:00Z")),
  };
}

function count(store: Store, table: string): number {
  const row = store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

test("T10 read-only MCP tools expose active, search and detail projections without writes", () => {
  const { store, bucketId, tools } = setup();
  const before = {
    attempts: count(store, "archive_attempts"),
    entries: count(store, "entries"),
    messages: count(store, "conversation_messages"),
  };

  const active = tools.listActiveBuckets() as Record<string, unknown>;
  const search = tools.searchMemory("接口 A 压测") as Record<string, unknown>;
  const detail = tools.getBucketDetail(bucketId) as Record<string, unknown>;

  assert.equal((active["buckets"] as unknown[]).length, 1);
  assert.equal(search["total_entries"], 1);
  assert.equal(
    (detail["bucket"] as Record<string, unknown>)["id"] as string,
    bucketId,
  );
  assert.deepEqual(
    {
      attempts: count(store, "archive_attempts"),
      entries: count(store, "entries"),
      messages: count(store, "conversation_messages"),
    },
    before,
  );
});

test("T10 propose_entry creates only a pending attempt and a durable UI confirmation card", () => {
  const { store, bucketId, tools } = setup();
  const entriesBefore = count(store, "entries");
  const memoriesBefore = count(store, "memory_items");

  const result = tools.proposeEntry(
    "接口 A 新一轮压测达到 120 QPS",
    bucketId,
  ) as Record<string, unknown>;

  assert.equal(result["archive_state"], "needs_confirmation");
  assert.equal(result["entry_id"], null);
  assert.equal(result["submitted_for_confirmation"], true);
  assert.equal(result["recommended_bucket_id"], bucketId);
  assert.equal(count(store, "entries"), entriesBefore);
  assert.equal(count(store, "memory_items"), memoriesBefore);

  const attemptId = result["attempt_id"] as string;
  const attempt = store.getArchiveAttempt(attemptId);
  assert.equal(attempt?.archiveState, "needs_confirmation");
  assert.equal(attempt?.bucketId, null);
  assert.equal(attempt?.entryId, null);

  const messages = store.listChatMessages(10);
  const proposal = messages.at(-1);
  assert.equal(proposal?.role, "assistant");
  const details = proposal?.details as Record<string, unknown>;
  assert.equal(details["pending_confirmation"], true);
  assert.equal(details["proposed_by"], "mcp");
  assert.equal(
    (details["archive"] as Record<string, unknown>)["attempt_id"] as string,
    attemptId,
  );
});

test("T10 MCP input schemas are strict and bounded before execution", () => {
  assert.equal(
    searchMemoryInputSchema.safeParse({ query: "x", extra: true }).success,
    false,
  );
  assert.equal(
    getBucketDetailInputSchema.safeParse({ bucket_id: "x".repeat(201) })
      .success,
    false,
  );
  assert.equal(
    proposeEntryInputSchema.safeParse({ text: "x".repeat(16_001) }).success,
    false,
  );
  assert.equal(
    proposeEntryInputSchema.safeParse({ text: "事实", bucket_id: "bucket" })
      .success,
    true,
  );
});

test("MCP proposal rolls back both audits when its confirmation card fails, then retries once", () => {
  const { store, bucketId, tools } = setup();
  const snapshot = () => ({
    attempts: count(store, "archive_attempts"),
    pending: count(store, "pending_actions"),
    entries: count(store, "entries"),
    memories: count(store, "memory_items"),
    messages: count(store, "conversation_messages"),
  });
  const before = snapshot();
  store.database.exec(`
    CREATE TRIGGER reject_mcp_confirmation_card
    BEFORE INSERT ON conversation_messages
    BEGIN
      SELECT RAISE(ABORT, 'confirmation card persistence failed');
    END
  `);

  assert.throws(
    () => tools.proposeEntry("接口 A 新一轮压测达到 120 QPS", bucketId),
    /confirmation card persistence failed/u,
  );
  assert.deepEqual(snapshot(), before);

  store.database.exec("DROP TRIGGER reject_mcp_confirmation_card");
  const result = tools.proposeEntry(
    "接口 A 新一轮压测达到 120 QPS",
    bucketId,
  ) as Record<string, unknown>;
  assert.deepEqual(snapshot(), {
    ...before,
    attempts: before.attempts + 1,
    pending: before.pending + 1,
    messages: before.messages + 1,
  });
  const attemptId = result["attempt_id"] as string;
  assert.equal(store.getPendingAction(attemptId)?.status, "pending");
  const details = store.listChatMessages(10).at(-1)?.details as
    Record<string, unknown> | undefined;
  assert.deepEqual(details?.["archive"], result);
});

test("T10 tool output is replaced by a bounded data error", () => {
  const result = boundedToolResult({
    ok: true,
    text: "x".repeat(MAX_MCP_TOOL_OUTPUT_BYTES),
  }) as Record<string, unknown>;
  assert.equal(result["ok"], false);
  assert.match(String(result["error"]), /tool output exceeds/u);
});
