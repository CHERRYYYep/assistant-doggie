import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentError } from "../domain/agent.ts";
import { openDatabase } from "../storage/database.ts";
import { AgentStore } from "../storage/agents.ts";
import { TaskStore } from "../storage/tasks.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import { WorkItemService } from "../application/work-items.ts";
import { TaskQueue } from "../application/task-queue.ts";
import { taskEventStream } from "../http/task-events.ts";
import { WorkspacePolicy, assertWorkspaceUnchanged } from "./workspace.ts";
import { AgentService } from "./service.ts";
import type { AgentProcessRequest, AgentProcessRunner } from "./process.ts";
import { createDoggieApp } from "../http/app.ts";
import { ConcreteDoggieHttpApi } from "../http/api.ts";
import { Store } from "../storage/store.ts";
import { ArchiveRuntime } from "../application/archive-runtime.ts";
import { createNew } from "../domain/classification.ts";
import { BucketType } from "../domain/types.ts";
import { minimalExtraction } from "../domain/memory.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doggie-agent-test-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        PATH: process.env["PATH"],
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Fixture");
  await writeFile(join(repo, "file.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const db = openDatabase(join(root, "test.db"));
  const store = new AgentStore(db);
  const policy = new WorkspacePolicy([repo]);
  return {
    root,
    repo,
    db,
    store,
    policy,
    git,
    cleanup: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function setupService(
  f: Awaited<ReturnType<typeof fixture>>,
  runner: AgentProcessRunner,
) {
  const service = new AgentService({
    store: f.store,
    policy: f.policy,
    runner,
    databasePath: join(f.root, "test.db"),
    enabled: ["codex", "claude"],
  });
  const queue = new TaskQueue(new TaskStore(f.db), async (payload, signal) => {
    if (!("agent_task_id" in payload)) throw new Error("not an agent task");
    await service.execute(payload.agent_task_id, signal);
  });
  service.attachQueue(queue);
  return { service, queue };
}
const proposal = {
  backend: "codex",
  workspaceId: null,
  instruction: "读取记忆并总结",
} as const;

function revocableMemory(store: Store) {
  const archived = store.archive(
    "temporary source has 12 records",
    createNew(BucketType.Task, "revocation fixture", 0.99, "fixture"),
    minimalExtraction("temporary evidence"),
    { candidateBucketIds: [], promptVersion: "fixture", modelName: "fake" },
  );
  assert.ok(archived.entryId);
  assert.ok(archived.bucketId);
  return { entryId: archived.entryId, bucketId: archived.bucketId };
}

async function waitForTask(queue: TaskQueue, id: string): Promise<void> {
  await new Response(
    taskEventStream(queue, id, new AbortController().signal),
  ).text();
}

test("T13 six workspace checks: canonical roots, symlink escape, repo root, content and HEAD baseline", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.repo, "subdir"));
    await mkdir(join(f.root, "repo-extra"));
    await symlink(f.root, join(f.repo, "escape"));
    for (const path of [
      "relative",
      join(f.repo, "missing"),
      join(f.repo, "subdir"),
      join(f.root, "repo-extra"),
      join(f.repo, "escape"),
    ])
      await assert.rejects(
        f.policy.inspect(path),
        (e: unknown) =>
          e instanceof AgentError && e.code === "invalid_workspace",
      );
    await rm(join(f.repo, "escape"));
    await assert.rejects(new WorkspacePolicy([]).inspect(f.repo), /disabled/);
    await symlink(f.repo, join(f.root, "alias"));
    const initial = await f.policy.inspect(f.repo);
    assert.equal(
      (await f.policy.inspect(join(f.root, "alias"))).path,
      initial.path,
    );
    await writeFile(join(f.repo, "file.txt"), "dirty one\n");
    const dirty = await f.policy.inspect(f.repo);
    await writeFile(join(f.repo, "file.txt"), "dirty two\n");
    assert.throws(
      () =>
        assertWorkspaceUnchanged(dirty, {
          ...dirty,
          gitStatus: initial.gitStatus,
        }),
      /workspace_changed/,
    );
    assert.notEqual(
      dirty.gitStatus,
      (await f.policy.inspect(f.repo)).gitStatus,
    );
    await writeFile(join(f.repo, "untracked"), "one");
    const untracked = await f.policy.inspect(f.repo);
    await writeFile(join(f.repo, "untracked"), "two");
    assert.notEqual(
      untracked.gitStatus,
      (await f.policy.inspect(f.repo)).gitStatus,
    );
    f.git("commit", "--allow-empty", "-qm", "new baseline");
    assert.notEqual(
      initial.baseCommit,
      (await f.policy.inspect(f.repo)).baseCommit,
    );
  } finally {
    await f.cleanup();
  }
});

test("T13 escaped symlink introduced after approval is rejected before the runner starts", async () => {
  const f = await fixture();
  let runs = 0;
  try {
    const ws = f.store.registerWorkspace(await f.policy.inspect(f.repo));
    const task = f.store.propose({ ...proposal, workspaceId: ws.id });
    const queued = f.store.approve(task.id, task.instruction);
    const queue = new TaskStore(f.db);
    queue.claim();
    const outside = join(f.root, "outside.txt");
    await writeFile(outside, "temporary test content");
    await symlink(outside, join(f.repo, "new-link"));
    const service = new AgentService({
      store: f.store,
      policy: f.policy,
      runner: {
        async run() {
          runs++;
          return { output: "never", remoteId: randomUUID() };
        },
      },
      databasePath: join(f.root, "test.db"),
      enabled: ["codex"],
    });
    await assert.rejects(
      service.execute(task.id, new AbortController().signal),
      /invalid_workspace/,
    );
    assert.equal(runs, 0);
    assert.equal(f.store.task(task.id).status, "failed");
    assert.equal(f.store.task(task.id).failureCode, "invalid_workspace");
    queue.finish(queued.id, "failed", "execution_failed");
  } finally {
    await f.cleanup();
  }
});

test("T13 storage approval binding, immutable identities, busy canonical directory and atomic admission", async () => {
  const f = await fixture();
  try {
    const ws = f.store.registerWorkspace(await f.policy.inspect(f.repo));
    assert.equal(
      f.store.registerWorkspace(await f.policy.inspect(f.repo)).id,
      ws.id,
    );
    const first = f.store.propose({ ...proposal, workspaceId: ws.id });
    assert.throws(() => f.store.propose({ ...proposal, extra: true }));
    assert.throws(() => f.store.approve(first.id, "forged"));
    assert.equal(f.store.task(first.id).status, "pending");
    assert.throws(() =>
      f.db
        .prepare("UPDATE agent_sessions SET workspace_id=NULL WHERE id=?")
        .run(first.sessionId),
    );
    assert.throws(() =>
      f.db
        .prepare("UPDATE agent_tasks SET instruction='changed' WHERE id=?")
        .run(first.id),
    );
    assert.throws(() =>
      f.store.propose({ ...proposal, sessionId: first.sessionId }),
    );
    const second = f.store.propose({ ...proposal, workspaceId: ws.id });
    f.db.exec(
      "CREATE TRIGGER reject_enqueue BEFORE INSERT ON background_tasks BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => f.store.approve(first.id, first.instruction));
    assert.equal(f.store.task(first.id).status, "pending");
    f.db.exec("DROP TRIGGER reject_enqueue");
    const queueTask = f.store.approve(first.id, first.instruction);
    assert.equal(f.store.task(first.id).queueId, queueTask.id);
    assert.throws(() => f.store.approve(first.id, first.instruction));
    assert.throws(
      () => f.store.approve(second.id, second.instruction),
      /conflict/,
    );
    new TaskStore(f.db).cancelQueued(queueTask.id);
    f.store.reconcile();
    assert.equal(f.store.task(first.id).status, "cancelled");
    assert.throws(
      () =>
        f.store.propose({
          ...proposal,
          workspaceId: ws.id,
          sessionId: first.sessionId,
        }),
      /conflict/,
    );
    assert.equal(
      f.store.reject(second.id, second.instruction).status,
      "rejected",
    );
  } finally {
    await f.cleanup();
  }
});

test("Agent completion rejects a failed result without a failure code through the approved execution path", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new AgentStore(db);
    const queue = new TaskStore(db);
    const task = store.propose(proposal);
    const admitted = store.approve(task.id, task.instruction);
    queue.claim();
    store.start(task.id);

    assert.throws(
      () =>
        Reflect.apply(store.complete, store, [
          task.id,
          {
            status: "failed",
            output: "",
            failureCode: null,
          },
        ]),
      (error: unknown) =>
        error instanceof AgentError && error.code === "invalid_event",
    );
    assert.equal(store.task(task.id).status, "running");
    assert.equal(store.task(task.id).failureCode, null);
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.status,
      "approved",
    );
    assert.equal(
      new Store(db).getPendingAction(task.pendingActionId)?.failureCode,
      null,
    );
    queue.finish(admitted.id, "failed", "execution_failed");
  } finally {
    db.close();
  }
});

for (const outcome of ["failed", "cancelled"] as const) {
  test(`T13 a pending continuation cannot approve after its session becomes ${outcome}`, () => {
    const db = openDatabase(":memory:");
    try {
      const store = new AgentStore(db);
      const queue = new TaskStore(db);
      const first = store.propose(proposal);
      const continuation = store.propose({
        ...proposal,
        sessionId: first.sessionId,
      });
      const admitted = store.approve(first.id, first.instruction);
      queue.claim();
      store.start(first.id);
      store.complete(
        first.id,
        outcome === "failed"
          ? { status: "failed", output: "", failureCode: "process_failed" }
          : { status: "cancelled", output: "", failureCode: "cancelled" },
      );
      queue.finish(admitted.id, outcome);

      assert.throws(
        () => store.approve(continuation.id, continuation.instruction),
        /conflict/,
      );
      assert.equal(store.task(continuation.id).status, "pending");
      assert.equal(store.task(continuation.id).queueId, null);
      assert.equal(queue.list().length, 1);
      assert.equal(
        db
          .prepare("SELECT status FROM pending_actions WHERE id=?")
          .get(continuation.pendingActionId)?.["status"],
        "pending",
      );
      assert.equal(
        store.reject(continuation.id, continuation.instruction).status,
        "rejected",
      );
    } finally {
      db.close();
    }
  });
}

for (const interruption of [
  "queued_cancelled",
  "running_interrupted",
] as const) {
  test(`T13 session reuse rejects ${interruption} before and after agent reconciliation`, () => {
    const db = openDatabase(":memory:");
    try {
      const store = new AgentStore(db);
      const queue = new TaskStore(db);
      const first = store.propose(proposal);
      const continuation = store.propose({
        ...proposal,
        sessionId: first.sessionId,
      });
      const admitted = store.approve(first.id, first.instruction);
      if (interruption === "queued_cancelled") {
        db.prepare(
          "UPDATE background_tasks SET status='cancelled' WHERE id=?",
        ).run(admitted.id);
      } else {
        queue.claim();
        store.start(first.id);
        db.prepare(
          "UPDATE background_tasks SET status='failed',error_code='interrupted' WHERE id=?",
        ).run(admitted.id);
      }
      assert.throws(
        () => store.propose({ ...proposal, sessionId: first.sessionId }),
        /conflict/,
      );
      assert.throws(
        () => store.approve(continuation.id, continuation.instruction),
        /conflict/,
      );
      store.reconcile();
      assert.throws(
        () => store.approve(continuation.id, continuation.instruction),
        /conflict/,
      );
      assert.equal(store.task(continuation.id).status, "pending");
      assert.equal(queue.list().length, 1);
    } finally {
      db.close();
    }
  });
}

test("T13 generic queued cancellation survives queue retention and keeps its session revoked", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new AgentStore(db);
    const queue = new TaskStore(db);
    const first = store.propose(proposal);
    const continuation = store.propose({
      ...proposal,
      sessionId: first.sessionId,
    });
    const admitted = store.approve(first.id, first.instruction);
    queue.cancelQueued(admitted.id);
    assert.equal(store.task(first.id).status, "cancelled");
    for (let i = 0; i < 200; i++) {
      const queued = queue.enqueue({ message: `temporary history ${i}` });
      queue.cancelQueued(queued.id);
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM background_tasks").get()?.["n"],
      200,
    );
    assert.throws(() => queue.get(admitted.id), /task not found/);
    const service = new AgentService({
      store,
      policy: new WorkspacePolicy([]),
      runner: {
        async run() {
          throw new Error("must not spawn");
        },
      },
      databasePath: "/unused-fixture.db",
      enabled: ["codex"],
    });
    assert.equal(service.get(first.id).status, "cancelled");
    assert.equal(service.get(first.id).queueId, null);
    assert.ok(service.list().some((task) => task.id === first.id));
    assert.equal(
      db
        .prepare("SELECT status FROM pending_actions WHERE id=?")
        .get(first.pendingActionId)?.["status"],
      "failed",
    );
    assert.throws(
      () => store.propose({ ...proposal, sessionId: first.sessionId }),
      /conflict/,
    );
    assert.throws(
      () => store.approve(continuation.id, continuation.instruction),
      /conflict/,
    );
  } finally {
    db.close();
  }
});

test("T13 enqueue reconciles interrupted agents atomically and rolls it back if admission fails", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new AgentStore(db);
    const queue = new TaskStore(db);
    const first = store.propose(proposal);
    const admitted = store.approve(first.id, first.instruction);
    queue.claim();
    store.start(first.id);
    // Simulate legacy drift before terminal projection shared the transaction.
    db.prepare(
      "UPDATE background_tasks SET status='failed',error_code='interrupted' WHERE id=?",
    ).run(admitted.id);
    db.exec(
      "CREATE TRIGGER reject_queue_insert BEFORE INSERT ON background_tasks BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(
      () => queue.enqueue({ message: "rollback fixture" }),
      /injected/,
    );
    assert.equal(store.task(first.id).status, "running");
    assert.equal(
      db
        .prepare("SELECT status FROM pending_actions WHERE id=?")
        .get(first.pendingActionId)?.["status"],
      "approved",
    );
    db.exec("DROP TRIGGER reject_queue_insert");
    queue.enqueue({ message: "successful admission fixture" });
    assert.equal(store.task(first.id).status, "failed");
    assert.equal(store.task(first.id).failureCode, "interrupted");
    assert.equal(
      db
        .prepare("SELECT status FROM pending_actions WHERE id=?")
        .get(first.pendingActionId)?.["status"],
      "failed",
    );
  } finally {
    db.close();
  }
});

test("T13 old missing queue history becomes a failed agent without inventing a successful result", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new AgentStore(db);
    const first = store.propose(proposal);
    const admitted = store.approve(first.id, first.instruction);
    db.prepare("DELETE FROM background_tasks WHERE id=?").run(admitted.id);
    store.reconcile();
    assert.equal(store.task(first.id).status, "failed");
    assert.equal(store.task(first.id).failureCode, "queue_history_missing");
    assert.equal(store.task(first.id).output, "");
    assert.throws(
      () => store.propose({ ...proposal, sessionId: first.sessionId }),
      /conflict/,
    );
    assert.equal(
      db
        .prepare("SELECT result_json FROM pending_actions WHERE id=?")
        .get(first.pendingActionId)?.["result_json"],
      null,
    );
  } finally {
    db.close();
  }
});

test("T13 queue success without an agent result faults reconciliation and admission", () => {
  const db = openDatabase(":memory:");
  try {
    const store = new AgentStore(db);
    const queue = new TaskStore(db);
    const first = store.propose(proposal);
    const admitted = store.approve(first.id, first.instruction);
    queue.claim();
    const before = queue.get(admitted.id);
    assert.throws(
      () => queue.finish(admitted.id, "succeeded"),
      /executor is unavailable/,
    );
    assert.deepEqual(queue.get(admitted.id), before);
    // Recovery must also reject an already persisted impossible legacy state.
    db.prepare("UPDATE background_tasks SET status='succeeded' WHERE id=?").run(
      admitted.id,
    );
    assert.throws(() => store.reconcile(), /executor is unavailable/);
    assert.throws(
      () => queue.acquireExecutor(randomUUID()),
      /executor is unavailable/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM background_task_executor").get()?.[
        "n"
      ],
      0,
    );
    assert.throws(
      () => queue.enqueue({ message: "must not admit" }),
      /executor is unavailable/,
    );
    assert.equal(queue.list().length, 1);
    assert.equal(store.task(first.id).status, "queued");
    assert.equal(store.task(first.id).output, "");
    assert.equal(
      db
        .prepare("SELECT status FROM pending_actions WHERE id=?")
        .get(first.pendingActionId)?.["status"],
      "approved",
    );
  } finally {
    db.close();
  }
});

test("T13 explicit approval invokes runner once, resumes same remote session/cwd and survives reopen", async () => {
  const f = await fixture();
  const calls: AgentProcessRequest[] = [];
  const remoteId = randomUUID();
  const { service, queue } = setupService(f, {
    async run(request) {
      calls.push(request);
      return { output: "<script>untrusted</script>", remoteId };
    },
  });
  try {
    const first = await service.propose(proposal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 0);
    const admitted = await service.approve(first.id, first.instruction);
    assert.match(
      await new Response(
        taskEventStream(
          queue,
          admitted.queueTask.id,
          new AbortController().signal,
        ),
      ).text(),
      /succeeded/,
    );
    assert.equal(service.get(first.id).status, "succeeded");
    assert.equal(calls[0]?.session.remoteId, null);
    const second = await service.propose({
      ...proposal,
      sessionId: first.sessionId,
    });
    const admitted2 = await service.approve(second.id, second.instruction);
    await new Response(
      taskEventStream(
        queue,
        admitted2.queueTask.id,
        new AbortController().signal,
      ),
    ).text();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.session.remoteId, remoteId);
    assert.equal(calls[1]?.cwd, calls[0]?.cwd);
    assert.notEqual(calls[0]?.cwd, process.cwd());
    await queue.close();
    const reopened = openDatabase(join(f.root, "test.db"));
    try {
      assert.equal(
        new AgentStore(reopened).task(first.id).output,
        "<script>untrusted</script>",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await queue.close();
    await f.cleanup();
  }
});

test("T13 changed workspace refuses admission; aborted approval leaves proposal pending", async () => {
  const f = await fixture();
  const { service, queue } = setupService(f, {
    async run() {
      throw new Error("must not spawn");
    },
  });
  try {
    const workspace = await service.register(f.repo);
    const task = await service.propose({
      ...proposal,
      workspaceId: workspace.id,
    });
    await writeFile(join(f.repo, "file.txt"), "external edit");
    await assert.rejects(
      service.approve(task.id, task.instruction),
      /workspace_changed/,
    );
    const noDir = await service.propose(proposal);
    await assert.rejects(
      service.approve(
        noDir.id,
        noDir.instruction,
        AbortSignal.abort("secret reason"),
      ),
    );
    assert.equal(service.get(task.id).status, "pending");
    assert.equal(service.get(noDir.id).status, "pending");
  } finally {
    await queue.close();
    await f.cleanup();
  }
});

test("T13 interrupted running work is failed without respawn, queued work remains approved", async () => {
  const f = await fixture();
  try {
    const task = f.store.propose(proposal);
    const task2 = f.store.propose(proposal);
    const q = f.store.approve(task.id, task.instruction);
    f.store.approve(task2.id, task2.instruction);
    const ts = new TaskStore(f.db);
    ts.claim();
    f.store.start(task.id);
    ts.acquireExecutor(randomUUID());
    f.store.reconcile();
    assert.equal(f.store.task(task.id).status, "failed");
    assert.equal(f.store.task(task.id).failureCode, "interrupted");
    assert.equal(ts.get(q.id).status, "failed");
    assert.equal(f.store.task(task2.id).status, "queued");
  } finally {
    await f.cleanup();
  }
});

test("T13 success persistence failure faults worker, prevents replay/admission and never reports cancelled", async () => {
  const f = await fixture();
  let executions = 0;
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const { service, queue } = setupService(f, {
    async run() {
      executions++;
      began();
      return { output: "done", remoteId: randomUUID() };
    },
  });
  try {
    f.db.exec(
      "CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON agent_tasks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'disk'); END;",
    );
    const task = await service.propose(proposal);
    const accepted = await service.approve(task.id, task.instruction);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // cwd setup uses filesystem promises; wait for close, which observes the fault.
    await assert.rejects(
      queue.close(),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "faulted",
    );
    assert.equal(executions, 1);
    assert.equal(queue.get(accepted.queueTask.id).status, "running");
    assert.equal(service.get(task.id).status, "running");
    await assert.rejects(service.approve(task.id, task.instruction));
  } finally {
    await queue.close().catch(() => {});
    await f.cleanup();
  }
});

test("Agent and WorkItem GETs use committed projections without starting write transactions", async (t) => {
  using db = openDatabase(":memory:");
  const store = new AgentStore(db);
  const service = new AgentService({
    store,
    policy: new WorkspacePolicy([]),
    runner: {
      async run() {
        throw new Error("GET must not execute");
      },
    },
    databasePath: "/unused-fixture.db",
    enabled: ["codex"],
  });
  const goals = new WorkItemStore(db);
  const workItems = new WorkItemService(goals, service);
  const item = workItems.create({
    requestId: randomUUID(),
    title: "Read projected status",
    goal: "Review the code",
    acceptance: "Report evidence",
  });
  const task = await workItems.propose(item.id, {
    requestId: randomUUID(),
    expectedRevision: item.revision,
    ...proposal,
  });
  store.approve(task.id, task.instruction);
  const memory = new Store(db);
  const api = new ConcreteDoggieHttpApi(
    memory,
    new ArchiveRuntime(memory, {
      modelName: "fixture",
      async classify() {
        throw new Error("GET must not classify");
      },
      async extract() {
        throw new Error("GET must not extract");
      },
    }),
  );
  const app = createDoggieApp(api, [], [], undefined, service, workItems);
  const before = goals.detail(item.id);
  const exec = t.mock.method(db, "exec");
  for (const path of [
    "/api/work-items",
    `/api/work-items/${item.id}`,
    "/api/agent/tasks",
    `/api/agent/tasks/${task.id}`,
  ]) {
    const response = await app.request(`http://127.0.0.1:8787${path}`, {
      headers: { host: "127.0.0.1:8787" },
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(goals.detail(item.id), before);
  assert.equal(
    exec.mock.calls.filter(({ arguments: [sql] }) => /^BEGIN/i.test(sql))
      .length,
    0,
  );
});

test("T13 HTTP strict proposal/approval, Origin defense, generic queue bypass rejection and SSE", async () => {
  const f = await fixture();
  let executions = 0;
  const { service, queue } = setupService(f, {
    async run() {
      executions++;
      return { output: "evidence", remoteId: randomUUID() };
    },
  });
  const memory = new Store(f.db);
  const api = new ConcreteDoggieHttpApi(
    memory,
    new ArchiveRuntime(memory, {
      modelName: "fixture",
      async classify() {
        return createNew(BucketType.Task, "fixture", 0.99, "fact");
      },
      async extract() {
        return minimalExtraction("fact");
      },
    }),
  );
  const app = createDoggieApp(api, [], [], queue, service);
  const request = async (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`http://127.0.0.1:8787${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        host: "127.0.0.1:8787",
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal(
      (await request("/api/agent/tasks", { ...proposal, execute: true }))
        .status,
      400,
    );
    assert.equal(
      (
        await request("/api/agent/tasks", proposal, {
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request("/api/tasks", { agent_task_id: randomUUID() })).status,
      400,
    );
    const response = await request("/api/agent/tasks", proposal);
    assert.equal(response.status, 201);
    const body = (await response.json()) as { task: { id: string } };
    const id = body.task.id;
    assert.equal(
      (
        await request(`/api/agent/tasks/${id}/approve`, {
          instruction: proposal.instruction,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`/api/agent/tasks/${id}/approve`, {
          instruction: "tampered",
          confirmation_granted: true,
        })
      ).status,
      409,
    );
    assert.equal(executions, 0);
    const approval = await request(`/api/agent/tasks/${id}/approve`, {
      instruction: proposal.instruction,
      confirmation_granted: true,
    });
    assert.equal(approval.status, 202);
    const approved = (await approval.json()) as { queueTask: { id: string } };
    assert.match(
      await (
        await request(`/api/tasks/${approved.queueTask.id}/events`)
      ).text(),
      /succeeded/,
    );
    assert.equal(executions, 1);
    assert.equal(service.get(id).output, "evidence");
    assert.equal(
      (
        await request(`/api/agent/tasks/${id}/approve`, {
          instruction: proposal.instruction,
          confirmation_granted: true,
        })
      ).status,
      400,
    );
  } finally {
    await queue.close();
    await f.cleanup();
  }
});

test("T13 cancelled runner cannot persist late output or remote identity; session needs replacement", async () => {
  const f = await fixture();
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const { service, queue } = setupService(f, {
    async run(req) {
      began();
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else
          req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { output: "late result", remoteId: randomUUID() };
    },
  });
  try {
    const task = await service.propose(proposal);
    await service.approve(task.id, task.instruction);
    await started;
    const cancelled = await service.cancel(task.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.output, "");
    assert.equal(f.store.session(task.sessionId).remoteId, null);
    await assert.rejects(
      service.propose({ ...proposal, sessionId: task.sessionId }),
      /conflict/,
    );
  } finally {
    await queue.close();
    await f.cleanup();
  }
});

test("T13 different workspace revisions of one canonical path still exclude concurrent work", async () => {
  const f = await fixture();
  try {
    const first = f.store.registerWorkspace(await f.policy.inspect(f.repo));
    await writeFile(join(f.repo, "file.txt"), "new dirty baseline");
    const second = f.store.registerWorkspace(await f.policy.inspect(f.repo));
    assert.notEqual(first.id, second.id);
    const one = f.store.propose({ ...proposal, workspaceId: first.id });
    const two = f.store.propose({ ...proposal, workspaceId: second.id });
    f.store.approve(one.id, one.instruction);
    assert.throws(() => f.store.approve(two.id, two.instruction), /conflict/);
    assert.equal(f.store.task(two.id).status, "pending");
  } finally {
    await f.cleanup();
  }
});

test("T13 queue capacity rejection rolls back approval; changed baseline between approval and execution never spawns", async () => {
  const f = await fixture();
  let runs = 0;
  try {
    const store = new TaskStore(f.db);
    const task = f.store.propose(proposal);
    for (let i = 0; i < 32; i++) store.enqueue({ message: `capacity ${i}` });
    assert.throws(() => f.store.approve(task.id, task.instruction), /capacity/);
    assert.equal(f.store.task(task.id).status, "pending");
    for (const queued of store.list()) store.cancelQueued(queued.id);
    const ws = f.store.registerWorkspace(await f.policy.inspect(f.repo));
    const scoped = f.store.propose({ ...proposal, workspaceId: ws.id });
    const queued = f.store.approve(scoped.id, scoped.instruction);
    store.claim();
    await writeFile(join(f.repo, "file.txt"), "external change after approval");
    const service = new AgentService({
      store: f.store,
      policy: f.policy,
      runner: {
        async run() {
          runs++;
          return { output: "never", remoteId: randomUUID() };
        },
      },
      databasePath: join(f.root, "test.db"),
      enabled: ["codex"],
    });
    await assert.rejects(
      service.execute(scoped.id, new AbortController().signal),
      /workspace_changed/,
    );
    assert.equal(runs, 0);
    assert.equal(f.store.task(scoped.id).status, "failed");
    assert.equal(f.store.task(scoped.id).failureCode, "workspace_changed");
    store.finish(queued.id, "failed", "execution_failed");
  } finally {
    await f.cleanup();
  }
});

for (const target of ["entry", "bucket"] as const) {
  test(`revoking a ${target} blocks successful CLI session recovery and earlier pending approval`, async () => {
    const f = await fixture();
    const memory = new Store(f.db);
    const source = revocableMemory(memory);
    let runs = 0;
    const { service, queue } = setupService(f, {
      async run(request) {
        runs++;
        return {
          output: "current context",
          remoteId: request.session.remoteId ?? randomUUID(),
        };
      },
    });
    try {
      const first = await service.propose(proposal);
      const admitted = await service.approve(first.id, first.instruction);
      await waitForTask(queue, admitted.queueTask.id);
      assert.equal(service.get(first.id).status, "succeeded");
      const pending = await service.propose({
        ...proposal,
        sessionId: first.sessionId,
      });
      const revision = f.store.session(first.sessionId).memoryRevision;
      if (target === "entry")
        memory.deleteEntry(source.entryId, "revoke fixture");
      else memory.deleteBucket(source.bucketId, "delete fixture bucket");
      assert.ok(memory.getMemoryContextRevision() > revision);
      await assert.rejects(
        service.propose({ ...proposal, sessionId: first.sessionId }),
        /memory_changed/,
      );
      await assert.rejects(
        service.approve(pending.id, pending.instruction),
        /memory_changed/,
      );
      assert.equal(service.get(pending.id).status, "pending");
      assert.equal(
        service.reject(pending.id, pending.instruction).status,
        "rejected",
      );
      const fresh = await service.propose(proposal);
      assert.equal(
        f.store.session(fresh.sessionId).memoryRevision,
        memory.getMemoryContextRevision(),
      );
      const next = await service.approve(fresh.id, fresh.instruction);
      await waitForTask(queue, next.queueTask.id);
      assert.equal(service.get(fresh.id).status, "succeeded");
      assert.equal(runs, 2);
    } finally {
      await queue.close();
      await f.cleanup();
    }
  });
}

test("queued CLI work revoked before start fails without spawning and leaves the worker healthy", async () => {
  const f = await fixture();
  const memory = new Store(f.db);
  const source = revocableMemory(memory);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const claimed = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let runs = 0;
  const service = new AgentService({
    store: f.store,
    policy: f.policy,
    runner: {
      async run() {
        runs++;
        return { output: "new context", remoteId: randomUUID() };
      },
    },
    databasePath: join(f.root, "test.db"),
    enabled: ["codex"],
  });
  const queue = new TaskQueue(new TaskStore(f.db), async (payload, signal) => {
    if (!("agent_task_id" in payload)) throw new Error("not an agent task");
    entered();
    await gate;
    await service.execute(payload.agent_task_id, signal);
  });
  service.attachQueue(queue);
  try {
    const task = await service.propose(proposal);
    const admitted = await service.approve(task.id, task.instruction);
    await claimed;
    assert.equal(f.store.task(task.id).status, "queued");
    memory.deleteEntry(source.entryId, "revoke before CLI starts");
    release();
    await waitForTask(queue, admitted.queueTask.id);
    assert.equal(queue.get(admitted.queueTask.id).status, "failed");
    assert.equal(service.get(task.id).status, "failed");
    assert.equal(service.get(task.id).failureCode, "memory_changed");
    assert.equal(runs, 0);
    assert.equal(
      memory.getPendingAction(task.pendingActionId)?.status,
      "failed",
    );
    const fresh = await service.propose(proposal);
    const next = await service.approve(fresh.id, fresh.instruction);
    await waitForTask(queue, next.queueTask.id);
    assert.equal(service.get(fresh.id).status, "succeeded");
    assert.equal(runs, 1);
  } finally {
    release();
    await queue.close();
    await f.cleanup();
  }
});

test("revocation during CLI execution discards late output and remote identity without faulting the worker", async () => {
  const f = await fixture();
  const memory = new Store(f.db);
  const source = revocableMemory(memory);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let runs = 0;
  const { service, queue } = setupService(f, {
    async run() {
      runs++;
      if (runs === 1) {
        began();
        await gate;
        return { output: "stale revoked evidence", remoteId: randomUUID() };
      }
      return { output: "current evidence", remoteId: randomUUID() };
    },
  });
  try {
    const task = await service.propose(proposal);
    const admitted = await service.approve(task.id, task.instruction);
    await started;
    memory.deleteEntry(source.entryId, "revoke while CLI awaits");
    release();
    await waitForTask(queue, admitted.queueTask.id);
    assert.equal(queue.get(admitted.queueTask.id).status, "failed");
    assert.equal(service.get(task.id).status, "failed");
    assert.equal(service.get(task.id).failureCode, "memory_changed");
    assert.equal(service.get(task.id).output, "");
    assert.equal(f.store.session(task.sessionId).remoteId, null);
    assert.equal(
      memory.getPendingAction(task.pendingActionId)?.status,
      "failed",
    );
    assert.equal(
      memory.getPendingAction(task.pendingActionId)?.failureCode,
      "memory_changed",
    );
    const fresh = await service.propose(proposal);
    const next = await service.approve(fresh.id, fresh.instruction);
    await waitForTask(queue, next.queueTask.id);
    assert.equal(service.get(fresh.id).status, "succeeded");
    assert.equal(service.get(fresh.id).output, "current evidence");
    assert.equal(runs, 2);
  } finally {
    release();
    await queue.close();
    await f.cleanup();
  }
});
