import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import { createNew } from "../domain/classification.ts";
import { createExtraction, type ExtractionResult } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { ConcreteDoggieHttpApi } from "./api.ts";
import { createDoggieApp } from "./app.ts";

class TodoModel implements MemoryModel {
  readonly modelName = "todo-http-model";
  readonly extraction: ExtractionResult = createExtraction({
    summary: "TODO 摘要",
    todos: ["完成 T14"],
  });

  async classify() {
    return createNew(BucketType.Task, "T14", 0.99, "明确任务");
  }

  async extract() {
    return this.extraction;
  }
}

function localRequest(
  app: ReturnType<typeof createDoggieApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Host")) headers.set("Host", "127.0.0.1:8787");
  return Promise.resolve(
    app.request(`http://127.0.0.1:8787${path}`, { ...init, headers }),
  );
}

test("TODO HTTP chain exposes agenda, plan, transition, reopen, and conflict", async () => {
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 10, 4, 0, 0, tick++));
  const store = new Store(openDatabase(":memory:"), clock);
  const runtime = new ArchiveRuntime(store, new TodoModel());
  const api = new ConcreteDoggieHttpApi(store, runtime, { clock });
  const app = createDoggieApp(api, []);

  const archive = await api.archive({ text: "完成 T14" });
  const todoId = archive.memory_item_ids[0];
  assert.ok(todoId);

  const agenda = await localRequest(app, "/api/agenda");
  assert.equal(agenda.status, 200);
  const agendaBody = (await agenda.json()) as {
    readonly todos: readonly { readonly id: string; readonly status: string }[];
  };
  assert.deepEqual(
    agendaBody.todos.map((todo) => todo.id),
    [todoId],
  );

  const todo = store.getTodo(todoId)!;
  const plan = await localRequest(app, `/api/todos/${todoId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scheduled_at: "2026-11-04T09:00:00Z",
      due_at: "2026-11-04T10:00:00Z",
      repeat_rule: null,
      raw_time: {
        scheduled_text: "今天上午",
        due_text: "今天十点",
        time_zone: "Asia/Shanghai",
      },
      command_text: "设置 T14 计划",
      expected_updated_at: todo.updatedAt,
    }),
  });
  assert.equal(plan.status, 200);
  const planBody = (await plan.json()) as {
    readonly todo: {
      readonly updated_at: string;
      readonly scheduled_at: string;
    };
  };
  assert.equal(planBody.todo.scheduled_at, "2026-11-04T09:00:00.000Z");

  const transition = await localRequest(
    app,
    `/api/todos/${todoId}/transition`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "done",
        command_text: "完成 T14",
        expected_updated_at: planBody.todo.updated_at,
      }),
    },
  );
  assert.equal(transition.status, 200);

  const stale = await localRequest(app, `/api/todos/${todoId}/reopen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command_text: "重新打开",
      expected_updated_at: planBody.todo.updated_at,
    }),
  });
  assert.equal(stale.status, 409);

  const invalid = await localRequest(app, `/api/todos/${todoId}/transition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "open",
      command_text: "重新打开",
      expected_updated_at: "2026-11-04T00:00:00.000Z",
      extra: true,
    }),
  });
  assert.equal(invalid.status, 400);
});
