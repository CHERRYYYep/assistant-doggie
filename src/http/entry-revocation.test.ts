import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArchiveRuntime,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import {
  appendExisting,
  askUser,
  createNew,
} from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { ConcreteDoggieHttpApi, type ChatResponder } from "./api.ts";
import { createDoggieApp } from "./app.ts";

class Model implements MemoryModel {
  readonly modelName = "fake-revocation";
  bucketId: string | undefined;
  uncertain = false;
  async classify() {
    return this.uncertain
      ? askUser(undefined, undefined, 0.3, "需要选择", "保存到哪里？", [])
      : this.bucketId === undefined
        ? createNew(BucketType.Task, "性能测试", 0.99, "明确事实")
        : appendExisting(this.bucketId, undefined, 0.99, "明确事实");
  }
  async extract(text: string) {
    return createExtraction({
      summary: text,
      evidences: [text],
      todos: ["复核指标"],
      tags: ["指标"],
    });
  }
}

function setup(responder?: ChatResponder) {
  const db = openDatabase(":memory:");
  const store = new Store(db);
  const model = new Model();
  const runtime = new ArchiveRuntime(store, model);
  const api = new ConcreteDoggieHttpApi(store, runtime, {
    chatResponder: responder,
  });
  const app = createDoggieApp(api, []);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost${path}`, {
      ...init,
      headers: { Host: "localhost", ...init.headers },
    });
  return { db, store, model, runtime, api, request };
}

test("Entry DELETE revokes effective evidence, is repeatable, preserves history and enforces local security", async () => {
  const ctx = setup();
  try {
    const chat = await ctx.api.chat({ message: "接口 p99 620ms" });
    const id = chat.archive.entry_id;
    assert.ok(id);
    const path = `/api/entries/${id}`;
    assert.equal(
      (
        await ctx.request(path, {
          method: "DELETE",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.ok(ctx.store.getEntry(id));
    assert.equal(
      (
        await ctx.request(path, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      400,
    );
    const response = await ctx.request(path, { method: "DELETE" });
    assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.deepEqual(
      await (await ctx.request(path, { method: "DELETE" })).json(),
      result,
    );
    assert.equal(ctx.store.getEntry(id), undefined);
    assert.equal(ctx.api.memoryQuery("620ms", 20).results.length, 0);
    assert.equal(
      ctx.store.getBucketDetail(chat.archive.bucket_id ?? "")?.memories.length,
      0,
    );
    assert.equal(ctx.store.listChatMessages(20).length, 2);
    const archived = ctx.api.chatHistory(20).messages.at(-1);
    assert.ok(
      archived &&
        typeof archived.details === "object" &&
        archived.details !== null,
    );
    const details = JSON.stringify(archived.details);
    assert.match(details, /"archive_state":"revoked"/);
    assert.match(details, /"available_actions":\[\]/);
    assert.match(details, /"extraction":null/);
    assert.equal(
      (await ctx.request("/api/entries/missing", { method: "DELETE" })).status,
      404,
    );
    assert.deepEqual(ctx.store.listModelChatMessages(40), []);
  } finally {
    ctx.db.close();
  }
});

test("confirmed pending history becomes revoked on reload, and moved cards use the current Bucket", async () => {
  const ctx = setup();
  try {
    const first = await ctx.api.chat({ message: "接口 p99 620ms" });
    const target = await ctx.api.archive({ text: "接口 QPS 400" });
    assert.ok(first.archive.entry_id && target.bucket_id);
    ctx.api.moveEntry({
      entry_id: first.archive.entry_id,
      target_bucket_id: target.bucket_id,
      command_text: "移动记录",
    });
    assert.match(
      JSON.stringify(ctx.api.chatHistory(40).messages),
      new RegExp(`"bucket_id":"${target.bucket_id}"`),
    );
    ctx.model.uncertain = true;
    const pending = await ctx.api.chat({ message: "另一个指标 p95 80ms" });
    const confirmed = await ctx.api.confirmChat({
      action: "append",
      attempt_id: pending.archive.attempt_id,
      text: "另一个指标 p95 80ms",
      bucket_id: target.bucket_id,
      confirmation_granted: true,
    });
    assert.ok(confirmed.archive.entry_id);
    ctx.api.revokeEntry(confirmed.archive.entry_id);
    const messages = ctx.api.chatHistory(40).messages;
    for (const message of messages.filter((message) =>
      JSON.stringify(message.details).includes(pending.archive.attempt_id),
    )) {
      const serialized = JSON.stringify(message.details);
      if (serialized.includes('"archive":'))
        assert.match(serialized, /"archive_state":"revoked"/);
    }
    assert.equal(ctx.api.memoryQuery("80ms", 20).results.length, 0);
  } finally {
    ctx.db.close();
  }
});

for (const operation of ["revoke", "delete-bucket"] as const) {
  test(`concurrent ${operation} discards late model/tool output and stale archive metadata`, async () => {
    const ctx = setup({
      respond: async (request) => {
        assert.equal(typeof request.archive["entry_id"], "string");
        if (operation === "revoke")
          ctx.store.deleteEntry(
            String(request.archive["entry_id"]),
            "并发撤销",
          );
        else
          ctx.store.deleteBucket(
            String(request.archive["bucket_id"]),
            "并发删桶",
          );
        return {
          assistantText: "stale secret 620ms",
          toolMessages: [
            {
              name: "search_memory",
              callId: "late",
              arguments: {},
              output: { fact: "stale secret 620ms" },
            },
          ],
        };
      },
    });
    try {
      const response = await ctx.api.chat({ message: "接口 p99 620ms" });
      assert.equal(
        response.assistant_message.content,
        "记忆已更新，请重新提问。",
      );
      assert.deepEqual(response.tool_messages, []);
      assert.equal(
        response.archive.archive_state,
        operation === "revoke" ? "revoked" : "deleted",
      );
      assert.equal(response.archive.extraction, null);
      assert.deepEqual(response.archive.memory_item_ids, []);
      assert.deepEqual(response.archive.available_actions, []);
      assert.doesNotMatch(
        JSON.stringify(ctx.store.listModelChatMessages(40)),
        /stale secret|620ms/,
      );
    } finally {
      ctx.db.close();
    }
  });
}

test("model history after revocation excludes old user, assistant and tool facts while UI history remains", async () => {
  let histories: readonly string[] = [];
  const ctx = setup({
    respond: async ({ history }) => {
      histories = history.map((message) => message.content);
      return { assistantText: "只参考当前有效记忆" };
    },
  });
  try {
    const first = await ctx.api.chat({ message: "旧指标 620ms" });
    assert.ok(first.archive.entry_id && first.archive.bucket_id);
    ctx.api.revokeEntry(first.archive.entry_id);
    ctx.model.bucketId = first.archive.bucket_id;
    await ctx.api.chat({ message: "新指标 100ms" });
    assert.ok(histories.some((text) => text.includes("100ms")));
    assert.ok(histories.every((text) => !text.includes("620ms")));
    assert.ok(
      ctx.api
        .chatHistory(40)
        .messages.some((message) => message.content.includes("620ms")),
    );
  } finally {
    ctx.db.close();
  }
});

for (const stage of ["classification", "extraction"] as const) {
  test(`revocation during ${stage} refuses a write based on stale model context`, async () => {
    const ctx = setup();
    try {
      const first = await ctx.api.archive({ text: "旧事实 620ms" });
      assert.ok(first.entry_id && first.bucket_id);
      const delegate = ctx.model;
      const model: MemoryModel = {
        modelName: "fake-race",
        classify: async () => {
          if (stage === "classification")
            ctx.api.revokeEntry(first.entry_id ?? "");
          return appendExisting(
            first.bucket_id ?? "",
            undefined,
            0.99,
            "旧候选",
          );
        },
        extract: async (text) => {
          if (stage === "extraction") ctx.api.revokeEntry(first.entry_id ?? "");
          return delegate.extract(text);
        },
      };
      await assert.rejects(
        new ArchiveRuntime(ctx.store, model).archiveText("新事实 100ms"),
        /记忆已更新/,
      );
      assert.equal(
        ctx.store.getBucketDetail(first.bucket_id)?.entries.length,
        0,
      );
    } finally {
      ctx.db.close();
    }
  });
}
