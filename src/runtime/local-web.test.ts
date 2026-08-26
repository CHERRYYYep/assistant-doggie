import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { MemoryModel } from "../application/archive-runtime.ts";
import { createNew } from "../domain/classification.ts";
import { minimalExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { DoggieMcpTools } from "../mcp/tools.ts";
import { openDatabase } from "../storage/database.ts";
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
      assert.match(await index.text(), /Doggie 工作记忆/u);

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
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/responses",
      ],
    );
    assert.equal(requests[0]?.body["model"], "fixture-model");
    assert.equal(requests[1]?.body["model"], "fixture-model");
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
    const [response] = await Promise.all([chat, firstClose]);
    assert.equal(response.status, 500);

    const reopened = openDatabase(config.databasePath);
    try {
      const messages = new Store(reopened).listChatMessages(10);
      assert.deepEqual(
        messages.map(({ role }) => role),
        ["user", "assistant"],
      );
      assert.match(messages[1]?.content ?? "", /无法完成/u);
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
