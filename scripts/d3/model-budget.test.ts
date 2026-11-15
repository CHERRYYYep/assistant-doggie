import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelBudget,
  ModelBudgetError,
  boundedModelFetch,
} from "./model-budget.ts";
import type { StructuredOutputTransport } from "../../src/llm/transport.ts";
import { L1_CASES } from "./l1-fixtures.ts";
import { evaluateL1, type L1Record, recordSchema } from "./l1-protocol.ts";
const url = "https://example.invalid/v1/responses";
const request = {
  url,
  body: {
    model: "d3-fake",
    input: "synthetic",
    max_output_tokens: 999999,
    store: true,
  },
};
const success = { body: { usage: { input_tokens: 12, output_tokens: 8 } } };
test("model budget counts before forwarding, clamps generation, and stops at cap", async () => {
  let calls = 0;
  const inner: StructuredOutputTransport = {
    send: async (r) => {
      calls++;
      assert.deepEqual(r.body, {
        model: "d3-fake",
        input: "synthetic",
        max_output_tokens: 4096,
        store: false,
      });
      return success;
    },
  };
  const budget = new ModelBudget(inner, url, "d3-fake", 2);
  budget.setLabel("tencent-l1-case-01-0");
  await budget.send(request);
  await budget.send(request);
  await assert.rejects(() => budget.send(request), ModelBudgetError);
  assert.equal(calls, 2);
  assert.equal(budget.calls.length, 2);
  assert.deepEqual(
    budget.calls.map((c) => [
      c.ordinal,
      c.inputTokens,
      c.outputTokens,
      c.outcome,
    ]),
    [
      [1, 12, 8, "ok"],
      [2, 12, 8, "ok"],
    ],
  );
  assert.equal(JSON.stringify(budget.calls).includes("synthetic"), false);
});
test("failed or concurrent requests cannot be silently retried or exceed the budget", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const inner: StructuredOutputTransport = {
    send: async () => {
      calls++;
      await new Promise<void>((done) => {
        release = done;
      });
      throw new Error("SECRET_TEST_DO_NOT_EXPOSE");
    },
  };
  const budget = new ModelBudget(inner, url, "d3-fake", 50);
  budget.setLabel("tencent-l1-case-01-0");
  const running = budget.send(request);
  await assert.rejects(() => budget.send(request), ModelBudgetError);
  release();
  await assert.rejects(
    () => running,
    (error: unknown) =>
      error instanceof ModelBudgetError &&
      !error.message.includes("SECRET_TEST"),
  );
  await assert.rejects(() => budget.send(request), ModelBudgetError);
  assert.equal(calls, 1);
  assert.equal(budget.calls[0]?.outcome, "transport_error");
});
test("request scope, model, streaming and oversize input are rejected without a call", async () => {
  let calls = 0;
  const inner: StructuredOutputTransport = {
    send: async () => {
      calls++;
      return success;
    },
  };
  const budget = new ModelBudget(inner, url, "d3-fake", 50);
  budget.setLabel("doggie-l1-case-02-0");
  for (const r of [
    { ...request, url: "https://other.invalid" },
    { ...request, body: { model: "other" } },
    { ...request, body: { model: "d3-fake", stream: true } },
    { ...request, body: { model: "d3-fake", input: "x".repeat(131073) } },
  ])
    await assert.rejects(() => budget.send(r), ModelBudgetError);
  assert.equal(calls, 0);
  assert.equal(budget.calls.length, 0);
  assert.throws(
    () => new ModelBudget(inner, url, "d3-fake", 51),
    ModelBudgetError,
  );
});
test("bounded fetch refuses redirects, bounds bytes, and cancels overflowing streams", async () => {
  let cancelled = false;
  let redirect: RequestRedirect | undefined;
  const fake: typeof fetch = async (_input, init) => {
    redirect = init?.redirect;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1048577));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  await assert.rejects(() => boundedModelFetch(fake)(url), ModelBudgetError);
  assert.equal(redirect, "error");
  assert.equal(cancelled, true);
});
test("L1 fixtures freeze 30 sources and prevent nonaccepted inputs from becoming evidence", () => {
  assert.equal(L1_CASES.length, 10);
  const all = L1_CASES.flatMap((c) => c.sources);
  assert.equal(all.length, 30);
  assert.equal(new Set(all.map((s) => s.id)).size, 30);
  assert.equal(all.filter((s) => s.state === "active").length, 26);
  for (const item of L1_CASES)
    for (const check of item.checks) {
      assert.ok(check.sourceIds.length > 0);
      assert.ok(
        check.sourceIds.every((id) =>
          item.sources.some((s) => s.id === id && s.state === "active"),
        ),
      );
    }
  const item = L1_CASES[7];
  assert.ok(item);
  const id = item.sources[0]?.id;
  assert.ok(id);
  const r: L1Record = {
    id: "synthetic-record",
    content: "合成项目棠梨当前使用构建812",
    type: "episodic",
    source_message_ids: [id],
    sessionId: "l1-case-08-0",
    teamId: "d3-l1-team",
    userId: "d3-l1-user",
    agentId: "d3-l1-agent",
  };
  const good = evaluateL1(item, [r], r.sessionId);
  assert.equal(good.sourceChecksPassed, 1);
  for (const bad of [
    { ...r, source_message_ids: ["invented"] },
    { ...r, source_message_ids: [] },
    { ...r, source_message_ids: [id, id] },
    { ...r, source_message_ids: ["synthetic-l1-source-23"] },
    { ...r, userId: "other" },
  ]) {
    const result = evaluateL1(item, [bad], r.sessionId);
    assert.equal(result.rejectedRecordCount, 1);
    assert.equal(result.sourceChecksPassed, 0);
  }
  assert.equal(
    recordSchema.safeParse({ ...r, content: "x".repeat(8193) }).success,
    false,
  );
});
