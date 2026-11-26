import {
  describeCreatedGoal,
  describeUpdatedGoal,
} from "../application/work-items.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, withTransaction } from "./database.ts";
import { WorkItemStore } from "./work-items.ts";
import { AgentStore } from "./agents.ts";
import { TaskStore } from "./tasks.ts";
import { Store } from "./store.ts";
import { MIGRATIONS, SCHEMA_KIND, SCHEMA_VERSION } from "./schema.ts";
import { resolveWorkItem } from "../domain/work-item.ts";
import { createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";

const goal = () => ({
  requestId: randomUUID(),
  title: "审查后端",
  goal: "检查撤销机制",
  acceptance: "给出有来源的问题清单",
});
const attempt = (expectedRevision: number) => ({
  requestId: randomUUID(),
  expectedRevision,
  backend: "codex",
  workspaceId: null,
  instruction: "先阅读代码",
});

test("work item routing honors explicit references, clarifies ambiguity and never picks global latest", () => {
  const items = [
    { id: randomUUID(), title: "后端审查", status: "open" as const },
    { id: randomUUID(), title: "明日计划", status: "open" as const },
    { id: randomUUID(), title: "后端审查", status: "blocked" as const },
  ];
  const first = items[0];
  const plan = items[1];
  assert.ok(first && plan);
  assert.equal(
    resolveWorkItem({ workItemId: first.id }, items).workItemId,
    first.id,
  );
  assert.equal(
    resolveWorkItem({ title: plan.title }, items).workItemId,
    plan.id,
  );
  assert.equal(resolveWorkItem({ title: "后端审查" }, items).kind, "clarify");
  assert.equal(resolveWorkItem({}, items).kind, "clarify");
  assert.equal(resolveWorkItem({}, [first]).kind, "clarify");
  assert.equal(
    resolveWorkItem({ title: "其他目标" }, items).kind,
    "unassigned",
  );
  assert.throws(
    () => resolveWorkItem({ workItemId: randomUUID() }, items),
    /missing/,
  );
  assert.throws(
    () => resolveWorkItem({ workItemId: first.id, title: plan.title }, items),
    /conflict/,
  );
});

test("genuine v7 migration preserves existing goals' inputs and CLI identities; v8 goals reopen durably", () => {
  const root = mkdtempSync(join(tmpdir(), "doggie-goal-v8-"));
  const path = join(root, "test.db");
  let db = new DatabaseSync(path);
  try {
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    db.prepare(
      "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','7')",
    ).run(SCHEMA_KIND);
    const memory = new Store(db);
    const message = memory.appendChatMessage({
      role: "user",
      content: "原始记录",
    });
    const old = new AgentStore(db).propose({
      backend: "codex",
      workspaceId: null,
      instruction: "旧任务",
    });
    db.close();
    db = openDatabase(path);
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get()?.["value"],
      String(SCHEMA_VERSION),
    );
    assert.equal(new AgentStore(db).task(old.id).instruction, "旧任务");
    const request = {
      ...goal(),
      sources: [{ kind: "message", id: message.id }],
    };
    const item = new WorkItemStore(db).create(request, describeCreatedGoal);
    db.close();
    db = openDatabase(path);
    const store = new WorkItemStore(db);
    assert.equal(store.create(request, describeCreatedGoal).id, item.id);
    assert.equal(store.detail(item.id).sources[0]?.available, true);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("goal creation is atomic, idempotent and never archives instructions or adds them to model history", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new WorkItemStore(db);
    const request = goal();
    db.exec(
      "CREATE TRIGGER fail_goal_event BEFORE INSERT ON work_item_events BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(() => store.create(request, describeCreatedGoal), /injected/);
    assert.equal(store.list().length, 0);
    assert.equal(new Store(db).listChatMessages(20).length, 0);
    db.exec("DROP TRIGGER fail_goal_event");
    const created = store.create(request, describeCreatedGoal);
    assert.equal(store.create(request, describeCreatedGoal).id, created.id);
    assert.throws(
      () =>
        store.create({ ...request, title: "不同内容" }, describeCreatedGoal),
      /conflict/,
    );
    assert.throws(() =>
      store.create({ ...goal(), extra: true }, describeCreatedGoal),
    );
    assert.equal(new Store(db).listChatMessages(20).length, 1);
    assert.equal(new Store(db).listModelChatMessages(20).length, 0);
    for (const table of ["entries", "memory_items", "archive_attempts"])
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.["n"],
        0,
      );
  } finally {
    db.close();
  }
});

test("goal source references reflect revocation and deletion without copying stale facts", () => {
  const db = openDatabase(":memory:");
  try {
    const memory = new Store(db);
    const result = memory.archive(
      "压测结果为 12ms",
      createNew(BucketType.Task, "性能", 0.99, "fixture"),
      minimalExtraction("12ms"),
      { candidateBucketIds: [], promptVersion: "fake", modelName: "fake" },
    );
    assert.ok(result.entryId && result.bucketId);
    const store = new WorkItemStore(db);
    const item = store.create(
      {
        ...goal(),
        sources: [
          { kind: "entry", id: result.entryId },
          { kind: "bucket", id: result.bucketId },
        ],
      },
      describeCreatedGoal,
    );
    memory.deleteEntry(result.entryId, "撤销测试");
    assert.equal(
      store.detail(item.id).sources.find((source) => source.kind === "entry")
        ?.available,
      false,
    );
    assert.throws(
      () =>
        store.create(
          {
            ...goal(),
            sources: [{ kind: "entry", id: result.entryId }],
          },
          describeCreatedGoal,
        ),
      /invalid_reference/,
    );
    memory.deleteBucket(result.bucketId, "删除主题");
    assert.equal(
      store.detail(item.id).sources.find((source) => source.kind === "bucket")
        ?.available,
      false,
    );
    const assistant = memory.appendChatMessage({
      role: "assistant",
      content: "未采纳建议",
    });
    assert.throws(
      () =>
        store.create(
          {
            ...goal(),
            sources: [{ kind: "message", id: assistant.id }],
          },
          describeCreatedGoal,
        ),
      /invalid_reference/,
    );
  } finally {
    db.close();
  }
});

test("goal proposal has exact compiled instructions, atomic deduplication and exclusive session ownership", () => {
  const db = openDatabase(":memory:");
  try {
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const one = goals.create(goal(), describeCreatedGoal);
    const two = goals.create(goal(), describeCreatedGoal);
    const request = attempt(one.revision);
    const task = agents.proposeForWorkItem(one.id, request);
    assert.match(task.instruction, /检查撤销机制/);
    assert.match(task.instruction, /给出有来源的问题清单/);
    assert.equal(agents.proposeForWorkItem(one.id, request).id, task.id);
    assert.throws(
      () =>
        agents.proposeForWorkItem(one.id, { ...request, instruction: "伪造" }),
      /conflict/,
    );
    assert.throws(
      () =>
        agents.propose({
          backend: "codex",
          workspaceId: null,
          instruction: "偷用",
          sessionId: task.sessionId,
        }),
      /binding_mismatch/,
    );
    assert.throws(
      () =>
        agents.proposeForWorkItem(two.id, {
          ...attempt(two.revision),
          sessionId: task.sessionId,
        }),
      /binding_mismatch/,
    );
    const standalone = agents.propose({
      backend: "codex",
      workspaceId: null,
      instruction: "独立任务",
    });
    assert.throws(
      () =>
        agents.proposeForWorkItem(two.id, {
          ...attempt(two.revision),
          sessionId: standalone.sessionId,
        }),
      /binding_mismatch/,
    );
    const pending = new Store(db).getPendingAction(task.pendingActionId);
    assert.equal(pending?.status, "pending");
    assert.equal(new TaskStore(db).list().length, 0);
  } finally {
    db.close();
  }
});

test("editing goal invalidates pending approval and session scope; status transitions have optimistic revisions", () => {
  const db = openDatabase(":memory:");
  try {
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const old = agents.proposeForWorkItem(item.id, attempt(item.revision));
    const current = goals.get(item.id);
    assert.throws(() =>
      goals.update(
        item.id,
        { ...goal(), expectedRevision: item.revision },
        describeUpdatedGoal,
      ),
    );
    const edited = goals.update(
      item.id,
      {
        title: item.title,
        goal: "新的范围",
        acceptance: item.acceptance,
        expectedRevision: current.revision,
      },
      describeUpdatedGoal,
    );
    assert.equal(agents.task(old.id).status, "rejected");
    assert.throws(() => agents.approve(old.id, old.instruction));
    assert.throws(
      () =>
        agents.proposeForWorkItem(item.id, {
          ...attempt(edited.revision),
          sessionId: old.sessionId,
        }),
      /binding_mismatch/,
    );
    const done = goals.transition(item.id, {
      expectedRevision: edited.revision,
      action: "complete",
    });
    assert.equal(done.status, "done");
    assert.throws(
      () =>
        goals.transition(item.id, {
          expectedRevision: edited.revision,
          action: "reopen",
        }),
      /stale/,
    );
    const reopened = goals.transition(item.id, {
      expectedRevision: done.revision,
      action: "reopen",
    });
    assert.equal(reopened.status, "open");
    assert.ok(reopened.scopeRevision > edited.scopeRevision);
  } finally {
    db.close();
  }
});

test("approved work uses one in-flight attempt, success awaits user completion and valid continuation can resume", () => {
  const db = openDatabase(":memory:");
  try {
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const queue = new TaskStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
    const queued = agents.approve(task.id, task.instruction);
    assert.equal(goals.get(item.id).status, "in_progress");
    assert.throws(
      () =>
        agents.proposeForWorkItem(
          item.id,
          attempt(goals.get(item.id).revision),
        ),
      /conflict/,
    );
    assert.throws(
      () =>
        goals.transition(item.id, {
          expectedRevision: goals.get(item.id).revision,
          action: "complete",
        }),
      /conflict/,
    );
    queue.claim();
    agents.start(task.id);
    agents.complete(task.id, {
      status: "succeeded",
      output: "审查完成",
      failureCode: null,
      remoteId: randomUUID(),
    });
    queue.finish(queued.id, "succeeded");
    assert.equal(goals.get(item.id).status, "in_progress");
    const next = agents.proposeForWorkItem(item.id, {
      ...attempt(goals.get(item.id).revision),
      sessionId: task.sessionId,
    });
    assert.equal(next.sessionId, task.sessionId);
    agents.reject(next.id, next.instruction);
    const done = goals.transition(item.id, {
      expectedRevision: goals.get(item.id).revision,
      action: "complete",
    });
    assert.equal(done.status, "done");
  } finally {
    db.close();
  }
});

test("goal cancellation intent blocks old approvals until execution actually stops", () => {
  const db = openDatabase(":memory:");
  try {
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const queue = new TaskStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
    const queued = agents.approve(task.id, task.instruction);
    const cancelling = goals.transition(item.id, {
      expectedRevision: goals.get(item.id).revision,
      action: "cancel",
    });
    assert.equal(cancelling.cancelRequested, true);
    assert.notEqual(cancelling.status, "cancelled");
    assert.throws(
      () => agents.proposeForWorkItem(item.id, attempt(cancelling.revision)),
      /conflict/,
    );
    db.exec(
      "CREATE TRIGGER reject_goal_projection BEFORE UPDATE OF last_attempt_status ON work_items BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => queue.cancelQueued(queued.id), /injected/);
    assert.equal(queue.get(queued.id).status, "queued");
    assert.equal(agents.task(task.id).status, "queued");
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "approved",
    );
    assert.deepEqual(goals.get(item.id), cancelling);
    db.exec("DROP TRIGGER reject_goal_projection");
    queue.cancelQueued(queued.id);
    const terminal = goals.detail(item.id);
    assert.equal(terminal.workItem.status, "cancelled");
    assert.equal(terminal.workItem.cancelRequested, false);
    assert.equal(terminal.workItem.lastAttemptStatus, "cancelled");
    assert.equal(agents.task(task.id).status, "cancelled");
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "failed",
    );
    queue.cancelQueued(queued.id);
    agents.reconcile();
    assert.deepEqual(goals.detail(item.id), terminal);
  } finally {
    db.close();
  }
});

test("interrupted execution reconciles goal to blocked and cannot restore failed sessions", () => {
  const db = openDatabase(":memory:");
  try {
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const queue = new TaskStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
    agents.approve(task.id, task.instruction);
    queue.claim();
    agents.start(task.id);
    const owner = randomUUID();
    queue.acquireExecutor(owner);
    assert.equal(goals.get(item.id).status, "blocked");
    assert.equal(goals.get(item.id).lastAttemptStatus, "failed");
    const terminal = goals.detail(item.id);
    agents.reconcile();
    assert.deepEqual(goals.detail(item.id), terminal);
    assert.throws(
      () =>
        agents.proposeForWorkItem(item.id, {
          ...attempt(goals.get(item.id).revision),
          sessionId: task.sessionId,
        }),
      /conflict/,
    );
    const fresh = agents.proposeForWorkItem(
      item.id,
      attempt(goals.get(item.id).revision),
    );
    assert.notEqual(fresh.sessionId, task.sessionId);
    queue.releaseExecutor(owner);
  } finally {
    db.close();
  }
});

test("startup keeps a committed Agent success when queue finish was interrupted", () => {
  using db = openDatabase(":memory:");
  const goals = new WorkItemStore(db);
  const agents = new AgentStore(db);
  const queue = new TaskStore(db);
  const item = goals.create(goal(), describeCreatedGoal);
  const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
  const queued = agents.approve(task.id, task.instruction);
  queue.claim();
  agents.start(task.id);
  agents.complete(task.id, {
    status: "succeeded",
    output: "Committed evidence",
    failureCode: null,
  });
  // Simulate an older version with a lagging WorkItem projection as well.
  db.prepare(
    "UPDATE work_items SET last_attempt_status='running' WHERE id=?",
  ).run(item.id);
  const owner = randomUUID();
  queue.acquireExecutor(owner);
  assert.equal(queue.get(queued.id).errorCode, "interrupted");
  assert.equal(agents.task(task.id).status, "succeeded");
  assert.equal(agents.task(task.id).output, "Committed evidence");
  assert.equal(
    new Store(db).getPendingAction(task.pendingActionId)?.status,
    "executed",
  );
  assert.equal(goals.get(item.id).status, "in_progress");
  assert.equal(goals.get(item.id).lastAttemptStatus, "succeeded");
  assert.equal(queue.claim(), undefined);
  queue.releaseExecutor(owner);
});

for (const outcome of ["failed", "cancelled"] as const) {
  test(`queue ${outcome} commits Agent, approval and WorkItem together without a read repair`, () => {
    using db = openDatabase(":memory:");
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const queue = new TaskStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
    const queued = agents.approve(task.id, task.instruction);
    queue.claim();
    agents.start(task.id);
    const before = goals.detail(item.id);
    db.exec(
      "CREATE TRIGGER reject_goal_terminal BEFORE UPDATE OF last_attempt_status ON work_items BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => queue.finish(queued.id, outcome), /injected/);
    assert.equal(queue.get(queued.id).status, "running");
    assert.equal(agents.task(task.id).status, "running");
    assert.deepEqual(goals.detail(item.id), before);
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "approved",
    );
    db.exec("DROP TRIGGER reject_goal_terminal");
    queue.finish(queued.id, outcome);
    assert.equal(agents.task(task.id).status, outcome);
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "failed",
    );
    assert.equal(goals.get(item.id).lastAttemptStatus, outcome);
    assert.equal(goals.get(item.id).status, "blocked");
    const terminal = goals.detail(item.id);
    const eventCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM work_item_events WHERE work_item_id=?",
      )
      .get(item.id)?.["n"];
    for (let i = 0; i < 201; i++) {
      const temporary = queue.enqueue({ message: "synthetic queue retention" });
      queue.cancelQueued(temporary.id);
    }
    assert.equal(agents.task(task.id).queueId, null);
    assert.deepEqual(goals.get(item.id), terminal.workItem);
    agents.reconcile();
    assert.deepEqual(goals.get(item.id), terminal.workItem);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM work_item_events WHERE work_item_id=?",
        )
        .get(item.id)?.["n"],
      eventCount,
    );
  });
}

for (const change of ["edit", "complete", "cancel"] as const) {
  test(`pending attempt summary follows rejection during goal ${change}`, () => {
    using db = openDatabase(":memory:");
    const goals = new WorkItemStore(db);
    const agents = new AgentStore(db);
    const item = goals.create(goal(), describeCreatedGoal);
    const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
    const before = goals.get(item.id);
    const changed =
      change === "edit"
        ? goals.update(
            item.id,
            {
              title: item.title,
              goal: "Changed scope",
              acceptance: item.acceptance,
              expectedRevision: before.revision,
            },
            describeUpdatedGoal,
          )
        : goals.transition(item.id, {
            action: change,
            expectedRevision: before.revision,
          });
    assert.equal(agents.task(task.id).status, "rejected");
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "rejected",
    );
    assert.equal(changed.lastAttemptId, task.id);
    assert.equal(changed.lastAttemptStatus, "rejected");
    assert.equal(changed.revision, before.revision + 1);
    assert.equal(changed.scopeRevision, before.scopeRevision + 1);
    const events = db
      .prepare(
        "SELECT * FROM work_item_events WHERE work_item_id=? ORDER BY revision",
      )
      .all(item.id);
    assert.equal(events.length, changed.revision);
    agents.reconcile();
    agents.reconcile();
    assert.deepEqual(goals.get(item.id), changed);
    assert.deepEqual(
      db
        .prepare(
          "SELECT * FROM work_item_events WHERE work_item_id=? ORDER BY revision",
        )
        .all(item.id),
      events,
    );
    assert.throws(() => agents.approve(task.id, task.instruction));
    if (change !== "edit") {
      const reopened = goals.transition(item.id, {
        action: "reopen",
        expectedRevision: changed.revision,
      });
      assert.equal(reopened.lastAttemptStatus, "rejected");
      assert.equal(reopened.status, "open");
      assert.throws(
        () =>
          agents.proposeForWorkItem(item.id, {
            ...attempt(reopened.revision),
            sessionId: task.sessionId,
          }),
        /binding_mismatch/,
      );
    }
  });
}

function goalAudit(db: DatabaseSync, goals: WorkItemStore, id: string) {
  return {
    goal: goals.get(id),
    events: db
      .prepare(
        "SELECT * FROM work_item_events WHERE work_item_id=? ORDER BY revision",
      )
      .all(id),
    tasks: db.prepare("SELECT * FROM agent_tasks ORDER BY id").all(),
    actions: db.prepare("SELECT * FROM pending_actions ORDER BY id").all(),
    messages: db
      .prepare("SELECT * FROM conversation_messages ORDER BY sequence")
      .all(),
  };
}

for (const action of ["edit", "complete", "cancel"] as const) {
  for (const fault of ["summary", "event"] as const) {
    test(`goal ${action} rolls back rejection, summary and audit on ${fault} write failure`, () => {
      using db = openDatabase(":memory:");
      const goals = new WorkItemStore(db);
      const agents = new AgentStore(db);
      const item = goals.create(goal(), describeCreatedGoal);
      agents.proposeForWorkItem(item.id, attempt(item.revision));
      const before = goalAudit(db, goals, item.id);
      db.exec(
        fault === "summary"
          ? "CREATE TRIGGER reject_summary BEFORE UPDATE OF last_attempt_status ON work_items BEGIN SELECT RAISE(ABORT,'injected'); END;"
          : "CREATE TRIGGER reject_event BEFORE INSERT ON work_item_events BEGIN SELECT RAISE(ABORT,'injected'); END;",
      );
      assert.throws(
        () =>
          action === "edit"
            ? goals.update(
                item.id,
                {
                  title: item.title,
                  goal: "Changed goal",
                  acceptance: item.acceptance,
                  expectedRevision: before.goal.revision,
                },
                describeUpdatedGoal,
              )
            : goals.transition(item.id, {
                action,
                expectedRevision: before.goal.revision,
              }),
        /injected/,
      );
      assert.deepEqual(goalAudit(db, goals, item.id), before);
    });
  }
}

for (const lifecycle of ["done", "cancelled", "open"] as const) {
  test(`reopened database repairs legacy old-scope summary on ${lifecycle} without changing lifecycle`, () => {
    const root = mkdtempSync(join(tmpdir(), "doggie-summary-recovery-"));
    const path = join(root, "test.db");
    let db = openDatabase(path);
    try {
      let goals = new WorkItemStore(db);
      let agents = new AgentStore(db);
      const item = goals.create(goal(), describeCreatedGoal);
      const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
      const terminal = goals.transition(item.id, {
        action: lifecycle === "cancelled" ? "cancel" : "complete",
        expectedRevision: goals.get(item.id).revision,
      });
      if (lifecycle === "open")
        goals.transition(item.id, {
          action: "reopen",
          expectedRevision: terminal.revision,
        });
      db.prepare(
        "UPDATE work_items SET last_attempt_status='pending' WHERE id=?",
      ).run(item.id);
      const before = goalAudit(db, goals, item.id);
      db.close();
      db = openDatabase(path);
      goals = new WorkItemStore(db);
      agents = new AgentStore(db);
      // GET remains pure even for legacy drift. Explicit startup is the repair.
      assert.deepEqual(goalAudit(db, goals, item.id), before);
      const queues = new TaskStore(db);
      const owner = randomUUID();
      queues.acquireExecutor(owner);
      const repaired = goalAudit(db, goals, item.id);
      assert.equal(repaired.goal.status, lifecycle);
      assert.equal(repaired.goal.lastAttemptId, task.id);
      assert.equal(repaired.goal.lastAttemptStatus, "rejected");
      assert.equal(repaired.goal.scopeRevision, before.goal.scopeRevision);
      assert.equal(repaired.goal.cancelRequested, before.goal.cancelRequested);
      assert.equal(repaired.goal.revision, before.goal.revision + 1);
      assert.equal(
        repaired.events.at(-1)?.["kind"],
        "attempt_summary_reconciled",
      );
      assert.deepEqual(repaired.tasks, before.tasks);
      assert.deepEqual(repaired.actions, before.actions);
      assert.deepEqual(repaired.messages, before.messages);
      agents.reconcile();
      agents.reconcile();
      assert.deepEqual(goalAudit(db, goals, item.id), repaired);
      queues.releaseExecutor(owner);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("late projection of a non-latest attempt cannot replace summary or lifecycle, recovery uses sequence", () => {
  using db = openDatabase(":memory:");
  const goals = new WorkItemStore(db);
  const agents = new AgentStore(db);
  const item = goals.create(goal(), describeCreatedGoal);
  const first = agents.proposeForWorkItem(item.id, attempt(item.revision));
  agents.reject(first.id, first.instruction);
  const second = agents.proposeForWorkItem(
    item.id,
    attempt(goals.get(item.id).revision),
  );
  const before = goalAudit(db, goals, item.id);
  withTransaction(db, () => goals.projectAttempt(first.id));
  withTransaction(db, () => goals.projectAttempt(second.id));
  assert.deepEqual(goalAudit(db, goals, item.id), before);
  // Legacy reference can point at an older attempt whose status is accurate.
  // Recovery must detect the wrong identity, not just compare status values.
  db.prepare(
    "UPDATE work_items SET last_attempt_id=?,last_attempt_status='rejected' WHERE id=?",
  ).run(first.id, item.id);
  agents.reconcile();
  assert.equal(goals.get(item.id).lastAttemptId, second.id);
  assert.equal(goals.get(item.id).lastAttemptStatus, "pending");
  assert.equal(goals.get(item.id).status, before.goal.status);
  const recovered = goalAudit(db, goals, item.id);
  agents.reconcile();
  assert.deepEqual(goalAudit(db, goals, item.id), recovered);
});

test("a reopened successful goal retains historical success but cannot reuse the old session", () => {
  using db = openDatabase(":memory:");
  const goals = new WorkItemStore(db);
  const agents = new AgentStore(db);
  const queues = new TaskStore(db);
  const item = goals.create(goal(), describeCreatedGoal);
  const task = agents.proposeForWorkItem(item.id, attempt(item.revision));
  const queued = agents.approve(task.id, task.instruction);
  queues.claim();
  agents.start(task.id);
  agents.complete(task.id, {
    status: "succeeded",
    output: "Evidence",
    failureCode: null,
  });
  queues.finish(queued.id, "succeeded");
  const done = goals.transition(item.id, {
    action: "complete",
    expectedRevision: goals.get(item.id).revision,
  });
  const reopened = goals.transition(item.id, {
    action: "reopen",
    expectedRevision: done.revision,
  });
  assert.equal(reopened.lastAttemptStatus, "succeeded");
  assert.throws(
    () =>
      agents.proposeForWorkItem(item.id, {
        ...attempt(reopened.revision),
        sessionId: task.sessionId,
      }),
    /binding_mismatch/,
  );
  withTransaction(db, () => goals.projectAttempt(task.id));
  assert.deepEqual(goals.get(item.id), reopened);
});
