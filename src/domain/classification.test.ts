/**
 * Classification safeguards.
 *
 * Every assertion here is ported from
 * `crates/doggie-domain/tests/classification.rs`. They are the behaviour
 * contract carried across the rewrite, not fresh examples — see
 * `docs/INVARIANTS.md` §1–§3.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DomainError } from "./errors.ts";
import {
  BucketStatus,
  BucketType,
  ClassificationAction,
  createBucketView,
} from "./types.ts";
import {
  DEFAULT_CONFIDENCE_POLICY,
  appendExisting,
  applyConfidenceGate,
  applyLowInformationReferenceGate,
  askUser,
  buildBucketCandidates,
  createClassification,
  createConfidencePolicy,
  createNew,
  postprocessClassification,
  validateCandidateReference,
} from "./classification.ts";

const bucket = (id: string, title: string, lastActiveAtUnixMs: number) =>
  createBucketView({
    id,
    title,
    bucketType: BucketType.Incident,
    status: BucketStatus.Active,
    summary: "摘要",
    tags: [" payment ", "payment"],
    lastActiveAtUnixMs,
  });

const kindOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof DomainError,
      `expected DomainError, got ${String(error)}`,
    );
    return error.kind;
  }
  throw new Error("expected a DomainError to be thrown");
};

// ── §1 contract ────────────────────────────────────────────────────────────

test("classification contract rejects inconsistent actions", () => {
  assert.equal(
    kindOf(() =>
      createClassification({
        action: ClassificationAction.AppendExisting,
        confidence: 0.91,
        reason: "缺少目标 bucket。",
      }),
    ),
    "inconsistent_classification",
  );
  assert.equal(
    kindOf(() => createNew(BucketType.Idea, "新想法", 1.2, "新主题。")),
    "confidence_out_of_range",
  );
});

test("classification contract normalizes text and candidate ids", () => {
  const result = askUser(
    undefined,
    undefined,
    0.31,
    "  两个 bucket 都可能匹配。  ",
    "  这条内容属于哪一个？  ",
    [" bucket-1 ", "bucket-1", "", "bucket-2"],
  );

  assert.equal(result.reason, "两个 bucket 都可能匹配。");
  assert.equal(result.question, "这条内容属于哪一个？");
  assert.deepEqual(result.candidateBucketIds, ["bucket-1", "bucket-2"]);
  assert.equal(result.shouldAskUser, true);
});

test("bucket view normalizes fields", () => {
  const view = createBucketView({
    id: " bucket-1 ",
    title: " 支付故障 ",
    bucketType: BucketType.Incident,
    status: BucketStatus.Active,
    summary: " 摘要 ",
    tags: [" payment ", "payment"],
    lastActiveAtUnixMs: 100,
  });

  assert.equal(view.id, "bucket-1");
  assert.equal(view.title, "支付故障");
  assert.equal(view.summary, "摘要");
  assert.deepEqual(view.tags, ["payment"]);
});

// ── §2 candidate construction ──────────────────────────────────────────────

test("candidates preserve service order, ignore focus, and de-duplicate", () => {
  const candidates = buildBucketCandidates(
    [
      bucket("service-first", "服务排序第一旧标题", 100),
      bucket("focus", "手动焦点", 300),
      bucket("popular", "热门事务", 200),
      bucket("service-first", "服务排序第一新标题", 50),
    ],
    "focus",
    2,
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.id),
    ["service-first", "focus"],
  );
  // Last duplicate wins the value, first occurrence keeps the position.
  assert.equal(candidates[0]?.title, "服务排序第一新标题");
});

test("candidate limit must be positive", () => {
  assert.equal(
    kindOf(() => buildBucketCandidates([], undefined, 0)),
    "candidate_limit_too_small",
  );
});

test("generated bucket id outside server candidates requires confirmation", () => {
  const result = appendExisting(
    "invented",
    BucketType.Incident,
    0.99,
    "模型认为是同一故障。",
  );
  const gated = validateCandidateReference(result, [
    bucket("bucket-1", "支付故障", 100),
  ]);

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.equal(gated.bucketId, undefined);
  assert.deepEqual(gated.candidateBucketIds, ["bucket-1"]);
  assert.ok(gated.reason.includes("目标 Bucket ID 不在服务端候选列表中"));
});

test("invalid suggested candidates are filtered", () => {
  const result = askUser(undefined, undefined, 0.4, "需要确认。", "请选择。", [
    "bucket-1",
    "invented",
  ]);
  const gated = validateCandidateReference(result, [
    bucket("bucket-1", "支付故障", 100),
  ]);

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.deepEqual(gated.candidateBucketIds, ["bucket-1"]);
  assert.ok(gated.reason.includes("模型返回了不存在的候选 ID"));
});

test("confirmation candidates prioritize explicit target, then model, then server", () => {
  const result = createClassification({
    action: ClassificationAction.AskUser,
    bucketId: "bucket-2",
    confidence: 0.99,
    reason: "两个事务相似。",
    shouldAskUser: true,
    question: "请选择归档目标。",
    candidateBucketIds: ["bucket-1"],
  });

  const gated = validateCandidateReference(result, [
    bucket("bucket-1", "接口 A 压测", 100),
    bucket("bucket-2", "支付回调故障", 90),
    bucket("bucket-3", "发布清单", 80),
  ]);

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.deepEqual(gated.candidateBucketIds, [
    "bucket-2",
    "bucket-1",
    "bucket-3",
  ]);
});

// ── §1 confidence gate ─────────────────────────────────────────────────────

test("ambiguous result requires confirmation even with high confidence", () => {
  const result = appendExisting(
    "bucket-1",
    BucketType.Incident,
    0.99,
    "两个事务相似。",
    ["bucket-1", "bucket-2"],
  );

  const gated = applyConfidenceGate(result, DEFAULT_CONFIDENCE_POLICY);

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.equal(
    gated.question,
    "多个 Bucket 都可能匹配，请确认本条内容的归属。",
  );
});

test("confidence gate preserves a high-confidence unique result", () => {
  const result = appendExisting(
    "bucket-1",
    BucketType.Incident,
    0.91,
    "同一支付故障。",
  );
  const gated = applyConfidenceGate(result, DEFAULT_CONFIDENCE_POLICY);

  assert.equal(gated.action, ClassificationAction.AppendExisting);
  assert.equal(gated.bucketId, "bucket-1");
});

test("confidence gate uses distinct medium and low confirmation messages", () => {
  const medium = applyConfidenceGate(
    createNew(BucketType.Experiment, "接口压测", 0.7, "新实验。"),
    DEFAULT_CONFIDENCE_POLICY,
  );
  const low = applyConfidenceGate(
    appendExisting("bucket-1", BucketType.Incident, 0.2, "信息不足。"),
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(medium.question, "请确认是否创建这个新 Bucket。");
  assert.equal(
    low.question,
    "当前信息不足以安全归档，请确认目标 Bucket 或新建事务。",
  );
});

test("confidence policy rejects invalid order and non-finite values", () => {
  assert.equal(
    kindOf(() => createConfidencePolicy(0.5, 0.8)),
    "invalid_confidence_thresholds",
  );
  assert.equal(
    kindOf(() => createConfidencePolicy(NaN, 0.5)),
    "invalid_confidence_thresholds",
  );
  assert.equal(createConfidencePolicy(0.9, 0.6).autoArchiveThreshold, 0.9);
});

// ── §1 low-information gate ────────────────────────────────────────────────

test("low-information reference blocks automatic append", () => {
  const gated = applyLowInformationReferenceGate(
    "刚才那个继续处理一下",
    appendExisting("bucket-1", BucketType.Task, 0.95, "指向当前焦点。"),
  );

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.equal(
    gated.question,
    "输入只有模糊指代和低信息动作，请确认要追加到哪个 Bucket。",
  );
});

test("a concrete fact allows a referenced append to continue", () => {
  const gated = applyLowInformationReferenceGate(
    "刚才那个继续处理一下，错误率已经降到 2%",
    appendExisting(
      "bucket-1",
      BucketType.Incident,
      0.95,
      "指向当前焦点并包含状态。",
    ),
  );

  assert.equal(gated.action, ClassificationAction.AppendExisting);
});

test("unicode digits count as concrete facts", () => {
  const gated = applyLowInformationReferenceGate(
    "刚才那个继续处理一下，重试了３次",
    appendExisting(
      "bucket-1",
      BucketType.Incident,
      0.95,
      "指向当前焦点并包含状态。",
    ),
  );

  assert.equal(gated.action, ClassificationAction.AppendExisting);
});

test("high-confidence low-information status inputs require confirmation", () => {
  for (const input of [
    "压测结果更新了",
    "上次评审的事项完成了",
    "Agent 那个任务继续",
    "把校验相关的记一下",
    "切备用后好了",
    "它现在正常了",
  ]) {
    const gated = postprocessClassification(
      input,
      appendExisting(
        "bucket-1",
        BucketType.Experiment,
        0.99,
        "模型认为与现有 Bucket 相关。",
      ),
      [bucket("bucket-1", "接口 A 压测", 100)],
      DEFAULT_CONFIDENCE_POLICY,
    );

    assert.equal(gated.action, ClassificationAction.AskUser, input);
    assert.equal(gated.shouldAskUser, true, input);
    assert.deepEqual(gated.candidateBucketIds, ["bucket-1"], input);
  }
});

// ── §1 whole pipeline ──────────────────────────────────────────────────────

test("empty workspace requires confirmation for a medium-confidence new bucket", () => {
  const gated = postprocessClassification(
    "开始准备 Rust 重构",
    createNew(
      BucketType.Task,
      "准备 Rust 重构",
      0.7,
      "工作区为空且输入是明确的新任务。",
    ),
    [],
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.equal(gated.question, "请确认是否创建这个新 Bucket。");
});

test("empty workspace can bootstrap a high-confidence bucket", () => {
  const gated = postprocessClassification(
    "开始准备 Rust 重构",
    createNew(
      BucketType.Task,
      "准备 Rust 重构",
      0.99,
      "工作区为空且输入是明确的新任务。",
    ),
    [],
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(gated.action, ClassificationAction.CreateNew);
});

test("low-information create_new is confirmed and gets existing candidates", () => {
  const gated = postprocessClassification(
    "压测结果更新了",
    createNew(
      BucketType.Experiment,
      "接口 A 压测",
      0.99,
      "模型建议创建新 Bucket。",
    ),
    [
      bucket("bucket-1", "接口 A 压测", 100),
      bucket("bucket-2", "支付回调故障", 90),
    ],
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.equal(
    gated.question,
    "输入只有模糊指代和低信息动作，请确认是否创建新 Bucket 或选择已有 Bucket。",
  );
  assert.deepEqual(gated.candidateBucketIds, ["bucket-1", "bucket-2"]);
});

test("ask_user without candidates gets the server candidate list", () => {
  const gated = postprocessClassification(
    "这条内容不够明确",
    askUser(undefined, undefined, 0.98, "信息不足。", "请选择归档目标。"),
    [
      bucket("bucket-1", "接口 A 压测", 100),
      bucket("bucket-2", "支付回调故障", 90),
    ],
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(gated.action, ClassificationAction.AskUser);
  assert.deepEqual(gated.candidateBucketIds, ["bucket-1", "bucket-2"]);
});

test("a referenced fact still allows a high-confidence append", () => {
  const gated = postprocessClassification(
    "刚才那个继续处理一下，错误率已经降到 2%",
    appendExisting("bucket-1", BucketType.Incident, 0.99, "输入包含明确指标。"),
    [bucket("bucket-1", "接口 A 压测", 100)],
    DEFAULT_CONFIDENCE_POLICY,
  );

  assert.equal(gated.action, ClassificationAction.AppendExisting);
});

test("postprocess rejects empty input text", () => {
  assert.equal(
    kindOf(() =>
      postprocessClassification(
        "   ",
        appendExisting("bucket-1", BucketType.Task, 0.99, "任意。"),
        [bucket("bucket-1", "接口 A 压测", 100)],
        DEFAULT_CONFIDENCE_POLICY,
      ),
    ),
    "empty_text",
  );
});
