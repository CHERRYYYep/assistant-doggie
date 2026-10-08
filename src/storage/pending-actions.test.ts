import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import { ArchiveService } from "../application/archive.ts";
import { askUser, createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import {
  pendingActionDraftSchema,
  type DeferredActionDraft,
} from "../domain/pending-action.ts";
import { BucketType } from "../domain/types.ts";
import { DoggieMcpTools } from "../mcp/tools.ts";
import { openDatabase, StorageError } from "./database.ts";
import { MIGRATIONS, SCHEMA_KIND } from "./schema.ts";
import { Store } from "./store.ts";

const audit = {
  candidateBucketIds: [],
  promptVersion: "test-v1",
  modelName: "fake",
} as const;
const agentDraft: DeferredActionDraft = {
  kind: "agent_task",
  payload: { instruction: "检查接口 A", workspaceId: null },
};

function setup(t: TestContext) {
  const database = openDatabase(":memory:");
  t.after(() => database.close());
  const store = new Store(database);
  const service = new ArchiveService(store);
  return { store, service, database };
}

function proposal(service: ArchiveService, text = "接口 A 更新了") {
  return service.archiveClassifiedInput(
    text,
    askUser(undefined, undefined, 0.4, "需要确认", "存哪里？", []),
    undefined,
    audit,
  );
}

function confirmCreate(
  service: ArchiveService,
  attemptId: string,
  rawText: string,
) {
  return service.confirm({
    action: "create",
    attemptId,
    rawText,
    title: "接口 A",
    bucketType: BucketType.Task,
    extraction: minimalExtraction("确认事实"),
    modelName: "fake",
  });
}

function count(database: DatabaseSync, table: string): number {
  const value = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get();
  assert.ok(value !== undefined);
  assert.equal(typeof value["count"], "number");
  return Number(value["count"]);
}

const invalidWrite = (error: unknown) =>
  error instanceof StorageError && error.kind === "invalid_write";

test("archive proposal is durable data only, execution records the exact user choice", (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service);
  const row = store.getPendingAction(pending.attemptId);
  assert.equal(row?.kind, "archive");
  assert.equal(row?.status, "pending");
  assert.equal(row?.binding, "接口 A 更新了");
  assert.equal(row?.proposedBy, "model");
  for (const table of ["buckets", "entries", "memory_items"])
    assert.equal(count(database, table), 0);
  const result = confirmCreate(service, pending.attemptId, "接口 A 更新了");
  const executed = store.getPendingAction(pending.attemptId);
  assert.equal(executed?.status, "executed");
  assert.deepEqual(executed?.approval, {
    action: "create",
    title: "接口 A",
    bucketType: BucketType.Task,
  });
  assert.deepEqual(executed?.result, {
    bucketId: result.bucketId,
    entryId: result.entryId,
    resultAttemptId: result.attemptId,
  });
  assert.throws(() =>
    confirmCreate(service, pending.attemptId, "接口 A 更新了"),
  );
});

test("archive rejection has no formal memory and generic methods cannot bypass confirmation", (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service);
  assert.throws(
    () => store.approvePendingAction(pending.attemptId, "接口 A 更新了"),
    invalidWrite,
  );
  assert.throws(
    () => store.rejectPendingAction(pending.attemptId, "接口 A 更新了"),
    invalidWrite,
  );
  service.confirm({
    action: "discard",
    attemptId: pending.attemptId,
    rawText: "接口 A 更新了",
  });
  assert.equal(store.getPendingAction(pending.attemptId)?.status, "rejected");
  assert.equal(count(database, "entries"), 0);
  assert.throws(() =>
    confirmCreate(service, pending.attemptId, "接口 A 更新了"),
  );
});

test("archive graph, approval and audit roll back together if final execution persistence fails", (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service);
  database.exec(`CREATE TRIGGER fail_execution BEFORE UPDATE OF status ON pending_actions
    WHEN NEW.status = 'executed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() =>
    confirmCreate(service, pending.attemptId, "接口 A 更新了"),
  );
  assert.equal(store.getPendingAction(pending.attemptId)?.status, "pending");
  assert.equal(store.getPendingAction(pending.attemptId)?.approval, null);
  assert.equal(
    store.getArchiveAttempt(pending.attemptId)?.archiveState,
    "needs_confirmation",
  );
  assert.equal(count(database, "archive_attempts"), 1);
  for (const table of ["buckets", "entries", "memory_items"])
    assert.equal(count(database, table), 0);
  database.exec("DROP TRIGGER fail_execution");
  confirmCreate(service, pending.attemptId, "接口 A 更新了");
});

test("generic action kinds enforce binding, approval before completion and one-shot transitions", (t) => {
  const { store, database } = setup(t);
  const drafts: readonly DeferredActionDraft[] = [
    agentDraft,
    { kind: "scheduled_run", payload: { scheduleId: "schedule-1" } },
    {
      kind: "bulk_mutation",
      payload: {
        operation: "delete_entries",
        entryIds: ["entry-1"],
        targetBucketId: null,
      },
    },
  ];
  for (const draft of drafts) {
    const row = store.proposePendingAction(draft, "原始用户要求", "user");
    assert.throws(
      () => store.approvePendingAction(row.id, "伪造要求"),
      invalidWrite,
    );
    assert.throws(
      () =>
        store.finishPendingAction(row.id, row.binding, {
          status: "executed",
          result: {},
        }),
      invalidWrite,
    );
    store.approvePendingAction(row.id, row.binding);
    assert.equal(store.getPendingAction(row.id)?.status, "approved");
    assert.throws(
      () => store.approvePendingAction(row.id, row.binding),
      invalidWrite,
    );
    assert.throws(
      () => store.rejectPendingAction(row.id, row.binding),
      invalidWrite,
    );
    store.finishPendingAction(row.id, row.binding, {
      status: "executed",
      result: { referenceId: "result-1" },
    });
    assert.equal(store.getPendingAction(row.id)?.status, "executed");
    assert.throws(
      () =>
        store.finishPendingAction(row.id, row.binding, {
          status: "executed",
          result: {},
        }),
      invalidWrite,
    );
  }
  assert.equal(count(database, "entries"), 0);
});

test("rejected and failed actions are terminal; failures accept stable codes, not secrets or stack traces", (t) => {
  const { store } = setup(t);
  const rejected = store.proposePendingAction(agentDraft, "拒绝", "model");
  store.rejectPendingAction(rejected.id, rejected.binding);
  assert.throws(
    () => store.approvePendingAction(rejected.id, rejected.binding),
    invalidWrite,
  );
  const failed = store.proposePendingAction(agentDraft, "失败", "schedule");
  store.approvePendingAction(failed.id, failed.binding);
  assert.throws(
    () =>
      store.finishPendingAction(failed.id, failed.binding, {
        status: "failed",
        failureCode: "Error: secret-key",
      }),
    invalidWrite,
  );
  assert.equal(store.getPendingAction(failed.id)?.status, "approved");
  store.finishPendingAction(failed.id, failed.binding, {
    status: "failed",
    failureCode: "executor_unavailable",
  });
  assert.equal(
    store.getPendingAction(failed.id)?.failureCode,
    "executor_unavailable",
  );
  assert.throws(
    () =>
      store.finishPendingAction(failed.id, failed.binding, {
        status: "executed",
        result: {},
      }),
    invalidWrite,
  );
});

test("proposal schemas reject unknown fields, unknown kinds, malformed payload and oversized data", (t) => {
  const { store, database } = setup(t);
  assert.equal(
    pendingActionDraftSchema.safeParse({ ...agentDraft, extra: true }).success,
    false,
  );
  assert.equal(
    pendingActionDraftSchema.safeParse({ kind: "shell", payload: {} }).success,
    false,
  );
  assert.equal(
    pendingActionDraftSchema.safeParse({
      kind: "agent_task",
      payload: { ...agentDraft.payload, command: "rm -rf" },
    }).success,
    false,
  );
  assert.throws(
    () =>
      store.proposePendingAction(
        {
          kind: "agent_task",
          payload: { instruction: " ", workspaceId: null },
        },
        "有效",
        "model",
      ),
    invalidWrite,
  );
  assert.throws(
    () =>
      store.proposePendingAction(
        {
          kind: "agent_task",
          payload: { instruction: "汉".repeat(16_000), workspaceId: null },
        },
        "有效",
        "model",
      ),
    invalidWrite,
  );
  assert.equal(count(database, "pending_actions"), 0);
});

test("the stored immutable proposal cannot be rewritten after approval", (t) => {
  const { store, database } = setup(t);
  const row = store.proposePendingAction(agentDraft, "绑定要求", "user");
  store.approvePendingAction(row.id, row.binding);
  for (const field of ["binding_text", "payload_json", "kind", "proposed_by"]) {
    assert.throws(() =>
      database
        .prepare(`UPDATE pending_actions SET ${field} = ? WHERE id = ?`)
        .run("forged", row.id),
    );
  }
  assert.equal(store.getPendingAction(row.id)?.binding, "绑定要求");
});

test("MCP proposal uses the same pending action authority and never creates formal memory", (t) => {
  const { store, database } = setup(t);
  const result = new DoggieMcpTools(store).proposeEntry("发布检查结果 100 QPS");
  assert.ok(
    result !== null && !Array.isArray(result) && typeof result === "object",
  );
  assert.ok("attempt_id" in result && typeof result["attempt_id"] === "string");
  const row = store.getPendingAction(result["attempt_id"]);
  assert.equal(row?.kind, "archive");
  assert.equal(row?.status, "pending");
  assert.equal(count(database, "entries"), 0);
  assert.equal(count(database, "conversation_messages"), 1);
});

test("explicit append/create HTTP use cases now share durable pending confirmation, not a parallel write path", async (t) => {
  const { store } = setup(t);
  const model: MemoryModel = {
    modelName: "fake",
    classify: async () => {
      throw new Error("must not classify");
    },
    extract: async () => minimalExtraction("明确确认"),
  };
  const runtime = new ArchiveRuntime(store, model);
  const created = await runtime.createConfirmed(
    "用户事实 100 QPS",
    "接口 A",
    BucketType.Task,
  );
  assert.ok(created.result.sourceAttemptId !== undefined);
  assert.equal(
    store.getPendingAction(created.result.sourceAttemptId)?.proposedBy,
    "user",
  );
  assert.equal(
    store.getPendingAction(created.result.sourceAttemptId)?.status,
    "executed",
  );
  assert.ok(created.result.bucketId !== undefined);
  const appended = await runtime.appendConfirmed(
    "追加事实 120 QPS",
    created.result.bucketId,
  );
  assert.ok(appended.result.sourceAttemptId !== undefined);
  assert.deepEqual(
    store.getPendingAction(appended.result.sourceAttemptId)?.approval,
    { action: "append", targetBucketId: created.result.bucketId },
  );
  assert.equal(
    store.getBucketDetail(created.result.bucketId)?.entries.length,
    2,
  );
});

test("concurrent confirmations can extract twice but only one transaction executes", async (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let extractions = 0;
  const model: MemoryModel = {
    modelName: "fake",
    classify: async () => createNew(BucketType.Task, "接口 A", 1, "事实"),
    extract: async () => {
      extractions += 1;
      if (extractions === 2) release?.();
      await gate;
      return minimalExtraction("确认事实");
    },
  };
  const runtime = new ArchiveRuntime(store, model);
  const request = {
    action: "create",
    attemptId: pending.attemptId,
    rawText: "接口 A 更新了",
    title: "接口 A",
    bucketType: BucketType.Task,
  } as const;
  const results = await Promise.allSettled([
    runtime.confirm(request),
    runtime.confirm(request),
  ]);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(count(database, "entries"), 1);
  assert.equal(store.getPendingAction(pending.attemptId)?.status, "executed");
});

test("v2 migration backfills pending/resolved archive IDs and preserves audit without replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-pending-migration-"));
  const path = join(directory, "migration.db");
  try {
    const old = new DatabaseSync(path);
    try {
      for (const migration of MIGRATIONS.slice(0, 2)) {
        old.exec(migration.sql);
        old
          .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
          .run(migration.version, migration.name, "2026-08-25T00:00:00Z");
      }
      old
        .prepare("INSERT INTO schema_meta VALUES (?, ?), (?, ?)")
        .run("schema_kind", SCHEMA_KIND, "schema_version", "2");
      for (const [id, state, resolved] of [
        ["pending", "needs_confirmation", null],
        ["executed", "archived", "2026-08-26T00:00:00Z"],
        ["discarded", "discarded", "2026-08-26T00:00:00Z"],
      ]) {
        old
          .prepare(
            `INSERT INTO archive_attempts (id, raw_text, action, archive_state, confidence, reason, prompt_version, model_name, created_at, resolved_at)
          VALUES (?, '原始内容', 'ask_user', ?, 0.4, '需要确认', 'test-v1', 'fake', '2026-08-25T00:00:00Z', ?)`,
          )
          .run(id ?? null, state ?? null, resolved ?? null);
      }
    } finally {
      old.close();
    }
    const database = openDatabase(path);
    try {
      const store = new Store(database);
      assert.equal(store.getPendingAction("pending")?.status, "pending");
      assert.equal(store.getPendingAction("executed")?.status, "executed");
      assert.equal(store.getPendingAction("discarded")?.status, "rejected");
      assert.equal(store.getPendingAction("pending")?.binding, "原始内容");
      confirmCreate(new ArchiveService(store), "pending", "原始内容");
    } finally {
      database.close();
    }
    const reopened = openDatabase(path);
    try {
      const store = new Store(reopened);
      assert.equal(store.getPendingAction("pending")?.status, "executed");
      assert.equal(count(reopened, "pending_actions"), 3);
      assert.throws(() =>
        confirmCreate(new ArchiveService(store), "pending", "原始内容"),
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved non-archive actions survive reopening without being dispatched", () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-pending-reopen-"));
  const path = join(directory, "actions.db");
  try {
    const database = openDatabase(path);
    const store = new Store(database);
    const row = store.proposePendingAction(agentDraft, "任务要求", "user");
    store.approvePendingAction(row.id, row.binding);
    database.close();
    const reopened = openDatabase(path);
    try {
      const next = new Store(reopened);
      assert.equal(next.getPendingAction(row.id)?.status, "approved");
      assert.equal(count(reopened, "entries"), 0);
      next.finishPendingAction(row.id, row.binding, {
        status: "failed",
        failureCode: "not_implemented",
      });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive proposal budget preserves large HTTP input and the full 16,000-character MCP Unicode limit", (t) => {
  const { store, service } = setup(t);
  const text = "发布事实 ".repeat(8_000);
  const pending = proposal(service, text);
  assert.equal(store.getPendingAction(pending.attemptId)?.binding, text.trim());
  const tools = new DoggieMcpTools(store);
  const result = tools.proposeEntry("汉".repeat(16_000));
  assert.ok(
    result !== null && !Array.isArray(result) && typeof result === "object",
  );
  assert.ok("attempt_id" in result && typeof result["attempt_id"] === "string");
  assert.equal(
    store.getPendingAction(result["attempt_id"])?.binding,
    "汉".repeat(16_000),
  );
});

test("missing or inconsistent generic approval authority blocks archive execution before extraction", async (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service);
  database
    .prepare("UPDATE pending_actions SET status = 'rejected' WHERE id = ?")
    .run(pending.attemptId);
  let extractionCalls = 0;
  const runtime = new ArchiveRuntime(store, {
    modelName: "fake",
    classify: async () => {
      throw new Error("unexpected classifier");
    },
    extract: async () => {
      extractionCalls += 1;
      return minimalExtraction("不得执行");
    },
  });
  await assert.rejects(
    runtime.confirm({
      action: "create",
      attemptId: pending.attemptId,
      rawText: "接口 A 更新了",
      title: "接口 A",
      bucketType: BucketType.Task,
    }),
  );
  assert.equal(extractionCalls, 0);
  assert.equal(count(database, "entries"), 0);
});

test("runtime completion values cannot reopen approval or accept unknown fields", (t) => {
  const { store } = setup(t);
  const row = store.proposePendingAction(agentDraft, "绑定", "user");
  store.approvePendingAction(row.id, row.binding);
  const before = store.getPendingAction(row.id);
  for (const outcome of [
    { status: "pending" },
    { status: "approved" },
    { status: "rejected" },
    { status: "unknown" },
    null,
    { status: "executed", result: {}, extra: true },
    { status: "failed", failureCode: 123 },
    { status: "executed", result: { command: "run" } },
  ]) {
    assert.throws(
      () =>
        Reflect.apply(store.finishPendingAction, store, [
          row.id,
          row.binding,
          outcome,
        ]),
      invalidWrite,
    );
    assert.deepEqual(store.getPendingAction(row.id), before);
  }
});

test("explicit model failure leaves no invisible proposal and retry performs one archive", async (t) => {
  const { store, database } = setup(t);
  let fail = true;
  const runtime = new ArchiveRuntime(store, {
    modelName: "fake",
    classify: async () => {
      throw new Error("must not classify");
    },
    extract: async () => {
      if (fail) throw new Error("fake model failure");
      return minimalExtraction("事实");
    },
  });
  await assert.rejects(
    runtime.createConfirmed("明确事实", "接口 A", BucketType.Task),
  );
  assert.equal(count(database, "pending_actions"), 0);
  assert.equal(count(database, "archive_attempts"), 0);
  assert.equal(count(database, "entries"), 0);
  fail = false;
  const result = await runtime.createConfirmed(
    "明确事实",
    "接口 A",
    BucketType.Task,
  );
  assert.ok(result.result.sourceAttemptId !== undefined);
  assert.equal(
    store.getPendingAction(result.result.sourceAttemptId)?.status,
    "executed",
  );
  assert.equal(count(database, "entries"), 1);
});

test("failed explicit write terminates its inaccessible one-shot proposal, not an existing confirmation card", async (t) => {
  const { store, database } = setup(t);
  const runtime = new ArchiveRuntime(store, {
    modelName: "fake",
    classify: async () => {
      throw new Error("unexpected classifier");
    },
    extract: async () => minimalExtraction("事实"),
  });
  database.exec(`CREATE TRIGGER fail_explicit_write BEFORE INSERT ON entries
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  await assert.rejects(
    runtime.createConfirmed("明确事实", "接口 A", BucketType.Task),
  );
  assert.equal(count(database, "entries"), 0);
  assert.equal(count(database, "buckets"), 0);
  const row = database.prepare("SELECT id, status FROM pending_actions").get();
  assert.ok(row !== undefined && typeof row["id"] === "string");
  assert.equal(row["status"], "rejected");
  assert.equal(store.getArchiveAttempt(row["id"])?.archiveState, "discarded");
});

test("service and raw store confirmation preserve exact input, not merely trimmed equality", (t) => {
  const { store, service, database } = setup(t);
  const pending = proposal(service, "原始内容");
  assert.throws(() => confirmCreate(service, pending.attemptId, "原始内容 "));
  assert.throws(() =>
    store.discardArchiveAttempt(pending.attemptId, " 原始内容"),
  );
  assert.throws(() =>
    store.archive(
      "原始内容 ",
      createNew(BucketType.Task, "接口 A", 1, "事实"),
      minimalExtraction("事实"),
      { ...audit, confirmationAttemptId: pending.attemptId },
    ),
  );
  assert.throws(() =>
    service.archiveClassifiedInput(
      "原始内容 ",
      createNew(BucketType.Task, "接口 A", 1, "事实"),
      minimalExtraction("事实"),
      { ...audit, confirmationAttemptId: pending.attemptId },
    ),
  );
  assert.equal(store.getPendingAction(pending.attemptId)?.status, "pending");
  assert.equal(count(database, "entries"), 0);
});
