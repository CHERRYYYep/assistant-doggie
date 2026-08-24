import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError } from "../domain/errors.ts";
import {
  bucketSummaryContract,
  classificationContract,
  classificationJsonSchema,
  extractionContract,
  extractionJsonSchema,
} from "./contracts.ts";

function assertRejects(
  value: unknown,
  parse: (value: unknown) => unknown,
): void {
  assert.throws(() => parse(value));
}

test("structured schemas forbid unknown object fields", () => {
  assert.equal(classificationJsonSchema["additionalProperties"], false);
  assert.equal(extractionJsonSchema["additionalProperties"], false);

  const definitions = extractionJsonSchema["$defs"] as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(
    definitions["TimelineEventExtract"]?.["additionalProperties"],
    false,
  );

  const properties = classificationJsonSchema["properties"] as Record<
    string,
    Record<string, unknown>
  >;
  assert.deepEqual(properties["action"]?.["enum"], [
    "append_existing",
    "create_new",
    "ask_user",
  ]);

  assertRejects(
    {
      action: "create_new",
      bucket_type: "idea",
      title: "新想法",
      confidence: 0.8,
      reason: "新主题。",
      unknown_field: true,
    },
    classificationContract.parse,
  );
  assertRejects(
    {
      summary: "有效摘要",
      timeline_events: [{ event_time: null, text: "事件", unknown: true }],
    },
    extractionContract.parse,
  );
  assertRejects(
    { summary: "有效摘要", unknown: true },
    bucketSummaryContract.parse,
  );
});

test("classification contract rejects invalid confidence and inconsistent actions", () => {
  assert.throws(
    () =>
      classificationContract.parse({
        action: "create_new",
        bucket_type: "idea",
        title: "新想法",
        confidence: 1.2,
        reason: "新主题。",
      }),
    (error: unknown) =>
      error instanceof DomainError && error.kind === "confidence_out_of_range",
  );

  assert.throws(
    () =>
      classificationContract.parse({
        action: "append_existing",
        confidence: 0.91,
        reason: "缺少目标 Bucket。",
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.kind === "inconsistent_classification",
  );

  const parsed = classificationContract.parse({
    action: "ask_user",
    bucket_id: null,
    bucket_type: null,
    title: null,
    confidence: 0.31,
    reason: " 两个 Bucket 都可能匹配。 ",
    should_ask_user: true,
    question: " 这条内容属于哪一个？ ",
    candidate_bucket_ids: [" bucket-1 ", "bucket-1", "bucket-2"],
  });
  assert.deepEqual(parsed.candidateBucketIds, ["bucket-1", "bucket-2"]);
  assert.equal(parsed.reason, "两个 Bucket 都可能匹配。");
});

test("extraction defaults are independent and normalize nested timeline values", () => {
  const first = extractionContract.parse({ summary: " 第一条输入 " });
  const second = extractionContract.parse({ summary: "第二条输入" });

  assert.notEqual(first.todos, second.todos);
  assert.deepEqual(first.todos, []);
  assert.deepEqual(second.todos, []);

  const parsed = extractionContract.parse({
    summary: " 支付回调失败，第三方返回 502。 ",
    todos: [" 补充复盘 ", "补充复盘", ""],
    timeline_events: [
      { event_time: " 10:20 ", text: " 开始大量失败 " },
      { event_time: "", text: "切换备用通道后恢复" },
    ],
    tags: [" payment ", "payment", "502"],
  });

  assert.equal(parsed.summary, "支付回调失败，第三方返回 502。");
  assert.deepEqual(parsed.todos, ["补充复盘"]);
  assert.deepEqual(parsed.tags, ["payment", "502"]);
  assert.deepEqual(parsed.timelineEvents, [
    { occurredAt: "10:20", text: "开始大量失败" },
    { occurredAt: undefined, text: "切换备用通道后恢复" },
  ]);
});

test("extraction requires summary and valid timeline text", () => {
  assert.throws(
    () => extractionContract.parse({ summary: "   " }),
    (error: unknown) =>
      error instanceof DomainError && error.kind === "empty_text",
  );
  assert.throws(
    () =>
      extractionContract.parse({
        summary: "存在时间线",
        timeline_events: [{ event_time: "下午", text: "" }],
      }),
    (error: unknown) =>
      error instanceof DomainError && error.kind === "empty_text",
  );
  assert.equal(
    bucketSummaryContract.parse({ summary: "  滚动摘要  " }).summary,
    "滚动摘要",
  );
});
