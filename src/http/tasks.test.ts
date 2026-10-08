import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import { TaskQueue } from "../application/task-queue.ts";
import { createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { taskSnapshotSchema } from "../domain/task.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { TaskStore } from "../storage/tasks.ts";
import { ConcreteDoggieHttpApi } from "./api.ts";
import { createDoggieApp } from "./app.ts";

function setup(model?: MemoryModel) {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const runtime = new ArchiveRuntime(
    store,
    model ?? {
      modelName: "task-test",
      async classify() {
        return createNew(BucketType.Task, "测试任务", 0.99, "明确事实");
      },
      async extract() {
        return minimalExtraction("完成事实");
      },
    },
  );
  const api = new ConcreteDoggieHttpApi(store, runtime);
  const tasks = new TaskQueue(new TaskStore(db), async (payload, signal) =>
    api.chat(payload, signal),
  );
  const app = createDoggieApp(api, [], [], tasks);
  const request = (
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) =>
    Promise.resolve(
      app.request(`http://127.0.0.1:8787${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: "127.0.0.1:8787",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { db, store, tasks, request };
}

test("T12 HTTP task submission, SSE completion, history, strict contracts and missing IDs", async () => {
  const { db, store, tasks, request } = setup();
  try {
    assert.equal(
      (await request("/api/tasks", { message: "value", unknown: 1 })).status,
      400,
    );
    assert.equal(
      (
        await request(
          "/api/tasks",
          { message: "value" },
          { origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    const response = await request("/api/tasks", {
      message: "任务队列确认发布完成 100%",
    });
    assert.equal(response.status, 202);
    const payload: unknown = await response.json();
    assert.ok(
      typeof payload === "object" && payload !== null && "task" in payload,
    );
    const task = taskSnapshotSchema.parse(payload.task);
    const events = await request(`/api/tasks/${task.id}/events`);
    assert.equal(events.headers.get("cache-control"), "no-store");
    assert.match(
      events.headers.get("content-type") ?? "",
      /text\/event-stream/u,
    );
    assert.match(await events.text(), /succeeded/u);
    assert.equal(store.listBuckets().length, 1);
    assert.equal(store.listChatMessages(10).length, 2);
    assert.equal(
      (await request(`/api/tasks/${task.id}/cancel`, { unknown: 1 })).status,
      400,
    );
    const cancelled = await request(`/api/tasks/${task.id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    assert.equal(tasks.get(task.id).status, "succeeded");
    assert.equal((await request("/api/tasks/not-an-id")).status, 400);
    assert.equal(
      (await request("/api/tasks/00000000-0000-4000-8000-000000000001")).status,
      404,
    );
    const list: unknown = await (await request("/api/tasks")).json();
    assert.ok(typeof list === "object" && list !== null && "tasks" in list);
    assert.ok(Array.isArray(list.tasks));
    assert.equal(list.tasks.length, 1);
  } finally {
    await tasks.close();
    db.close();
  }
});

test("T12 HTTP background cancellation preserves user evidence but cannot commit a late model result", async () => {
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: MemoryModel = {
    modelName: "noncooperative-fake",
    async classify() {
      started();
      await delayed;
      return createNew(BucketType.Task, "late", 0.99, "明确事实");
    },
    async extract() {
      return minimalExtraction("late");
    },
  };
  const { db, store, tasks, request } = setup(model);
  try {
    const response = await request("/api/tasks", {
      message: "延迟模型收到事实 100%",
    });
    const body: unknown = await response.json();
    assert.ok(typeof body === "object" && body !== null && "task" in body);
    const task = taskSnapshotSchema.parse(body.task);
    await began;
    const cancelling = request(`/api/tasks/${task.id}/cancel`, {});
    release();
    const cancel = await cancelling;
    assert.equal(cancel.status, 200);
    assert.equal(tasks.get(task.id).status, "cancelled");
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(store.listBuckets().length, 0);
    assert.equal(
      store.listChatMessages(10).filter((message) => message.role === "user")
        .length,
      1,
    );
  } finally {
    release();
    await tasks.close();
    db.close();
  }
});

test("T12 cancelled post-archive responder cannot persist late model tools or falsely undo committed archive", async () => {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const runtime = new ArchiveRuntime(store, {
    modelName: "committed-fake",
    async classify() {
      return createNew(BucketType.Task, "committed", 0.99, "明确事实");
    },
    async extract() {
      return minimalExtraction("committed");
    },
  });
  const controller = new AbortController();
  const api = new ConcreteDoggieHttpApi(store, runtime, {
    chatResponder: {
      async respond({ signal }) {
        assert.equal(signal, controller.signal);
        controller.abort("private reason");
        return {
          assistantText: "late",
          toolMessages: [
            {
              name: "late-tool",
              callId: "late-id",
              arguments: {},
              output: { late: true },
            },
          ],
        };
      },
    },
  });
  try {
    const response = await api.chat(
      { message: "提交后取消回复测试 100%" },
      controller.signal,
    );
    assert.equal(response.archive_state, "archived");
    assert.equal(store.listBuckets().length, 1);
    assert.equal(
      store.listChatMessages(10).filter((message) => message.role === "tool")
        .length,
      0,
    );
    assert.notEqual(response.assistant_message.content, "late");
    assert.equal(response.chat_error, null);
  } finally {
    db.close();
  }
});
