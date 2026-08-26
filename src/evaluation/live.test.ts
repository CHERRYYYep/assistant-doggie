import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { appendExisting, createNew } from "../domain/classification.ts";
import { createExtraction } from "../domain/memory.ts";
import { BucketType } from "../domain/types.ts";
import { LlmApiMode } from "../llm/config.ts";
import { loadClassificationCases } from "./classification.ts";
import { loadExtractionCases } from "./extraction.ts";
import {
  runLiveClassification,
  runLiveExtraction,
  writeLiveClassificationReport,
  writeLiveExtractionReport,
} from "./live.ts";

const CLASSIFICATION_FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/classification_cases.json", import.meta.url),
);
const EXTRACTION_FIXTURE = fileURLToPath(
  new URL("../../tests/fixtures/extraction_cases.json", import.meta.url),
);
const METADATA = {
  modelName: "test-model",
  apiSite: "test-site",
  apiBaseUrl: "https://example.test/v1",
  apiMode: LlmApiMode.Responses,
  generatedAt: "2026-08-24T00:00:00.000Z",
};

test("live classification retains metadata, metrics, and reloadable predictions", async () => {
  const [evaluationCase] = loadClassificationCases(CLASSIFICATION_FIXTURE);
  assert.ok(evaluationCase !== undefined);
  let observedFocus: string | undefined;
  const report = await runLiveClassification([evaluationCase], {
    metadata: METADATA,
    classifier: async (text, candidates, focus) => {
      assert.equal(text, evaluationCase.input);
      assert.equal(candidates.length, evaluationCase.buckets.length);
      observedFocus = focus;
      return appendExisting(
        evaluationCase.expectedBucketId!,
        BucketType.Incident,
        0.91,
        "匹配",
      );
    },
  });

  assert.equal(observedFocus, evaluationCase.currentFocusBucketId);
  assert.equal(report.generatedAt, METADATA.generatedAt);
  assert.equal(report.caseCount, 1);
  assert.equal(report.metrics.total, 1);
  assert.equal(
    report.predictions[0]?.bucketId,
    evaluationCase.expectedBucketId,
  );

  const output = join(
    mkdtempSync(join(tmpdir(), "doggie-live-report-")),
    "classification.json",
  );
  writeLiveClassificationReport(report, output);
  const written = JSON.parse(readFileSync(output, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(written["model_name"], "test-model");
  assert.equal(written["prompt_version"], "doggie-engine-v1");
  assert.ok(Array.isArray(written["predictions"]));
});

test("live extraction retains reference date and serializes wire-compatible output", async () => {
  const [evaluationCase] = loadExtractionCases(EXTRACTION_FIXTURE);
  assert.ok(evaluationCase !== undefined);
  const report = await runLiveExtraction([evaluationCase], {
    metadata: METADATA,
    referenceDate: "2026-08-24",
    extractor: async (text, bucketType, referenceDate) => {
      assert.equal(text, evaluationCase.input);
      assert.equal(bucketType, evaluationCase.bucketType);
      assert.equal(referenceDate, "2026-08-24");
      return createExtraction({ summary: "支付回调 502", evidences: ["502"] });
    },
  });

  assert.equal(report.referenceDate, "2026-08-24");
  assert.equal(report.metrics.total, 1);
  const output = join(
    mkdtempSync(join(tmpdir(), "doggie-live-report-")),
    "extraction.json",
  );
  writeLiveExtractionReport(report, output);
  const written = JSON.parse(readFileSync(output, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(written["reference_date"], "2026-08-24");
  const predictions = written["predictions"] as Array<Record<string, unknown>>;
  const result = predictions[0]?.["result"] as Record<string, unknown>;
  assert.deepEqual(result["timeline_events"], []);
});

test("live runners reject empty case selections", async () => {
  await assert.rejects(
    runLiveClassification([], {
      metadata: METADATA,
      classifier: () => createNew(BucketType.Task, "x", 1, "x"),
    }),
    /at least one classification case/,
  );
  await assert.rejects(
    runLiveExtraction([], {
      metadata: METADATA,
      extractor: () => createExtraction({ summary: "x" }),
    }),
    /at least one extraction case/,
  );
});
