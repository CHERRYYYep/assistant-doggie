import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import {
  evaluateExtractions,
  loadExtractionCases,
  loadExtractionPredictions,
  type ExtractionCase,
  type ExtractionPrediction,
} from "./extraction.ts";

const FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/extraction_cases.json", import.meta.url),
);

function writeJson(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "doggie-extraction-eval-"));
  const path = join(directory, "fixture.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function paymentCase(): ExtractionCase {
  return {
    id: "payment",
    input: "支付回调 10:20 开始失败，第三方返回 502，待补复盘。",
    bucketType: BucketType.Incident,
    expectedSummaryTerms: ["支付回调", "502"],
    expectedTodoTerms: ["复盘"],
    expectedEvidenceTerms: ["502"],
    expectedTimelineTerms: ["10:20"],
    expectedDecisionTerms: [],
    forbiddenTerms: ["退款", "503"],
  };
}

test("human-labelled extraction fixture covers core fields", () => {
  const cases = loadExtractionCases(FIXTURE);

  assert.ok(cases.length >= 3);
  assert.deepEqual(
    new Set(cases.map((item) => item.bucketType)),
    new Set([BucketType.Incident, BucketType.Experiment, BucketType.Meeting]),
  );
  assert.ok(cases.some((item) => item.expectedTodoTerms.length > 0));
  assert.ok(cases.some((item) => item.expectedEvidenceTerms.length > 0));
  assert.ok(cases.some((item) => item.expectedTimelineTerms.length > 0));
  assert.ok(cases.some((item) => item.expectedDecisionTerms.length > 0));
  assert.ok(cases.every((item) => item.forbiddenTerms.length > 0));
});

test("faithful extraction has full recall and no risk flags", () => {
  const evaluationCase = paymentCase();
  const prediction: ExtractionPrediction = {
    id: evaluationCase.id,
    result: createExtraction({
      summary: "支付回调从 10:20 起失败，第三方返回 502。",
      todos: ["补充故障复盘"],
      evidences: ["第三方返回 502"],
      timelineEvents: [{ occurredAt: "10:20", text: "支付回调开始失败" }],
    }),
  };

  const metrics = evaluateExtractions([evaluationCase], [prediction]);

  assert.equal(metrics.summaryTermRecall, 1);
  assert.equal(metrics.todoTermRecall, 1);
  assert.equal(metrics.evidenceTermRecall, 1);
  assert.equal(metrics.timelineTermRecall, 1);
  assert.equal(metrics.decisionTermRecall, 1);
  assert.equal(metrics.forbiddenTermViolationCount, 0);
  assert.equal(metrics.novelNumericClaimCount, 0);
});

test("extraction evaluation flags omissions forbidden terms and new numbers", () => {
  const evaluationCase = paymentCase();
  const prediction: ExtractionPrediction = {
    id: evaluationCase.id,
    result: createExtraction({
      summary: "支付回调失败，随后执行退款，错误码为 503。",
    }),
  };

  const metrics = evaluateExtractions([evaluationCase], [prediction]);
  const check = metrics.caseChecks[0];
  assert.ok(check !== undefined);

  assert.deepEqual(check.missingSummaryTerms, ["502"]);
  assert.deepEqual(check.missingTodoTerms, ["复盘"]);
  assert.deepEqual(check.missingEvidenceTerms, ["502"]);
  assert.deepEqual(check.missingTimelineTerms, ["10:20"]);
  assert.deepEqual(check.forbiddenTermMatches, ["退款", "503"]);
  assert.deepEqual(check.novelNumericClaims, ["503"]);
  assert.equal(metrics.forbiddenTermViolationCount, 2);
  assert.equal(metrics.novelNumericClaimCount, 1);
});

test("numeric risk treats source percentage and plain number as equivalent", () => {
  const evaluationCase: ExtractionCase = {
    id: "cpu",
    input: "CPU 85%。",
    bucketType: BucketType.Experiment,
    expectedSummaryTerms: [],
    expectedTodoTerms: [],
    expectedEvidenceTerms: [],
    expectedTimelineTerms: [],
    expectedDecisionTerms: [],
    forbiddenTerms: [],
  };
  const prediction: ExtractionPrediction = {
    id: "cpu",
    result: createExtraction({ summary: "CPU 为 85。" }),
  };

  assert.equal(
    evaluateExtractions([evaluationCase], [prediction]).novelNumericClaimCount,
    0,
  );
});

test("extraction prediction loader accepts versioned reports", () => {
  const path = writeJson({
    model_name: "test-model",
    prompt_version: "extraction-v1",
    predictions: [
      {
        id: "payment",
        result: {
          summary: "支付回调返回 502",
          todos: [],
          evidences: [],
          timeline_events: [],
          decisions: [],
          hypotheses: [],
          entities: [],
          tags: [],
        },
      },
    ],
  });

  const [prediction] = loadExtractionPredictions(path);
  assert.ok(prediction !== undefined);
  assert.equal(prediction.id, "payment");
  assert.equal(prediction.result.summary, "支付回调返回 502");
});

test("extraction evaluation rejects prediction id mismatch", () => {
  assert.throws(
    () =>
      evaluateExtractions(
        [paymentCase()],
        [{ id: "other", result: createExtraction({ summary: "无关结果" }) }],
      ),
    /prediction ids mismatch/,
  );
});
