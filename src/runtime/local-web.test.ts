import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { naturalLab } from "../../tests/fixtures/natural-conversation-cases.ts";
import {
  agentApprovalResponseSchema,
  agentWorkspaceResponseSchema,
  archiveProjectionSchema,
  chatHistoryResponseSchema,
  clarificationListResponseSchema,
  conversationInteractionListResponseSchema,
  conversationTurnResponseSchema,
  workItemResponseSchema,
} from "../http/response-schemas.ts";
import { DatabaseSync } from "node:sqlite";
import { TaskQueue } from "../application/task-queue.ts";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempDisposableSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { MemoryModel } from "../application/archive-runtime.ts";
import { appendExisting, createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { DoggieMcpTools } from "../mcp/tools.ts";
import { openDatabase, withTransaction } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { resolveRuntimeConfig } from "./config.ts";
import { startDoggieLocalWeb } from "./local-web.ts";

class FakeModel implements MemoryModel {
  readonly modelName = "t10b-fake-model";

  async classify(text: string) {
    return createNew(BucketType.Task, "浏览器 MVP", 0.99, `明确事实：${text}`);
  }

  async extract(text: string) {
    return minimalExtraction(`已记录：${text}`);
  }
}

function setupConfig(directory: string) {
  return resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_MODEL: "fixture-model",
      DOGGIE_DATABASE_PATH: join(directory, "doggie.db"),
      DOGGIE_SERVER_ADDRESS: "127.0.0.1:0",
    },
    {},
    directory,
  );
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("T10b real Web process serves frontend, archives through HTTP and recovers history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-local-web-"));
  const config = setupConfig(directory);
  try {
    const first = await startDoggieLocalWeb(config, { model: new FakeModel() });
    try {
      const index = await fetch(first.url);
      assert.equal(index.status, 200);
      assert.match(await index.text(), /Doggie · 个人工作记忆/u);

      const health = await fetch(new URL("health", first.url));
      assert.deepEqual(await json(health), {
        ok: true,
        service: "doggie-local-web",
      });

      const chat = await fetch(new URL("api/chat", first.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "浏览器启动链路完成 100%" }),
      });
      assert.equal(chat.status, 200);
      const payload = await json(chat);
      assert.equal(payload["archive_state"], "archived");
      assert.equal(first.store.listBuckets().length, 1);
      assert.equal(first.store.listChatMessages(10).length, 2);
    } finally {
      await first.close();
    }

    const reopened = await startDoggieLocalWeb(config, {
      model: new FakeModel(),
    });
    try {
      const history = await fetch(
        new URL("api/chat/history?limit=10", reopened.url),
      );
      const payload = await json(history);
      assert.equal(Array.isArray(payload["messages"]), true);
      assert.equal((payload["messages"] as unknown[]).length, 2);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T10b MCP proposal appears in Web history and is confirmed through the shared database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-mcp-web-"));
  const config = setupConfig(directory);
  const web = await startDoggieLocalWeb(config, { model: new FakeModel() });
  const mcpDatabase = openDatabase(config.databasePath);
  try {
    const tools = new DoggieMcpTools(new Store(mcpDatabase));
    const proposed = tools.proposeEntry("MCP 与 Web 共库事实 100%") as Record<
      string,
      unknown
    >;
    assert.equal(proposed["archive_state"], "needs_confirmation");
    const attemptId = proposed["attempt_id"];
    assert.equal(typeof attemptId, "string");

    const history = await json(
      await fetch(new URL("api/chat/history?limit=10", web.url)),
    );
    const messages = history["messages"] as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    const details = messages[0]?.["details"] as Record<string, unknown>;
    assert.equal(details["pending_confirmation"], true);

    const confirmation = await fetch(new URL("api/chat/confirm", web.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        confirmation_granted: true,
        action: "create",
        attempt_id: attemptId,
        text: "MCP 与 Web 共库事实 100%",
        title: "MCP 共库验证",
        bucket_type: "task",
      }),
    });
    assert.equal(confirmation.status, 200);
    assert.equal((await json(confirmation))["archive_state"], "archived");

    const buckets = await json(
      await fetch(new URL("api/buckets/active?limit=10", web.url)),
    );
    assert.equal((buckets["buckets"] as unknown[]).length, 1);
    assert.equal(web.store.listBuckets()[0]?.title, "MCP 共库验证");
  } finally {
    mcpDatabase.close();
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function responsesText(text: string): Response {
  return new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

test("T10b production composition wires config, transport, structured model and archive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-production-wire-"));
  const config = setupConfig(directory);
  const requests: Array<{
    readonly url: string;
    readonly body: Record<string, unknown>;
  }> = [];
  const replies = [
    JSON.stringify({
      action: "create_new",
      bucket_id: null,
      bucket_type: "task",
      title: "生产组装验证",
      confidence: 0.99,
      reason: "明确的新事实",
      should_ask_user: false,
      question: null,
      candidate_bucket_ids: [],
    }),
    JSON.stringify({
      summary: "生产组装链路已完成",
      todos: [],
      evidences: ["生产组装链路已完成 100%"],
      timeline_events: [],
      decisions: [],
      hypotheses: [],
      entities: ["Doggie"],
      tags: ["t10b"],
    }),
    "生产回复已读取归档上下文。",
  ];
  const web = await startDoggieLocalWeb(config, {
    fetchImplementation: (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return responsesText(replies.shift() ?? "{}");
    }) as typeof fetch,
  });
  try {
    const response = await fetch(new URL("api/chat", web.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "生产组装链路已完成 100%" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await json(response))["archive_state"], "archived");
    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
      ],
    );
    assert.equal(requests[0]?.body["model"], "fixture-model");
    assert.equal(requests[1]?.body["model"], "fixture-model");
    assert.equal(requests[2]?.body["model"], "fixture-model");
    assert.equal(Array.isArray(requests[2]?.body["tools"]), true);
    assert.equal(web.store.listBuckets()[0]?.title, "生产组装验证");
  } finally {
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T10b close is shared and cancels an in-flight production model call before closing SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-shutdown-cancel-"));
  const config = setupConfig(directory);
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const web = await startDoggieLocalWeb(config, {
    fetchImplementation: (async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      requestStarted();
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch,
  });
  try {
    const chat = fetch(new URL("api/chat", web.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "关闭期间的模型调用 100%" }),
    });
    await started;
    const firstClose = web.close();
    const secondClose = web.close();
    assert.equal(firstClose, secondClose);
    // T12 shutdown aborts the HTTP lifecycle and closes its socket rather than
    // manufacturing a 500/error assistant message after intentional cancellation.
    await Promise.all([assert.rejects(chat, /fetch failed/u), firstClose]);

    const reopened = openDatabase(config.databasePath);
    try {
      const messages = new Store(reopened).listChatMessages(10);
      assert.deepEqual(
        messages.map(({ role }) => role),
        ["user"],
      );
      assert.equal(new Store(reopened).listBuckets().length, 0);
      assert.equal(
        reopened.prepare("SELECT * FROM background_task_executor").get(),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await web.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T10b listen failure closes the startup database and leaves it reopenable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-listen-failure-"));
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const port = (blocker.address() as AddressInfo).port;
  const config = resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_MODEL: "fixture-model",
      DOGGIE_DATABASE_PATH: join(directory, "doggie.db"),
      DOGGIE_SERVER_ADDRESS: `127.0.0.1:${port}`,
    },
    {},
    directory,
  );
  try {
    await assert.rejects(
      startDoggieLocalWeb(config, { model: new FakeModel() }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EADDRINUSE",
    );
    const reopened = openDatabase(config.databasePath);
    reopened.close();
  } finally {
    blocker.close();
    await once(blocker, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T12 production tasks continue across SSE disconnect and shutdown closes streaming subscribers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-task-web-"));
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: MemoryModel = {
    modelName: "task-fake-model",
    async classify() {
      started();
      await delayed;
      return createNew(BucketType.Task, "后台完成", 0.99, "明确事实");
    },
    async extract() {
      return minimalExtraction("后台结果");
    },
  };
  const web = await startDoggieLocalWeb(setupConfig(directory), { model });
  try {
    const task = web.tasks.submit({ message: "后台继续执行测试 100%" });
    await began;
    const streamController = new AbortController();
    const events = await fetch(
      new URL(`api/tasks/${task.id}/events`, web.url),
      { signal: streamController.signal },
    );
    const reader = events.body?.getReader();
    assert.ok(reader);
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /running/u,
    );
    streamController.abort();
    assert.equal(web.tasks.get(task.id).status, "running");
    release();
    for (let i = 0; i < 100 && web.tasks.get(task.id).status === "running"; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(web.tasks.get(task.id).status, "succeeded");
    assert.equal(web.store.listBuckets().length, 1);
    const terminal = await fetch(
      new URL(`api/tasks/${task.id}/events`, web.url),
    );
    assert.match(await terminal.text(), /succeeded/u);
  } finally {
    release();
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T12 runtime shutdown drains noncooperative worker before closing SQLite and preserves queued jobs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-task-drain-"));
  let started = () => {};
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: MemoryModel = {
    modelName: "task-drain-fake",
    async classify() {
      started();
      await delayed;
      return createNew(BucketType.Task, "late", 0.99, "明确事实");
    },
    async extract() {
      return minimalExtraction("late");
    },
  };
  const web = await startDoggieLocalWeb(setupConfig(directory), { model });
  const a = web.tasks.submit({ message: "running at shutdown 100%" });
  const b = web.tasks.submit({ message: "queued at shutdown 100%" });
  try {
    await began;
    const stream = await fetch(new URL(`api/tasks/${a.id}/events`, web.url));
    const reader = stream.body?.getReader();
    assert.ok(reader);
    await reader.read();
    let closed = false;
    const closing = web.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.doesNotThrow(() => web.database.prepare("SELECT 1").get());
    release();
    await closing;
    assert.equal(closed, true);
    assert.throws(() => web.database.prepare("SELECT 1").get());
    const restarted = await startDoggieLocalWeb(setupConfig(directory), {
      model: new FakeModel(),
    });
    try {
      assert.equal(restarted.tasks.get(a.id).status, "cancelled");
      for (
        let i = 0;
        i < 100 && restarted.tasks.get(b.id).status !== "succeeded";
        i++
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(restarted.tasks.get(b.id).status, "succeeded");
      assert.equal(restarted.store.listBuckets().length, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    release();
    await web.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T12 startup bind failure closes database even when executor release fails, retaining original error", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-task-start-fail-"));
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const port = (blocker.address() as AddressInfo).port;
  const config = resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_MODEL: "fixture-model",
      DOGGIE_DATABASE_PATH: join(directory, "test.db"),
      DOGGIE_SERVER_ADDRESS: `127.0.0.1:${port}`,
    },
    {},
    directory,
  );
  const originalClose = TaskQueue.prototype.close;
  context.mock.method(
    TaskQueue.prototype,
    "close",
    async function (this: TaskQueue) {
      await originalClose.call(this);
      throw new Error("injected release failure");
    },
  );
  const originalDbClose = DatabaseSync.prototype.close;
  let closed = 0;
  context.mock.method(
    DatabaseSync.prototype,
    "close",
    function (this: DatabaseSync) {
      closed++;
      originalDbClose.call(this);
    },
  );
  try {
    await assert.rejects(
      startDoggieLocalWeb(config, { model: new FakeModel() }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "EADDRINUSE",
    );
    assert.equal(closed, 1);
  } finally {
    blocker.close();
    await once(blocker, "close");
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T13 real HTTP runtime composes approved CLI task queue, SSE and persisted result without model calls", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-t13-runtime-"));
  let runs = 0;
  const config = resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_MODEL: "fixture-model",
      DOGGIE_DATABASE_PATH: join(directory, "test.db"),
      DOGGIE_SERVER_ADDRESS: "127.0.0.1:0",
      DOGGIE_AGENT_CODEX_COMMAND: process.execPath,
    },
    {},
    directory,
  );
  const runtime = await startDoggieLocalWeb(config, {
    model: new FakeModel(),
    agentRunner: {
      async run() {
        runs++;
        return {
          output: "Runtime result",
          remoteId: "00000000-0000-4000-8000-000000000015",
        };
      },
    },
  });
  const post = (path: string, value: unknown) =>
    fetch(new URL(path, runtime.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    const capability = await json(
      await fetch(new URL("api/agent/capabilities", runtime.url)),
    );
    assert.deepEqual(capability["backends"], ["codex"]);
    const proposal = await json(
      await post("api/agent/tasks", {
        backend: "codex",
        workspaceId: null,
        instruction: "Read-only runtime test",
      }),
    );
    const task = proposal["task"] as { id: string; instruction: string };
    assert.equal(runs, 0);
    const accepted = await post(`api/agent/tasks/${task.id}/approve`, {
      instruction: task.instruction,
      confirmation_granted: true,
    });
    assert.equal(accepted.status, 202);
    const queueTask = (await json(accepted))["queueTask"] as { id: string };
    const stream = await fetch(
      new URL(`api/tasks/${queueTask.id}/events`, runtime.url),
    );
    assert.match(await stream.text(), /succeeded/);
    assert.equal(runs, 1);
    assert.equal(runtime.agents.get(task.id).output, "Runtime result");
    const asset = await fetch(new URL("assets/agents.ts", runtime.url));
    assert.equal(asset.status, 200);
    assert.doesNotMatch(await asset.text(), /\bimport type\b/);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback failure quarantines writes and drives Web worker and connection shutdown", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-storage-fault-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const web = await startDoggieLocalWeb(setupConfig(directory), {
    model: new FakeModel(),
  });
  const stopped = once(web.server, "close");
  const exec = web.database.exec.bind(web.database);
  t.mock.method(web.database, "exec", (sql: string) => {
    if (sql === "ROLLBACK") throw new Error("injected storage cleanup failure");
    exec(sql);
  });

  const inserted = "未提交的消息";
  assert.throws(
    () =>
      withTransaction(web.database, () => {
        web.store.appendChatMessageWithinTransaction({
          role: "user",
          content: inserted,
        });
        throw new Error("injected write failure");
      }),
    { kind: "storage_unavailable" },
  );
  assert.throws(
    () => web.store.appendChatMessage({ role: "user", content: "后一条消息" }),
    { kind: "storage_unavailable" },
  );
  await stopped;
  await assert.rejects(web.close(), { kind: "faulted" });
  assert.equal(web.database.isOpen, false);
  using observer = openDatabase(join(directory, "doggie.db"));
  assert.deepEqual(new Store(observer).listChatMessages(10), []);
});

test(
  "production direct and queued chat share the same turn coordinator",
  { timeout: 5000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "doggie-shared-turn-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const directText = "直接聊天正在整理实验结果 100%";
    const queuedText = "后台聊天正在记录测试结果 100%";
    const seen: string[][] = [];
    const web = await startDoggieLocalWeb(setupConfig(directory), {
      model: new FakeModel(),
      chatResponder: {
        async respond({ history, sourceText }) {
          seen.push(history.map(({ content }) => content));
          if (sourceText === directText) {
            started.resolve();
            await release.promise;
          }
          return { assistantText: `回复：${sourceText}` };
        },
      },
    });
    const post = (path: string, message: string) =>
      fetch(new URL(path, web.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
    const direct = post("api/chat", directText);
    try {
      await Promise.race([
        started.promise,
        direct.then(() => assert.fail("direct reply did not wait")),
      ]);
      assert.equal((await post("api/tasks", queuedText)).status, 202);
      assert.equal(web.tasks.list()[0]?.status, "running");
      assert.deepEqual(
        web.store.listChatMessages(10).map(({ content }) => content),
        [directText],
      );
      const finished = Promise.withResolvers<void>();
      const unsubscribe = web.tasks.subscribe(({ status }) => {
        if (status === "succeeded") finished.resolve();
        if (status === "failed" || status === "cancelled")
          finished.reject(new Error(status));
      });
      try {
        release.resolve();
        assert.equal((await direct).status, 200);
        await finished.promise;
        assert.deepEqual(seen, [
          [directText],
          [directText, `回复：${directText}`, queuedText],
        ]);
      } finally {
        unsubscribe();
      }
    } finally {
      release.resolve();
      await web.close();
      await direct.catch(() => undefined);
    }
  },
);

test("C3 composed preview delegates once to a registered workspace and returns the result only after explicit approval", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-c3-runtime-"));
  const repo = join(dir.path, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: repo,
      stdio: "pipe",
    });
  git("init", "-q");
  writeFileSync(join(repo, "report.txt"), "Captured TCP handshakes\n");
  git("add", "report.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const config = resolveRuntimeConfig(
    {
      OPENAI_API_KEY: "fixture-key",
      OPENAI_MODEL: "fixture-model",
      DOGGIE_DATABASE_PATH: join(dir.path, "test.db"),
      DOGGIE_SERVER_ADDRESS: "127.0.0.1:0",
      DOGGIE_AGENT_CODEX_COMMAND: process.execPath,
      DOGGIE_AGENT_WORKSPACE_ROOTS: JSON.stringify([repo]),
    },
    {},
    dir.path,
  );
  let runs = 0;
  const runtime = await startDoggieLocalWeb(config, {
    model: new FakeModel(),
    agentRunner: {
      async run({ cwd, task }) {
        runs++;
        assert.equal(cwd, repo);
        assert.match(task.instruction, /只检查握手正文/);
        assert.doesNotMatch(task.instruction, /UDP/);
        return { output: "报告缺少 SYN-ACK 的解释", remoteId: randomUUID() };
      },
    },
  });
  try {
    const post = (path: string, value: unknown) =>
      fetch(new URL(path, runtime.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const getCards = async () =>
      clarificationListResponseSchema.parse(
        await (
          await fetch(new URL("api/conversation/clarifications", runtime.url))
        ).json(),
      ).clarifications;
    const send = async (value: unknown) => {
      const response = await post("api/conversation/turns", value);
      assert.equal(response.status, 200);
      return conversationTurnResponseSchema.parse(await response.json()).result;
    };
    const workspace = agentWorkspaceResponseSchema.parse(
      await (await post("api/agent/workspaces", { path: repo })).json(),
    ).workspace;
    const createGoal = async (title: string) =>
      workItemResponseSchema.parse(
        await (
          await post("api/work-items", {
            requestId: randomUUID(),
            title,
            goal: title,
            acceptance: "列出描述中的遗漏，不改文件",
          })
        ).json(),
      ).workItem;
    const tcp = await createGoal("计网实验 TCP");
    await createGoal("计网实验 UDP");
    const openCard = async (title: string) => {
      const result = await send({
        action: "message",
        requestId: randomUUID(),
        text: `只读检查「${title}」的报告`,
      });
      assert.equal(result.kind, "clarification");
      return result.clarificationId;
    };
    const first = await openCard(tcp.title);
    const second = await openCard("计网实验 UDP");
    let card = (await getCards()).find(({ id }) => id === first);
    assert.ok(card);
    assert.equal(card.selected, null);
    assert.ok(card.candidates.some(({ id }) => id === tcp.id));
    await send({
      action: "select",
      requestId: randomUUID(),
      clarificationId: first,
      expectedRevision: card.revision,
      workItemId: tcp.id,
    });
    await send({
      action: "reply",
      requestId: randomUUID(),
      clarificationId: first,
      expectedRevision: card.revision + 1,
      text: "只检查握手正文",
    });
    card = (await getCards()).find(({ id }) => id === first);
    assert.ok(card);
    const input = {
      action: "delegate",
      requestId: randomUUID(),
      clarificationId: first,
      expectedRevision: card.revision,
      workspaceId: workspace.id,
      backend: "codex",
    };
    const receipt = await send(input);
    assert.deepEqual(await send(input), receipt);
    const pending = runtime.agents.list();
    assert.equal(pending.length, 1);
    const [task] = pending;
    assert.ok(task);
    assert.equal(task.status, "pending");
    assert.equal(runs, 0);
    const resultCard = (await getCards()).find(({ id }) => id === first);
    assert.equal(resultCard?.execution?.taskId, task.id);
    assert.equal(
      (await getCards()).find(({ id }) => id === second)?.execution,
      undefined,
    );
    assert.equal(
      (
        await post("api/conversation/turns", {
          ...input,
          confirmation_granted: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post("api/conversation/turns", {
          ...input,
          requestId: randomUUID(),
        })
      ).status,
      409,
    );
    const response = await post(`api/agent/tasks/${task.id}/approve`, {
      instruction: task.instruction,
      confirmation_granted: true,
    });
    assert.equal(response.status, 202);
    const approved = agentApprovalResponseSchema.parse(await response.json());
    const events = await fetch(
      new URL(`api/tasks/${approved.queueTask.id}/events`, runtime.url),
      { signal: AbortSignal.timeout(5000) },
    );
    assert.match(await events.text(), /succeeded/);
    assert.equal(runs, 1);
    assert.equal(
      (await getCards()).find(({ id }) => id === first)?.execution?.output,
      "报告缺少 SYN-ACK 的解释",
    );
    assert.equal(
      (await getCards()).find(({ id }) => id === second)?.execution,
      undefined,
    );
    await send({
      action: "cancel",
      requestId: randomUUID(),
      clarificationId: first,
      expectedRevision: card.revision,
    });
    assert.equal(
      (await getCards()).find(({ id }) => id === first)?.execution?.status,
      "stale",
    );
    assert.equal(runtime.agents.get(task.id).output, "");
    assert.equal(runtime.store.listBuckets().length, 0);
  } finally {
    await runtime.close();
  }
});

test("N3 natural input over loopback restores an Entry clarification across a Local Web restart", async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), "doggie-natural-web-"));
  const config = setupConfig(dir.path);
  let draftCalls = 0;
  const start = () =>
    startDoggieLocalWeb(config, {
      model: {
        modelName: "fake-natural-web",
        async classify(_text, candidates) {
          const bucket = candidates.find(
            ({ title }) => title === naturalLab.bucket,
          );
          return bucket === undefined
            ? createNew(BucketType.Experiment, naturalLab.bucket, 1, "测试记录")
            : appendExisting(bucket.id, BucketType.Experiment, 1, "测试记录");
        },
        async extract(text) {
          return minimalExtraction(text);
        },
      },
      chatResponder: {
        async respond() {
          return { assistantText: "SYN-ACK 确认已收到 SYN。" };
        },
      },
      async groundedResponder(input) {
        draftCalls++;
        assert.equal(input.original, naturalLab.original);
        assert.deepEqual(input.supplements, [naturalLab.chooseTcp]);
        assert.equal(input.target, null);
        assert.deepEqual(
          input.evidence.map(({ text }) => text),
          [naturalLab.tcp.entry],
        );
        return {
          kind: "answer",
          text: naturalLab.tcp.draft,
          quotes: input.evidence.map(({ entryId, text }) => ({
            entryId,
            quote: text,
          })),
        };
      },
    });
  const client = (origin: string) => {
    const get = (path: string) => fetch(new URL(path, origin));
    const post = (path: string, body: unknown) =>
      fetch(new URL(path, origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const turn = async (body: unknown) => {
      const response = await post("api/conversation/turns", body);
      const payload: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return conversationTurnResponseSchema.parse(payload).result;
    };
    const interactions = async () => {
      const response = await get("api/conversation/interactions");
      assert.equal(response.status, 200);
      return conversationInteractionListResponseSchema.parse(
        await response.json(),
      );
    };
    return { get, post, turn, interactions };
  };
  const baseline = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT (SELECT count(*) FROM entries) AS entries,
              (SELECT count(*) FROM memory_items) AS memories,
              (SELECT count(*) FROM work_items) AS goals,
              (SELECT count(*) FROM agent_tasks) AS executions,
              (SELECT count(*) FROM pending_actions) AS approvals`,
      )
      .get();
  let cardId: string;
  let sourceId: string | undefined;
  let originalCounts: ReturnType<typeof baseline>;
  const first = await start();
  try {
    const page = client(first.url);
    for (const sample of [naturalLab.tcp.entry, naturalLab.udp.entry]) {
      const saved = await page.post("api/archive", { text: sample });
      assert.equal(saved.status, 200);
      const payload = archiveProjectionSchema.parse(await saved.json());
      assert.equal(payload.archive_state, "archived");
      assert.ok(payload.entry_id);
      if (sample === naturalLab.tcp.entry) sourceId = payload.entry_id;
    }
    originalCounts = baseline(first.database);
    assert.equal(originalCounts?.["goals"], 0);
    const opened = await page.turn({
      action: "utterance",
      text: naturalLab.original,
      requestId: randomUUID(),
    });
    assert.equal(opened.kind, "clarification");
    cardId = opened.clarificationId;
    assert.equal(
      (await page.interactions()).interactions.find(({ id }) => id === cardId)
        ?.candidates.length,
      2,
    );
  } finally {
    await first.close();
  }
  const second = await start();
  try {
    const page = client(second.url);
    assert.equal((await page.get("/")).status, 200);
    const restored = await page.interactions();
    assert.equal(restored.snapshot.prompts[0]?.interactionId, cardId);
    assert.equal(
      (
        await page.turn({
          action: "utterance",
          text: naturalLab.interlude,
          requestId: randomUUID(),
          snapshot: restored.snapshot,
        })
      ).kind,
      "answer",
    );
    const fresh = (await page.interactions()).snapshot;
    const input = {
      action: "utterance",
      text: naturalLab.chooseTcp,
      requestId: randomUUID(),
      snapshot: fresh,
    };
    const result = await page.turn(input);
    assert.equal(result.kind, "clarification");
    assert.equal(result.clarificationId, cardId);
    const history = chatHistoryResponseSchema.parse(
      await (await page.get("api/chat/history")).json(),
    );
    assert.equal(
      history.messages.find(({ id }) => id === result.assistantMessageId)
        ?.content,
      naturalLab.tcp.draft,
    );
    const selected = (await page.interactions()).interactions.find(
      ({ id }) => id === cardId,
    );
    assert.ok(sourceId);
    assert.equal(selected?.selected?.id, sourceId);
    assert.equal(selected?.selected?.kind, "entry");
    assert.equal(selected?.awaiting, null);
    assert.deepEqual(await page.turn(input), result);
    assert.equal(draftCalls, 1);
    assert.deepEqual(baseline(second.database), originalCounts);
  } finally {
    await second.close();
  }
});
