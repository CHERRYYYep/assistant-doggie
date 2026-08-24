import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ClassificationAction } from "../domain/types.ts";
import {
  evaluateClassification,
  keywordBaselinePredictions,
  loadClassificationCases,
  loadClassificationPredictions,
  type ClassificationCase,
  type ClassificationPrediction,
} from "./classification.ts";

const FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/classification_cases.json", import.meta.url),
);

function writeJson(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "doggie-classification-eval-"));
  const path = join(directory, "fixture.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function caseFor(
  value: Partial<ClassificationCase> & Pick<ClassificationCase, "id">,
): ClassificationCase {
  return {
    id: value.id,
    input: value.input ?? "继续支付故障",
    currentFocusBucketId: value.currentFocusBucketId ?? "payment",
    buckets: value.buckets ?? [
      {
        id: "payment",
        title: "支付故障",
        type: "incident",
        status: "active",
        summary: "",
      },
      {
        id: "api",
        title: "接口治理",
        type: "task",
        status: "active",
        summary: "",
      },
    ],
    expectedAction: value.expectedAction ?? ClassificationAction.AppendExisting,
    expectedBucketId: value.expectedBucketId ?? "payment",
    shouldAskUser: value.shouldAskUser ?? false,
    errorCost: value.errorCost ?? "high",
  };
}

test("human-labelled classification fixture retains required coverage", () => {
  const cases = loadClassificationCases(FIXTURE);

  assert.ok(cases.length >= 50);
  assert.deepEqual(
    new Set(cases.map((item) => item.expectedAction)),
    new Set(Object.values(ClassificationAction)),
  );
  assert.ok(cases.some((item) => item.errorCost === "high"));
  assert.ok(
    cases.some((item) => item.shouldAskUser && item.buckets.length > 1),
  );
});

test("classification metrics cover safety and confidence bands", () => {
  const cases = [
    caseFor({ id: "append" }),
    caseFor({
      id: "ambiguous",
      input: "继续那个问题",
      currentFocusBucketId: undefined,
      expectedAction: ClassificationAction.AskUser,
      expectedBucketId: undefined,
      shouldAskUser: true,
    }),
    caseFor({
      id: "create",
      input: "新建压测",
      currentFocusBucketId: undefined,
      buckets: [],
      expectedAction: ClassificationAction.CreateNew,
      expectedBucketId: undefined,
      errorCost: "medium",
    }),
  ];
  const predictions: ClassificationPrediction[] = [
    {
      id: "append",
      action: ClassificationAction.AppendExisting,
      bucketId: "api",
      confidence: 0.92,
      shouldAskUser: false,
    },
    {
      id: "ambiguous",
      action: ClassificationAction.AskUser,
      bucketId: undefined,
      confidence: 0.42,
      shouldAskUser: true,
    },
    {
      id: "create",
      action: ClassificationAction.CreateNew,
      bucketId: undefined,
      confidence: 0.7,
      shouldAskUser: false,
    },
  ];

  const metrics = evaluateClassification(cases, predictions);

  assert.equal(metrics.actionAccuracy, 1);
  assert.equal(metrics.existingBucketAccuracy, 0);
  assert.equal(metrics.autoArchiveAccuracy, 0.5);
  assert.equal(metrics.askUserRecall, 1);
  assert.equal(metrics.severeMismergeCount, 1);
  assert.equal(metrics.confidenceBands.high.accuracy, 0);
  assert.equal(metrics.confidenceBands.low.askUserRate, 1);
});

test("classification evaluation rejects missing predictions", () => {
  assert.throws(
    () => evaluateClassification([caseFor({ id: "only" })], []),
    /prediction ids mismatch/,
  );
});

test("keyword baseline does not read expected labels", () => {
  const [first] = loadClassificationCases(FIXTURE);
  assert.ok(first !== undefined);
  const original = keywordBaselinePredictions([first]);
  const changed = keywordBaselinePredictions([
    {
      ...first,
      expectedAction: ClassificationAction.AskUser,
      shouldAskUser: true,
    },
  ]);

  assert.equal(changed[0]?.action, original[0]?.action);
  assert.equal(changed[0]?.bucketId, original[0]?.bucketId);
});

test("classification prediction loader accepts versioned reports", () => {
  const path = writeJson({
    model_name: "test-model",
    prompt_version: "classification-v1",
    predictions: [
      {
        id: "case-1",
        action: "ask_user",
        confidence: 0.4,
        should_ask_user: true,
      },
    ],
  });

  assert.deepEqual(loadClassificationPredictions(path), [
    {
      id: "case-1",
      action: ClassificationAction.AskUser,
      bucketId: undefined,
      confidence: 0.4,
      shouldAskUser: true,
    },
  ]);
});
