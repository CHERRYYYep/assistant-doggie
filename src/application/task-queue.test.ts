import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../storage/database.ts";
import { MIGRATIONS } from "../storage/schema.ts";
import {
  TaskStore,
  MAX_ACTIVE_TASKS,
  MAX_RETAINED_TASKS,
} from "../storage/tasks.ts";
import { TaskError, MAX_TASK_PAYLOAD_BYTES } from "../domain/task.ts";
import { TaskQueue, taskEventStream } from "./task-queue.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle(queue: TaskQueue, id: string) {
  for (let count = 0; count < 100; count++) {
    const task = queue.get(id);
    if (task.status !== "running" && task.status !== "queued") return task;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("task did not settle");
}

test("T12 queue is durable, strict, bounded, with one-shot atomic claims and completion", () => {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db);
  try {
    assert.throws(() => store.enqueue({ message: "fact", injected: true }));
    assert.throws(() =>
      store.enqueue({ message: "x".repeat(MAX_TASK_PAYLOAD_BYTES) }),
    );
    const first = store.enqueue({ message: "first" });
    for (let i = 1; i < MAX_ACTIVE_TASKS; i++)
      store.enqueue({ message: `job ${i}` });
    assert.throws(
      () => store.enqueue({ message: "overflow" }),
      (error) => error instanceof TaskError && error.kind === "capacity",
    );
    const work = store.claim();
    assert.ok(work);
    assert.equal(work.task.status, "running");
    assert.notEqual(store.claim()?.task.id, work.task.id);
    const completed = store.finish(work.task.id, "succeeded");
    assert.equal(completed.revision, 3);
    assert.deepEqual(
      store.finish(work.task.id, "failed", "execution_failed"),
      completed,
    );
    assert.throws(() =>
      db
        .prepare("UPDATE background_tasks SET payload_json='{}' WHERE id=?")
        .run(first.id),
    );
    assert.ok(store.list().length <= 40);
  } finally {
    db.close();
  }
});

test("T12 task history retention is capped without dropping active work", () => {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db);
  try {
    for (let i = 0; i < MAX_RETAINED_TASKS + 10; i++) {
      const task = store.enqueue({ message: `job ${i}` });
      store.cancelQueued(task.id);
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM background_tasks").get()?.["n"],
      MAX_RETAINED_TASKS,
    );
  } finally {
    db.close();
  }
});

test("T12 restart interrupts claimed jobs without replay; queued work survives and owner conflicts fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doggie-task-"));
  const path = join(dir, "test.db");
  let db = openDatabase(path);
  const store = new TaskStore(db);
  const a = store.enqueue({ message: "claimed" });
  const b = store.enqueue({ message: "queued" });
  store.claim(); // Simulate abrupt death before terminal status was recorded.
  db.close();
  db = openDatabase(path);
  const reopened = new TaskStore(db);
  let calls = 0;
  const queue = new TaskQueue(reopened, async () => {
    calls++;
  });
  try {
    assert.equal(queue.get(a.id).errorCode, "interrupted");
    assert.throws(
      () => new TaskQueue(new TaskStore(db), async () => {}),
      (error) => error instanceof TaskError && error.kind === "executor_busy",
    );
    assert.equal((await settle(queue, b.id)).status, "succeeded");
    assert.equal(calls, 1);
  } finally {
    await queue.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T12 cancellation aborts running work, never executes queued work, and close drains before release", async () => {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db);
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const queue = new TaskQueue(store, async (_payload, signal) => {
    calls++;
    started.resolve();
    await release.promise;
    signal.throwIfAborted();
  });
  try {
    const a = queue.submit({ message: "active" });
    const b = queue.submit({ message: "queued" });
    await started.promise;
    assert.equal((await queue.cancel(b.id)).status, "cancelled");
    const cancelling = queue.cancel(a.id);
    release.resolve();
    assert.equal((await cancelling).status, "cancelled");
    assert.equal(calls, 1);
    assert.equal(queue.get(a.id).errorCode, null);
    await queue.close();
    assert.throws(() => queue.submit({ message: "closed" }));
    assert.equal(
      db.prepare("SELECT * FROM background_task_executor").get(),
      undefined,
    );
  } finally {
    release.resolve();
    await queue.close();
    db.close();
  }
});

test("T12 completion after an already completed effect is not falsely reported cancelled", async () => {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db);
  const started = deferred();
  const release = deferred();
  const queue = new TaskQueue(store, async () => {
    started.resolve();
    await release.promise;
  });
  try {
    const task = queue.submit({ message: "effect complete" });
    await started.promise;
    const cancel = queue.cancel(task.id);
    release.resolve();
    assert.equal((await cancel).status, "succeeded");
  } finally {
    release.resolve();
    await queue.close();
    db.close();
  }
});

test("T12 SSE coalesces snapshots, respects resource limits, and disconnect does not cancel work", async () => {
  const db = openDatabase(":memory:");
  const started = deferred();
  const release = deferred();
  const queue = new TaskQueue(new TaskStore(db), async () => {
    started.resolve();
    await release.promise;
  });
  try {
    const task = queue.submit({ message: "stream" });
    const signal = new AbortController();
    const reader = taskEventStream(queue, task.id, signal.signal).getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /event: task/u);
    await started.promise;
    const second = await reader.read();
    assert.match(new TextDecoder().decode(second.value), /running/u);
    let received = false;
    const pending = reader.read().then((v) => {
      received = true;
      return v;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(received, false, "must not reemit same revision forever");
    signal.abort();
    assert.equal((await pending).done, true);
    assert.equal(queue.get(task.id).status, "running");
    const unsubs = Array.from({ length: 32 }, () => queue.subscribe(() => {}));
    assert.throws(() => queue.subscribe(() => {}));
    unsubs.forEach((unsub) => unsub());
    release.resolve();
    assert.equal((await settle(queue, task.id)).status, "succeeded");
    const terminal = taskEventStream(
      queue,
      task.id,
      new AbortController().signal,
    ).getReader();
    assert.match(
      new TextDecoder().decode((await terminal.read()).value),
      /succeeded/u,
    );
    assert.equal((await terminal.read()).done, true);
  } finally {
    release.resolve();
    await queue.close();
    db.close();
  }
});

test("T12 worker failures and listener failures expose only stable codes", async () => {
  const db = openDatabase(":memory:");
  const queue = new TaskQueue(new TaskStore(db), async () => {
    throw new Error("secret-key");
  });
  try {
    queue.subscribe(() => {
      throw new Error("broken UI");
    });
    const task = queue.submit({ message: "error" });
    const result = await settle(queue, task.id);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "execution_failed");
    assert.equal(JSON.stringify(result).includes("secret-key"), false);
  } finally {
    await queue.close();
    db.close();
  }
});

test("T12 v3 databases migrate queue tables preserving existing pending archive records", () => {
  const dir = mkdtempSync(join(tmpdir(), "doggie-task-migration-"));
  const path = join(dir, "test.db");
  let db = openDatabase(path);
  db.exec(
    "DROP TRIGGER background_task_payload_immutable; DROP TABLE background_tasks; DROP TABLE background_task_executor; DELETE FROM schema_migrations WHERE version=4; UPDATE schema_meta SET value='3' WHERE key='schema_version'",
  );
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(
      db.prepare("SELECT name FROM schema_migrations WHERE version=4").get()?.[
        "name"
      ],
      MIGRATIONS[3]?.name,
    );
    assert.equal(new TaskStore(db).list().length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const cancelled of [false, true]) {
  test(`T12 terminal storage failure after committed effect fails closed, never reports cancellation (${cancelled})`, async () => {
    const db = openDatabase(":memory:");
    const store = new TaskStore(db);
    let effect = false;
    const started = deferred();
    const release = deferred();
    const queue = new TaskQueue(store, async () => {
      started.resolve();
      await release.promise;
      effect = true;
    });
    db.exec(
      "CREATE TRIGGER inject_success_failure BEFORE UPDATE OF status ON background_tasks WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'secret-storage-fault'); END",
    );
    const task = queue.submit({ message: "commit then storage failure" });
    try {
      await started.promise;
      const cancelling = cancelled ? queue.cancel(task.id) : undefined;
      release.resolve();
      await cancelling;
      for (let i = 0; i < 5; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(effect, true);
      assert.equal(queue.get(task.id).status, "running");
      assert.equal(queue.get(task.id).errorCode, null);
      assert.throws(
        () => queue.submit({ message: "new work" }),
        (error) =>
          error instanceof TaskError &&
          error.kind === "faulted" &&
          !error.message.includes("secret"),
      );
      const closing = queue.close();
      assert.equal(queue.close(), closing);
      await assert.rejects(
        closing,
        (error) => error instanceof TaskError && error.kind === "faulted",
      );
      assert.equal(
        db.prepare("SELECT * FROM background_task_executor").get(),
        undefined,
      );
      db.exec("DROP TRIGGER inject_success_failure");
      const recovered = new TaskQueue(new TaskStore(db), async () => {
        throw new Error("must not replay effect");
      });
      try {
        assert.equal(recovered.get(task.id).errorCode, "interrupted");
        assert.equal(recovered.get(task.id).status, "failed");
      } finally {
        await recovered.close();
      }
    } finally {
      release.resolve();
      await queue.close().catch(() => undefined);
      db.close();
    }
  });
}

test("T12 identical enqueue timestamps still claim in durable FIFO sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "doggie-task-fifo-"));
  const path = join(dir, "test.db");
  let db = openDatabase(path);
  try {
    const store = new TaskStore(db);
    const tasks = Array.from({ length: 8 }, (_, i) =>
      store.enqueue({ message: `FIFO ${i}` }),
    );
    // Simulate a clock with only one tick; insertion sequence is immutable.
    db.exec(
      "DROP TRIGGER background_task_payload_immutable; UPDATE background_tasks SET created_at='2026-10-08T00:00:00.000Z'",
    );
    db.close();
    db = openDatabase(path);
    const reopened = new TaskStore(db);
    assert.deepEqual(
      tasks.map(() => reopened.claim()?.task.id),
      tasks.map((task) => task.id),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T12 queue latches a fault when the post-drain queued probe fails", async () => {
  const db = openDatabase(":memory:");
  const store = new TaskStore(db);
  const original = store.hasQueued.bind(store);
  let probes = 0;
  store.hasQueued = () => {
    probes += 1;
    if (probes > 0) throw new Error("private storage failure");
    return original();
  };
  const queue = new TaskQueue(store, async () => undefined);
  try {
    const task = queue.submit({ message: "probe fault" });
    for (
      let count = 0;
      count < 50 && queue.get(task.id).status === "queued";
      count += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.throws(
      () => queue.submit({ message: "must reject" }),
      (error) => error instanceof TaskError && error.kind === "faulted",
    );
    await assert.rejects(
      queue.close(),
      (error) => error instanceof TaskError && error.kind === "faulted",
    );
    assert.equal(
      db.prepare("SELECT * FROM background_task_executor").get(),
      undefined,
    );
  } finally {
    await queue.close().catch(() => undefined);
    db.close();
  }
});
