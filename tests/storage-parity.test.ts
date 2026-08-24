/**
 * Storage differential regression guard.
 *
 * `tests/fixtures/storage-parity.json` is generated from the Rust canonical
 * store by running `crates/doggie-storage-sqlite/examples/scenario.rs`. This
 * test replays the same graph of writes through the TypeScript Store and
 * compares every business table after UUID/timestamp normalization.
 *
 * Regenerate after an intentional storage-contract change:
 *
 *   db=$(mktemp /tmp/doggie-rust-parity-XXXX.db)
 *   cargo run -p doggie-storage-sqlite --example scenario --offline -- "$db"
 *   node tests/storage-parity-snapshot.ts "$db" \
 *     > tests/fixtures/storage-parity.json
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExtraction, minimalExtraction } from "../src/domain/memory.ts";
import { BucketType } from "../src/domain/types.ts";
import { openDatabase } from "../src/storage/database.ts";
import {
  Store,
  type ArchiveAudit,
  type ArchiveDecision,
} from "../src/storage/store.ts";
import { snapshotStorage } from "./storage-parity-snapshot.ts";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/storage-parity.json", import.meta.url),
);

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "doggie-v1",
  modelName: "test-model",
};

function steppingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 24, 0, 0, tick++));
}

function pragmaValue(database: ReturnType<typeof openDatabase>, name: string) {
  const row = database.prepare(`PRAGMA ${name}`).get();
  assert.ok(row !== undefined, `PRAGMA ${name} returned no row`);
  return Object.values(row)[0];
}

function createNew(
  title: string,
  bucketType: (typeof BucketType)[keyof typeof BucketType],
  reason: string,
): ArchiveDecision {
  return {
    action: "create_new",
    bucketId: undefined,
    bucketType,
    title,
    confidence: 0.99,
    reason,
    question: undefined,
  };
}

test("storage graph matches the Rust canonical scenario after reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-storage-parity-"));
  const databasePath = join(directory, "typescript.db");
  let database = openDatabase(databasePath);
  const store = new Store(database, steppingClock());

  const first = store.archive(
    "接口 A 压测 p99 620ms",
    createNew("接口 A 压测", BucketType.Experiment, "新实验。"),
    createExtraction({
      summary: "p99 从 320ms 升到 620ms",
      todos: ["定位回归 commit"],
      evidences: ["压测报告 #12"],
      timelineEvents: [{ text: "回归出现", occurredAt: "2026-08-20" }],
      decisions: ["先回滚"],
      hypotheses: ["连接池退化"],
      entities: ["接口 A"],
      tags: ["Payments"],
    }),
    AUDIT,
  );

  store.archive(
    "复测后 p99 回到 340ms",
    {
      action: "append_existing",
      bucketId: first.bucketId,
      bucketType: BucketType.Experiment,
      title: undefined,
      confidence: 0.95,
      reason: "同一实验。",
      question: undefined,
    },
    createExtraction({
      summary: "p99 回到 340ms",
      tags: ["Rust"],
    }),
    AUDIT,
  );

  store.archive(
    "它现在正常了",
    {
      action: "ask_user",
      bucketId: undefined,
      bucketType: undefined,
      title: undefined,
      confidence: 0.4,
      reason: "信息不足。",
      question: "请选择归档目标。",
    },
    undefined,
    AUDIT,
  );

  const misfiled = store.archive(
    "这条应该进接口 A 压测",
    createNew("误建事务", BucketType.Task, "误判。"),
    minimalExtraction("误建摘要"),
    AUDIT,
  );
  store.moveEntry(misfiled.entryId!, first.bucketId!, "移到接口 A 压测。");

  assert.equal(pragmaValue(database, "journal_mode"), "wal");
  assert.equal(pragmaValue(database, "busy_timeout"), 5000);
  assert.equal(pragmaValue(database, "foreign_keys"), 1);

  database.close();
  database = openDatabase(databasePath);
  try {
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as object;
    assert.deepEqual(snapshotStorage(database), expected);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
