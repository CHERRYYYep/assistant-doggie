import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createExtraction, minimalExtraction } from "../domain/memory.ts";
import { TodoStatus } from "../domain/todo.ts";
import { BucketType } from "../domain/types.ts";
import { StorageError, openDatabase } from "./database.ts";
import { MIGRATIONS, SCHEMA_KIND } from "./schema.ts";
import { Store, type ArchiveAudit, type ArchiveDecision } from "./store.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "t14-test",
  modelName: "fake-model",
};

function freshStore(): Store {
  let tick = 0;
  return new Store(openDatabase(":memory:"), () => {
    const date = new Date(Date.UTC(2026, 10, 4, 0, 0, tick));
    tick += 1;
    return date;
  });
}

const createNew = (title: string): ArchiveDecision => ({
  action: "create_new",
  bucketId: undefined,
  bucketType: BucketType.Task,
  title,
  confidence: 0.99,
  reason: "test",
  question: undefined,
});

function todoId(store: Store, bucketId: string): string {
  const todo = store
    .getBucketDetail(bucketId)
    ?.memories.find((memory) => memory.kind === "todo");
  assert.ok(todo);
  return todo.id;
}

function errorKind(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof StorageError);
    return error.kind;
  }
  throw new Error("expected StorageError");
}

test("schema v7 gives TODOs explicit plan columns while preserving legacy due_at", () => {
  const store = freshStore();
  const archive = store.archive(
    "安排回归",
    createNew("回归"),
    createExtraction({ summary: "摘要", todos: ["安排回归"] }),
    AUDIT,
  );
  const id = todoId(store, archive.bucketId!);
  const todo = store.getTodo(id);
  assert.equal(todo?.status, TodoStatus.Open);
  assert.equal(todo?.scheduledAt, null);
  assert.equal(todo?.todoRule, null);
  assert.equal(todo?.todoOccurrence, 1);
  assert.equal(
    store.database
      .prepare(
        "SELECT due_at, scheduled_at, todo_rule_json FROM memory_items WHERE id = ?",
      )
      .get(id)?.["due_at"],
    null,
  );
});

test("TODO plan and status changes are transactional, audited, and version checked", () => {
  const store = freshStore();
  const archive = store.archive(
    "修复回归",
    createNew("修复"),
    createExtraction({ summary: "摘要", todos: ["修复回归"] }),
    AUDIT,
  );
  const id = todoId(store, archive.bucketId!);
  const before = store.getTodo(id)!;
  const planned = store.updateTodoPlan(
    id,
    {
      scheduledAt: "2026-11-04T09:00:00Z",
      dueAt: "2026-11-04T10:00:00Z",
      repeatRule: { frequency: "daily", interval: 1, count: 2 },
      rawTime: {
        scheduledText: "今天上午",
        dueText: "今天十点",
        timeZone: "Asia/Shanghai",
      },
    },
    "set TODO plan",
    before.updatedAt,
  );
  assert.equal(planned.todo.scheduledAt, "2026-11-04T09:00:00.000Z");
  assert.equal(planned.todo.todoOccurrence, 1);
  assert.equal(planned.todo.todoRawTime?.timeZone, "Asia/Shanghai");
  assert.equal(
    errorKind(() =>
      store.transitionTodo(id, "done", "stale", before.updatedAt),
    ),
    "stale_write",
  );
  const inProgress = store.transitionTodo(
    id,
    TodoStatus.InProgress,
    "start work",
    planned.todo.updatedAt,
  );
  assert.equal(inProgress.todo.status, TodoStatus.InProgress);
  assert.ok(
    store.database
      .prepare(
        "SELECT action, target_type FROM corrections WHERE target_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(id)?.["action"] === "todo_transition",
  );
});

test("repeating TODO advances one occurrence and then reaches done at count", () => {
  const store = freshStore();
  const archive = store.archive(
    "每日检查",
    createNew("检查"),
    createExtraction({ summary: "摘要", todos: ["每日检查"] }),
    AUDIT,
  );
  const id = todoId(store, archive.bucketId!);
  const planned = store.updateTodoPlan(
    id,
    {
      scheduledAt: "2026-11-04T09:00:00Z",
      dueAt: "2026-11-04T10:00:00Z",
      repeatRule: { frequency: "daily", interval: 1, count: 2 },
    },
    "repeat TODO",
    store.getTodo(id)!.updatedAt,
  );
  const next = store.advanceRepeatingTodo(
    id,
    "complete occurrence",
    planned.todo.updatedAt,
  );
  assert.equal(next.todo.status, TodoStatus.Open);
  assert.equal(next.todo.scheduledAt, "2026-11-05T09:00:00.000Z");
  assert.equal(next.todo.dueAt, "2026-11-05T10:00:00.000Z");
  assert.equal(next.todo.todoOccurrence, 2);

  const done = store.advanceRepeatingTodo(
    id,
    "complete final occurrence",
    next.todo.updatedAt,
  );
  assert.equal(done.todo.status, TodoStatus.Done);
  assert.equal(done.todo.todoOccurrence, 2);
  assert.equal(
    errorKind(() =>
      store.advanceRepeatingTodo(id, "again", done.todo.updatedAt),
    ),
    "invalid_write",
  );
});

test("Agenda excludes revoked sources and history by default", () => {
  const store = freshStore();
  const first = store.archive(
    "保留任务",
    createNew("保留"),
    minimalExtraction("摘要"),
    AUDIT,
  );
  const second = store.archive(
    "撤销任务",
    createNew("撤销"),
    createExtraction({ summary: "摘要", todos: ["撤销任务"] }),
    AUDIT,
  );
  const firstTodo = store.archive(
    "完成任务",
    { ...createNew("完成"), bucketId: first.bucketId },
    createExtraction({ summary: "摘要", todos: ["完成任务"] }),
    AUDIT,
  );
  const doneId = todoId(store, firstTodo.bucketId!);
  const done = store.getTodo(doneId)!;
  const completed = store.transitionTodo(
    doneId,
    "done",
    "complete",
    done.updatedAt,
  );
  assert.equal(
    store.listAgenda().some((todo) => todo.id === doneId),
    false,
  );
  assert.equal(
    store
      .listAgenda({ includeHistory: true })
      .some((todo) => todo.id === doneId),
    true,
  );
  assert.ok(second.entryId);
  store.deleteEntry(second.entryId, "revoke source");
  assert.equal(
    store
      .listAgenda({ includeHistory: true })
      .some((todo) => todo.text === "撤销任务"),
    false,
  );
  assert.equal(completed.correctionId.length > 0, true);
});

test("schema v7 migration keeps old TODOs open and initializes occurrence", () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-todo-migration-"));
  const path = join(directory, "legacy.sqlite");
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    database.exec("PRAGMA foreign_keys=ON");
    for (const migration of MIGRATIONS.filter((item) => item.version <= 6)) {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations VALUES (?,?,?)")
        .run(migration.version, migration.name, "2026-11-04T00:00:00.000Z");
    }
    database
      .prepare(
        "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','6')",
      )
      .run(SCHEMA_KIND);
    database
      .prepare(
        "INSERT INTO buckets (id,title,kind,lifecycle,summary,created_at,updated_at,last_active_at,archived_at,metadata_json,workspace_id) VALUES ('b','Bucket','task','active','','t','t','t',NULL,'{}',NULL)",
      )
      .run();
    database
      .prepare(
        "INSERT INTO entries (id,bucket_id,raw_text,created_at,archived_at) VALUES ('e','b','legacy','t','t')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO memory_items (id,bucket_id,entry_id,kind,text,status,created_at,updated_at) VALUES ('m','b','e','todo','legacy',NULL,'t','t')",
      )
      .run();
    database.close();
    database = undefined;
    const reopened = openDatabase(path);
    const store = new Store(reopened);
    assert.equal(store.getTodo("m")?.status, TodoStatus.Open);
    assert.equal(store.getTodo("m")?.todoOccurrence, 1);
    reopened.close();
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
