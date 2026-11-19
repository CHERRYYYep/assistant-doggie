import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentCompletion } from "../domain/agent.ts";
import { describeCreatedGoal } from "../application/work-items.ts";
import { WorkItemStore } from "./work-items.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIGRATIONS, SCHEMA_KIND } from "./schema.ts";
import { openDatabase } from "./database.ts";
import { AgentStore } from "./agents.ts";
import { Store } from "./store.ts";
import { TaskStore } from "./tasks.ts";

test("T13 genuine v4 migrates through v5 to the current schema preserving conversation, pending and queued work", () => {
  const root = mkdtempSync(join(tmpdir(), "doggie-v5-test-"));
  const path = join(root, "test.db");
  let db = new DatabaseSync(path);
  try {
    for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    db.prepare(
      "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','4')",
    ).run(SCHEMA_KIND);
    const oldStore = new Store(db);
    oldStore.appendChatMessage({
      role: "user",
      content: "preserve exact evidence",
    });
    const pending = oldStore.proposePendingAction(
      {
        kind: "agent_task",
        payload: { instruction: "pending only", workspaceId: null },
      },
      "pending only",
      "user",
    );
    const queued = new TaskStore(db).enqueue({ message: "queued evidence" });
    db.close();
    db = openDatabase(path);
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get()?.["value"],
      "8",
    );
    assert.equal(
      new Store(db).listChatMessages(10)[0]?.content,
      "preserve exact evidence",
    );
    assert.equal(new Store(db).getPendingAction(pending.id)?.status, "pending");
    assert.equal(new TaskStore(db).get(queued.id).status, "queued");
    assert.deepEqual(new AgentStore(db).tasks(), []);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const proposal = {
  backend: "codex",
  workspaceId: null,
  instruction: "Inspect local evidence",
} as const;

function runningAttempt(db: DatabaseSync, linked: boolean) {
  const agents = new AgentStore(db);
  const tasks = new TaskStore(db);
  const goals = new WorkItemStore(db);
  const goal = linked
    ? goals.create(
        {
          requestId: randomUUID(),
          title: "Backend review",
          goal: "Inspect the evidence",
          acceptance: "Return a source list",
        },
        describeCreatedGoal,
      )
    : null;
  const task =
    goal === null
      ? agents.propose(proposal)
      : agents.proposeForWorkItem(goal.id, {
          ...proposal,
          requestId: randomUUID(),
          expectedRevision: goal.revision,
        });
  const queued = agents.approve(task.id, task.instruction);
  assert.equal(tasks.claim()?.task.id, queued.id);
  agents.start(task.id);
  const memory = new Store(db);
  const read = () => ({
    task: agents.task(task.id),
    action: memory.getPendingAction(task.pendingActionId),
    session: agents.session(task.sessionId),
    queue: tasks.get(queued.id),
    goal: goal === null ? null : goals.get(goal.id),
    events: db
      .prepare("SELECT * FROM work_item_events ORDER BY work_item_id, revision")
      .all(),
  });
  return { agents, tasks, task, queued, read };
}

for (const linked of [false, true]) {
  test(`completion rejects invalid payloads without writes (${linked ? "WorkItem" : "standalone"})`, () => {
    using db = openDatabase(":memory:");
    const { agents, task, read } = runningAttempt(db, linked);
    const success = { status: "succeeded", output: "", failureCode: null };
    const failure = {
      status: "failed",
      output: "",
      failureCode: "process_failed",
    };
    const cancellation = {
      status: "cancelled",
      output: "",
      failureCode: "cancelled",
    };
    const before = read();
    for (const invalid of [
      null,
      { ...success, status: "rejected" },
      { ...success, failureCode: "process_failed" },
      { ...success, remoteId: "not-a-uuid" },
      { ...success, secret: "must-not-leak" },
      { ...failure, failureCode: null },
      { ...failure, failureCode: "cancelled" },
      { ...failure, failureCode: "" },
      { ...failure, failureCode: "invalid error" },
      { ...failure, failureCode: "a".repeat(65) },
      { ...failure, output: "late output" },
      { ...failure, remoteId: randomUUID() },
      { ...cancellation, failureCode: "interrupted" },
      { ...cancellation, output: "late output" },
      { ...cancellation, remoteId: randomUUID() },
    ]) {
      assert.throws(
        () => Reflect.apply(agents.complete, agents, [task.id, invalid]),
        {
          name: "AgentError",
          code: "invalid_event",
          message: "agent: invalid_event",
        },
      );
    }
    assert.throws(
      () =>
        agents.complete(task.id, {
          status: "succeeded",
          failureCode: null,
          output: "é".repeat(32769),
        }),
      { name: "AgentError", code: "output_limit" },
    );
    assert.deepEqual(read(), before);
  });

  for (const outcome of [
    {
      status: "succeeded",
      output: "é".repeat(32768),
      failureCode: null,
      remoteId: randomUUID(),
    },
    { status: "failed", output: "", failureCode: "process_failed" },
    { status: "cancelled", output: "", failureCode: "cancelled" },
  ] as const satisfies readonly AgentCompletion[]) {
    test(`completion projects ${outcome.status} exactly (${linked ? "WorkItem" : "standalone"})`, () => {
      using db = openDatabase(":memory:");
      const { agents, task, read } = runningAttempt(db, linked);
      const before = read();
      agents.complete(task.id, outcome);
      const after = read();
      assert.equal(after.task.status, outcome.status);
      assert.equal(after.task.output, outcome.output);
      assert.equal(after.task.failureCode, outcome.failureCode);
      assert.equal(
        after.action?.status,
        outcome.status === "succeeded" ? "executed" : "failed",
      );
      assert.equal(after.action?.failureCode, outcome.failureCode);
      assert.deepEqual(
        after.action?.result,
        outcome.status === "succeeded" ? { referenceId: task.id } : null,
      );
      assert.equal(
        after.session.remoteId,
        outcome.status === "succeeded" ? outcome.remoteId : null,
      );
      assert.deepEqual(after.queue, before.queue);
      if (linked) {
        assert.equal(after.goal?.lastAttemptId, task.id);
        assert.equal(after.goal?.lastAttemptStatus, outcome.status);
        assert.equal(
          after.goal?.status,
          outcome.status === "succeeded" ? "in_progress" : "blocked",
        );
        assert.equal(after.events.length, before.events.length + 1);
      }
      assert.throws(() => agents.complete(task.id, outcome), /conflict/);
      assert.deepEqual(read(), after);
    });
  }
}

for (const table of [
  "agent_sessions",
  "pending_actions",
  "agent_tasks",
  "work_items",
  "work_item_events",
]) {
  test(`completion rolls back all projections on a ${table} write failure`, () => {
    using db = openDatabase(":memory:");
    const { agents, task, read } = runningAttempt(db, true);
    const before = read();
    const operation = table === "work_item_events" ? "INSERT" : "UPDATE";
    db.exec(
      `CREATE TRIGGER inject_failure BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
    );
    assert.throws(
      () =>
        agents.complete(task.id, {
          status: "succeeded",
          output: "result",
          failureCode: null,
          remoteId: randomUUID(),
        }),
      /injected/,
    );
    assert.deepEqual(read(), before);
  });
}

test("late success is rejected when queue history already ended, even before legacy reconciliation", () => {
  using db = openDatabase(":memory:");
  const { agents, task, queued, read } = runningAttempt(db, false);
  // Simulate stale projections from a prior version, not a normal queue exit.
  db.prepare(
    "UPDATE background_tasks SET status='cancelled',error_code='interrupted' WHERE id=?",
  ).run(queued.id);
  const before = read();
  assert.throws(
    () =>
      agents.complete(task.id, {
        status: "succeeded",
        output: "late result",
        failureCode: null,
        remoteId: randomUUID(),
      }),
    { name: "AgentError", code: "conflict" },
  );
  assert.deepEqual(read(), before);
  agents.reconcile();
  assert.equal(read().task.status, "cancelled");
  assert.equal(read().task.failureCode, "cancelled");
  assert.equal(read().action?.failureCode, "cancelled");
});

test("reopen preserves legacy terminal audit rows and reconciles only outstanding attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "doggie-completion-test-"));
  const path = join(root, "test.db");
  try {
    const ids = (() => {
      using db = openDatabase(path);
      const { agents, tasks, task, queued } = runningAttempt(db, true);
      agents.complete(task.id, {
        status: "failed",
        output: "",
        failureCode: "process_failed",
      });
      tasks.finish(queued.id, "failed");
      // Simulate the legacy failed/null row and its divergent approval.
      db.prepare("UPDATE agent_tasks SET failure_code=NULL WHERE id=?").run(
        task.id,
      );
      db.prepare(
        "UPDATE pending_actions SET failure_code='cancelled' WHERE id=?",
      ).run(task.pendingActionId);
      const outstanding = runningAttempt(db, false);
      return { legacy: task, outstanding: outstanding.task };
    })();
    using db = openDatabase(path);
    const agents = new AgentStore(db);
    const owner = randomUUID();
    const tasks = new TaskStore(db);
    tasks.acquireExecutor(owner);
    assert.equal(agents.task(ids.legacy.id).status, "failed");
    assert.equal(agents.task(ids.legacy.id).failureCode, null);
    assert.equal(
      new Store(db).getPendingAction(ids.legacy.pendingActionId)?.failureCode,
      "cancelled",
    );
    assert.equal(agents.task(ids.outstanding.id).failureCode, "interrupted");
    assert.equal(
      new Store(db).getPendingAction(ids.outstanding.pendingActionId)
        ?.failureCode,
      "interrupted",
    );
    assert.throws(
      () =>
        agents.complete(ids.outstanding.id, {
          status: "succeeded",
          output: "late result",
          failureCode: null,
        }),
      /conflict/,
    );
    tasks.releaseExecutor(owner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
