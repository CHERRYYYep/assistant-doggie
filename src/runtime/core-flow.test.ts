/** Q4 acceptance through actual loopback HTTP, using temporary data and fake models. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

import type { AgentProcessRunner } from "../agent/process.ts";
import type { MemoryModel } from "../application/archive-runtime.ts";
import {
  askUser,
  createNew,
  type ClassificationResult,
} from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import * as schemas from "../http/response-schemas.ts";
import { DoggieMcpTools } from "../mcp/tools.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { TaskStore } from "../storage/tasks.ts";
import { resolveRuntimeConfig } from "./config.ts";
import { startDoggieLocalWeb, type DoggieLocalWeb } from "./local-web.ts";

class CoreFlowModel implements MemoryModel {
  readonly modelName = "core-flow-fake";
  classification: ClassificationResult = createNew(
    BucketType.Task,
    "项目甲",
    0.99,
    "明确的新事实",
  );
  readonly extracted: string[] = [];
  async classify() {
    return this.classification;
  }
  async extract(text: string) {
    this.extracted.push(text);
    return createExtraction({
      summary: `${text}摘要`,
      evidences: [`${text}证据`],
      todos: [`${text}待办`],
      tags: [`${text}标签`],
    });
  }
}
function config(directory: string, agent = false) {
  return resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "core-flow-fake-key",
      OPENAI_MODEL: "core-flow-fake-model",
      DOGGIE_DATABASE_PATH: join(directory, "core-flow.sqlite"),
      DOGGIE_SERVER_ADDRESS: "127.0.0.1:0",
      ...(agent ? { DOGGIE_AGENT_CODEX_COMMAND: process.execPath } : {}),
    },
    {},
    directory,
  );
}
async function request<T>(
  web: DoggieLocalWeb,
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; status?: number } = {},
): Promise<T> {
  const response = await fetch(new URL(path, web.url), {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers:
      options.body === undefined ? {} : { "content-type": "application/json" },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(5_000),
  });
  const payload: unknown = await response.json();
  assert.equal(response.status, options.status ?? 200, JSON.stringify(payload));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return schema.parse(payload);
}
function chat(web: DoggieLocalWeb, message: string) {
  return request(web, "/api/chat", schemas.chatResponseSchema, {
    body: { message },
  });
}
function pending(model: CoreFlowModel, first: string, other: string) {
  model.classification = askUser(
    BucketType.Task,
    undefined,
    0.5,
    "两个主题需要用户选择",
    "保存到哪里？",
    [first, other],
  );
}
async function taskEvents(web: DoggieLocalWeb, id: string) {
  const response = await fetch(new URL(`/api/tasks/${id}/events`, web.url), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/u,
  );
  const frames = (await response.text())
    .split("\n\n")
    .filter((frame) => frame.includes("data: "));
  assert.ok(frames.length > 0);
  let revision = 0;
  return frames.map((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data);
    const task = schemas.taskEventDataSchema.parse(
      JSON.parse(data.slice(6)) as unknown,
    );
    assert.ok(task.revision > revision);
    revision = task.revision;
    assert.ok(frame.split("\n").includes(`id: ${task.revision}`));
    return task;
  });
}

test("Q4 real HTTP closes four confirmations, evidence/move/revocation and restart recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-core-flow-"));
  const runtimeConfig = config(directory);
  const model = new CoreFlowModel();
  let web = await startDoggieLocalWeb(runtimeConfig, { model });
  try {
    const first = await chat(web, "项目甲进度100%");
    assert.equal(first.archive_state, "archived");
    const firstBucket = first.archive.bucket_id;
    assert.ok(firstBucket);
    model.classification = createNew(
      BucketType.Task,
      "项目乙",
      0.99,
      "新的明确主题",
    );
    const other = await chat(web, "项目乙进度80%");
    const otherBucket = other.archive.bucket_id;
    assert.ok(otherBucket);

    // A high-confidence model cannot authorize a vague write.
    const extractsBefore = model.extracted.length;
    const low = await chat(web, "那个任务继续");
    assert.equal(low.archive_state, "needs_confirmation");
    assert.equal(model.extracted.length, extractsBefore);
    assert.equal(web.store.getBucketDetail(otherBucket)?.entries.length, 1);
    await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      {
        body: {
          action: "discard",
          confirmation_granted: true,
          attempt_id: low.archive.attempt_id,
          text: "那个任务继续",
        },
      },
    );

    pending(model, firstBucket, otherBucket);
    const recommendedText = "推荐记录延迟72ms";
    const recommended = await chat(web, recommendedText);
    assert.equal(recommended.archive.recommended_bucket_id, firstBucket);
    assert.deepEqual(recommended.archive.available_actions, [
      "append_recommended",
      "append_alternative",
      "create_new",
      "discard",
    ]);
    const recommendedChoice = {
      action: "append",
      confirmation_granted: true,
      attempt_id: recommended.archive.attempt_id,
      text: recommendedText,
      bucket_id: firstBucket,
    };
    const saved = await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      { body: recommendedChoice },
    );
    const savedEntry = saved.archive.entry_id;
    assert.ok(savedEntry);
    assert.equal(saved.archive.bucket_id, firstBucket);
    assert.equal(saved.archive_state, "archived");
    const count = web.store.getBucketDetail(firstBucket)?.entries.length;
    await request(web, "/api/chat/confirm", schemas.errorResponseSchema, {
      body: recommendedChoice,
      status: 409,
    });
    assert.equal(web.store.getBucketDetail(firstBucket)?.entries.length, count);

    const alternativeText = "备选记录延迟61ms";
    const alternative = await chat(web, alternativeText);
    const alternativeSaved = await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      {
        body: {
          action: "append",
          confirmation_granted: true,
          attempt_id: alternative.archive.attempt_id,
          text: alternativeText,
          bucket_id: otherBucket,
        },
      },
    );
    assert.equal(alternativeSaved.archive.bucket_id, otherBucket);

    const createText = "新主题记录延迟51ms";
    const createPending = await chat(web, createText);
    const created = await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      {
        body: {
          action: "create",
          confirmation_granted: true,
          attempt_id: createPending.archive.attempt_id,
          text: createText,
          title: "项目丙",
          bucket_type: "task",
        },
      },
    );
    assert.equal(created.archive.bucket?.title, "项目丙");
    assert.equal(web.store.listBuckets().length, 3);

    const discardedText = "不保存记录延迟41ms";
    const discardPending = await chat(web, discardedText);
    const discarded = await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      {
        body: {
          action: "discard",
          confirmation_granted: true,
          attempt_id: discardPending.archive.attempt_id,
          text: discardedText,
        },
      },
    );
    assert.equal(discarded.archive_state, "discarded");
    assert.equal(discarded.archive.entry_id, null);
    const query = (text: string) =>
      request(
        web,
        `/api/memory/query?q=${encodeURIComponent(text)}`,
        schemas.memoryQueryResponseSchema,
      );
    assert.equal((await query(discardedText)).total_entries, 0);
    const evidence = await query(recommendedText);
    assert.equal(evidence.results[0]?.entry.id, savedEntry);
    assert.ok(
      evidence.evidence.some(
        (memory) =>
          memory.kind === "evidence" &&
          memory.text === `${recommendedText}证据` &&
          memory.entry_id === savedEntry,
      ),
    );

    const moved = await request(
      web,
      "/api/corrections/move",
      schemas.moveEntryResponseSchema,
      {
        body: {
          entry_id: savedEntry,
          target_bucket_id: otherBucket,
          command_text: "用户明确移动到项目乙",
        },
      },
    );
    assert.equal(moved.entry.bucket_id, otherBucket);
    assert.equal(
      (await query(recommendedText)).results[0]?.entry.bucket_id,
      otherBucket,
    );
    const revoked = await request(
      web,
      `/api/entries/${savedEntry}`,
      schemas.revokeEntryResponseSchema,
      { method: "DELETE" },
    );
    assert.equal(revoked.bucket_id, otherBucket);
    assert.deepEqual(
      await request(
        web,
        `/api/entries/${savedEntry}`,
        schemas.revokeEntryResponseSchema,
        { method: "DELETE" },
      ),
      revoked,
    );
    const after = await query(recommendedText);
    assert.equal(after.total_entries, 0);
    assert.deepEqual(after.evidence, []);
    const detail = await request(
      web,
      `/api/buckets/${otherBucket}`,
      schemas.bucketDetailResponseSchema,
    );
    assert.equal(
      detail.detail.entries.some((entry) => entry.id === savedEntry),
      false,
    );
    assert.equal(
      detail.detail.memories.some((memory) => memory.entry_id === savedEntry),
      false,
    );
    assert.doesNotMatch(detail.detail.bucket.summary, /推荐记录/u);

    // An unresolved confirmation must retain the original text across restart.
    const recoveryText = "重启待确认记录延迟31ms";
    const recovery = await chat(web, recoveryText);
    assert.equal(recovery.archive_state, "needs_confirmation");
    const historyBefore = await request(
      web,
      "/api/chat/history?limit=100",
      schemas.chatHistoryResponseSchema,
    );
    assert.ok(
      historyBefore.messages.some((message) =>
        JSON.stringify(message.details).includes('"archive_state":"revoked"'),
      ),
    );
    await web.close();

    // Simulate a previous process leaving durable running work; no model is run here.
    const interruptedDatabase = openDatabase(runtimeConfig.databasePath);
    let interruptedId: string;
    try {
      const tasks = new TaskStore(interruptedDatabase);
      const task = tasks.enqueue({
        message: "interrupted-work-must-not-replay",
      });
      interruptedId = task.id;
      assert.equal(tasks.claim()?.task.id, task.id);
    } finally {
      interruptedDatabase.close();
    }
    web = await startDoggieLocalWeb(runtimeConfig, { model });
    const historyAfter = await request(
      web,
      "/api/chat/history?limit=100",
      schemas.chatHistoryResponseSchema,
    );
    assert.deepEqual(historyAfter, historyBefore);
    assert.equal((await query(recommendedText)).total_entries, 0);
    const interrupted = await request(
      web,
      `/api/tasks/${interruptedId}`,
      schemas.taskResponseSchema,
    );
    assert.equal(interrupted.task.status, "failed");
    assert.equal(interrupted.task.errorCode, "interrupted");
    assert.equal(
      model.extracted.includes("interrupted-work-must-not-replay"),
      false,
    );
    const recovered = await request(
      web,
      "/api/chat/confirm",
      schemas.chatConfirmationResponseSchema,
      {
        body: {
          action: "append",
          confirmation_granted: true,
          attempt_id: recovery.archive.attempt_id,
          text: recoveryText,
          bucket_id: firstBucket,
        },
      },
    );
    assert.equal(recovered.archive_state, "archived");

    // MCP and Web share storage, but only explicit Web confirmation creates memory.
    const mcpDatabase = openDatabase(runtimeConfig.databasePath);
    try {
      new DoggieMcpTools(new Store(mcpDatabase)).proposeEntry(
        "MCP共库记录延迟21ms",
        firstBucket,
      );
      const history = await request(
        web,
        "/api/chat/history?limit=100",
        schemas.chatHistoryResponseSchema,
      );
      const proposal = history.messages.at(-1);
      assert.ok(proposal);
      const details = z
        .object({
          source_text: z.string(),
          archive: schemas.archiveProjectionSchema.extend({
            submitted_for_confirmation: z.literal(true).optional(),
          }),
        })
        .parse(proposal.details);
      assert.equal(details.archive.archive_state, "needs_confirmation");
      assert.equal((await query("MCP共库记录延迟21ms")).total_entries, 0);
      const mcpConfirmed = await request(
        web,
        "/api/chat/confirm",
        schemas.chatConfirmationResponseSchema,
        {
          body: {
            action: "append",
            confirmation_granted: true,
            attempt_id: details.archive.attempt_id,
            text: details.source_text,
            bucket_id: firstBucket,
          },
        },
      );
      assert.ok(
        (await query("MCP共库记录延迟21ms")).results.some(
          (hit) =>
            hit.entry.id === mcpConfirmed.archive.entry_id &&
            hit.memories.some(
              (memory) =>
                memory.kind === "evidence" &&
                memory.text === "MCP共库记录延迟21ms证据",
            ),
        ),
      );
    } finally {
      mcpDatabase.close();
    }
  } finally {
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Q4 real HTTP task submission, SSE, cancellation and explicit CLI approval preserve authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-core-tasks-"));
  const model = new CoreFlowModel();
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let runs = 0;
  const runner: AgentProcessRunner = {
    run: async (input) => {
      runs++;
      started();
      return new Promise<never>((_, reject) => {
        if (input.signal.aborted)
          reject(new DOMException("cancelled", "AbortError"));
        else
          input.signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
      });
    },
  };
  const web = await startDoggieLocalWeb(config(directory, true), {
    model,
    agentRunner: runner,
  });
  try {
    const accepted = await request(
      web,
      "/api/tasks",
      schemas.taskResponseSchema,
      { body: { message: "后台保存记录完成91%" }, status: 202 },
    );
    const events = await taskEvents(web, accepted.task.id);
    assert.equal(events.at(-1)?.status, "succeeded");
    const history = await request(
      web,
      "/api/chat/history",
      schemas.chatHistoryResponseSchema,
    );
    assert.equal(
      history.messages.filter((message) => message.role === "user").length,
      1,
    );
    assert.equal(
      (
        await request(
          web,
          `/api/tasks/${accepted.task.id}/cancel`,
          schemas.taskResponseSchema,
          { body: {} },
        )
      ).task.status,
      "succeeded",
    );
    const capability = await request(
      web,
      "/api/agent/capabilities",
      schemas.agentCapabilitiesResponseSchema,
    );
    assert.deepEqual(capability.backends, ["codex"]);
    const instruction = "只读查看当前记忆，等待取消";
    const proposal = await request(
      web,
      "/api/agent/tasks",
      schemas.agentTaskResponseSchema,
      {
        body: { backend: "codex", workspaceId: null, instruction },
        status: 201,
      },
    );
    assert.equal(proposal.task.status, "pending");
    assert.equal(runs, 0);
    await request(
      web,
      `/api/agent/tasks/${proposal.task.id}/approve`,
      schemas.errorResponseSchema,
      {
        body: {
          instruction: `${instruction}extra`,
          confirmation_granted: true,
        },
        status: 409,
      },
    );
    assert.equal(runs, 0);
    const approval = await request(
      web,
      `/api/agent/tasks/${proposal.task.id}/approve`,
      schemas.agentApprovalResponseSchema,
      { body: { instruction, confirmation_granted: true }, status: 202 },
    );
    await began;
    assert.equal(runs, 1);
    const queued = await request(
      web,
      "/api/tasks",
      schemas.taskResponseSchema,
      { body: { message: "取消排队记录完成11%" }, status: 202 },
    );
    assert.equal(queued.task.status, "queued");
    const cancelled = await request(
      web,
      `/api/tasks/${queued.task.id}/cancel`,
      schemas.taskResponseSchema,
      { body: {} },
    );
    assert.equal(cancelled.task.status, "cancelled");
    const cancelledAgent = await request(
      web,
      `/api/agent/tasks/${proposal.task.id}/cancel`,
      schemas.agentTaskResponseSchema,
      { body: {} },
    );
    assert.equal(cancelledAgent.task.status, "cancelled");
    assert.equal(
      (await taskEvents(web, approval.queueTask.id)).at(-1)?.status,
      "cancelled",
    );
    assert.equal(model.extracted.includes("取消排队记录完成11%"), false);
    const remembered = await request(
      web,
      "/api/memory/query?q=取消排队记录",
      schemas.memoryQueryResponseSchema,
    );
    assert.equal(remembered.total_entries, 0);
    assert.equal(runs, 1);
    assert.equal(
      (await request(web, "/api/tasks", schemas.tasksResponseSchema)).tasks
        .length,
      3,
    );
  } finally {
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Q4 actual browser API modules complete the loopback workflow with generated validation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-browser-contract-"));
  const model = new CoreFlowModel();
  const web = await startDoggieLocalWeb(config(directory), { model });
  const client = await import("../../web/assets/api.ts");
  const networkFetch = globalThis.fetch;
  // Browser URLs are same-origin paths. Resolve only those paths to this
  // isolated loopback server; keep the actual HTTP transport and parsers.
  globalThis.fetch = (input, init) =>
    networkFetch(
      typeof input === "string" && input.startsWith("/")
        ? new URL(input, web.url)
        : input,
      init,
    );
  try {
    const first = await client.postChatMessage({ message: "前端甲延迟82ms" });
    const entryId = first.archive.entry_id;
    const sourceId = first.archive.bucket_id;
    assert.ok(entryId && sourceId);
    model.classification = createNew(BucketType.Task, "前端乙", 0.99, "新主题");
    const second = await client.postChatMessage({ message: "前端乙延迟64ms" });
    const targetId = second.archive.bucket_id;
    assert.ok(targetId);
    assert.equal((await client.fetchActiveBuckets()).buckets.length, 2);
    const before = await client.fetchMemoryQuery("前端甲延迟82ms");
    assert.ok(before.evidence.some((memory) => memory.entry_id === entryId));
    const moved = await client.postEntryMove({
      entry_id: entryId,
      target_bucket_id: targetId,
      command_text: "移动测试记录",
    });
    assert.equal(moved.entry.bucket_id, targetId);
    assert.ok(
      (await client.fetchBucketDetail(targetId)).detail.entries.some(
        (entry) => entry.id === entryId,
      ),
    );
    const revoked = await client.revokeEntryRequest(entryId);
    assert.deepEqual(await client.revokeEntryRequest(entryId), revoked);
    assert.ok(
      !(await client.fetchMemoryQuery("前端甲延迟82ms")).evidence.some(
        (memory) => memory.entry_id === entryId,
      ),
    );
    assert.ok(
      (await client.fetchChatHistory()).messages.some((message) =>
        JSON.stringify(message.details).includes('"archive_state":"revoked"'),
      ),
    );
    pending(model, targetId, sourceId);
    const text = "前端询问记录延迟49ms";
    const submitted = await client.postTask({ message: text });
    const terminal = await client.watchTask(submitted.task, () => {}, {
      budgetMs: 5_000,
      pollIntervalMs: 5,
    });
    assert.equal(terminal.status, "succeeded");
    assert.equal(
      (await client.fetchTask(terminal.id)).task.status,
      "succeeded",
    );
    assert.ok(
      (await client.fetchTasks()).tasks.some((task) => task.id === terminal.id),
    );
    const history = await client.fetchChatHistory();
    const assistant = history.messages.findLast(
      (message) => message.role === "assistant",
    );
    const details = z
      .object({ archive: schemas.archiveProjectionSchema })
      .parse(assistant?.details);
    assert.equal(details.archive.archive_state, "needs_confirmation");
    const discarded = await client.postChatConfirmation({
      confirmation_granted: true,
      attempt_id: details.archive.attempt_id,
      text,
      action: "discard",
    });
    assert.equal(discarded.archive_state, "discarded");
    assert.equal(
      (await client.postTaskCancel(terminal.id)).task.status,
      "succeeded",
    );
  } finally {
    globalThis.fetch = networkFetch;
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
