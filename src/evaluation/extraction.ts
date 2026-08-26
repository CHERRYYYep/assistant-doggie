/**
 * Deterministic extraction-fidelity evaluation harness.
 *
 * The evaluator checks recall of human-labelled facts and high-risk signals
 * (forbidden terms and source-absent numbers). It intentionally does not
 * collapse semantic faithfulness into one score: saved structured output still
 * requires human review.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";

import { createExtraction, type ExtractionResult } from "../domain/memory.ts";
import { BUCKET_TYPES, type BucketType } from "../domain/types.ts";

const numberPattern = /\d+(?:\.\d+)?%?/gu;

const extractionCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    input: z.string().trim().min(1),
    bucket_type: z.enum(BUCKET_TYPES),
    expected_summary_terms: z.array(z.string()).default([]),
    expected_todo_terms: z.array(z.string()).default([]),
    expected_evidence_terms: z.array(z.string()).default([]),
    expected_timeline_terms: z.array(z.string()).default([]),
    expected_decision_terms: z.array(z.string()).default([]),
    forbidden_terms: z.array(z.string()).default([]),
  })
  .strict();

const timelineEventSchema = z
  .object({
    event_time: z.string().nullable().default(null),
    text: z.string(),
  })
  .strict();

const extractionResultSchema = z
  .object({
    summary: z.string(),
    todos: z.array(z.string()).default([]),
    evidences: z.array(z.string()).default([]),
    timeline_events: z.array(timelineEventSchema).default([]),
    decisions: z.array(z.string()).default([]),
    hypotheses: z.array(z.string()).default([]),
    entities: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
  })
  .strict();

const extractionPredictionSchema = z
  .object({
    id: z.string().trim().min(1),
    result: extractionResultSchema,
  })
  .strict();

export type ExtractionCase = {
  readonly id: string;
  readonly input: string;
  readonly bucketType: BucketType;
  readonly expectedSummaryTerms: readonly string[];
  readonly expectedTodoTerms: readonly string[];
  readonly expectedEvidenceTerms: readonly string[];
  readonly expectedTimelineTerms: readonly string[];
  readonly expectedDecisionTerms: readonly string[];
  readonly forbiddenTerms: readonly string[];
};

export type ExtractionPrediction = {
  readonly id: string;
  readonly result: ExtractionResult;
};

export type ExtractionCaseCheck = {
  readonly id: string;
  readonly missingSummaryTerms: readonly string[];
  readonly missingTodoTerms: readonly string[];
  readonly missingEvidenceTerms: readonly string[];
  readonly missingTimelineTerms: readonly string[];
  readonly missingDecisionTerms: readonly string[];
  readonly forbiddenTermMatches: readonly string[];
  readonly novelNumericClaims: readonly string[];
};

export type ExtractionMetrics = {
  readonly total: number;
  readonly summaryTermRecall: number;
  readonly todoTermRecall: number;
  readonly evidenceTermRecall: number;
  readonly timelineTermRecall: number;
  readonly decisionTermRecall: number;
  readonly forbiddenTermViolationCount: number;
  readonly novelNumericClaimCount: number;
  readonly caseChecks: readonly ExtractionCaseCheck[];
};

export function loadExtractionCases(path: string): ExtractionCase[] {
  const parsed = parseJsonFile(path, "extraction fixture");
  if (!Array.isArray(parsed)) {
    throw new TypeError("extraction fixture must be a JSON array");
  }
  const cases = parsed.map((value) => toExtractionCase(value));
  requireUniqueIds(cases, "extraction case");
  return cases;
}

export function loadExtractionPredictions(
  path: string,
): ExtractionPrediction[] {
  const parsed = parseJsonFile(path, "prediction file");
  const values = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed["predictions"]
      : undefined;
  if (!Array.isArray(values)) {
    throw new TypeError(
      "prediction file must be a JSON array or contain a predictions array",
    );
  }
  return values.map((value) => toExtractionPrediction(value));
}

export function evaluateExtractions(
  cases: readonly ExtractionCase[],
  predictions: readonly ExtractionPrediction[],
): ExtractionMetrics {
  if (cases.length === 0) {
    throw new RangeError("at least one extraction case is required");
  }
  const predictionsById = new Map<string, ExtractionPrediction>();
  for (const prediction of predictions) {
    if (predictionsById.has(prediction.id)) {
      throw new RangeError("prediction ids must be unique");
    }
    predictionsById.set(prediction.id, prediction);
  }
  const expectedIds = new Set(cases.map((item) => item.id));
  if (
    predictionsById.size !== expectedIds.size ||
    [...predictionsById.keys()].some((id) => !expectedIds.has(id))
  ) {
    throw new RangeError("prediction ids mismatch extraction case ids");
  }

  const fieldTotals = {
    summary: 0,
    todo: 0,
    evidence: 0,
    timeline: 0,
    decision: 0,
  };
  const fieldMissing = {
    summary: 0,
    todo: 0,
    evidence: 0,
    timeline: 0,
    decision: 0,
  };
  const caseChecks: ExtractionCaseCheck[] = [];

  for (const evaluationCase of cases) {
    const prediction = predictionsById.get(evaluationCase.id);
    if (prediction === undefined)
      throw new Error("prediction lookup invariant");
    const result = prediction.result;
    const timelineValues = result.timelineEvents.map((event) =>
      [event.occurredAt, event.text]
        .filter((part) => part !== undefined)
        .join(" "),
    );
    const missingSummaryTerms = missingTerms(
      evaluationCase.expectedSummaryTerms,
      [result.summary],
    );
    const missingTodoTerms = missingTerms(
      evaluationCase.expectedTodoTerms,
      result.todos,
    );
    const missingEvidenceTerms = missingTerms(
      evaluationCase.expectedEvidenceTerms,
      result.evidences,
    );
    const missingTimelineTerms = missingTerms(
      evaluationCase.expectedTimelineTerms,
      timelineValues,
    );
    const missingDecisionTerms = missingTerms(
      evaluationCase.expectedDecisionTerms,
      result.decisions,
    );
    const expectedByField = [
      ["summary", evaluationCase.expectedSummaryTerms, missingSummaryTerms],
      ["todo", evaluationCase.expectedTodoTerms, missingTodoTerms],
      ["evidence", evaluationCase.expectedEvidenceTerms, missingEvidenceTerms],
      ["timeline", evaluationCase.expectedTimelineTerms, missingTimelineTerms],
      ["decision", evaluationCase.expectedDecisionTerms, missingDecisionTerms],
    ] as const;
    for (const [field, expected, missing] of expectedByField) {
      fieldTotals[field] += expected.length;
      fieldMissing[field] += missing.length;
    }

    const outputText = resultText(result).join("\n");
    const normalizedOutput = normalize(outputText);
    const forbiddenTermMatches = evaluationCase.forbiddenTerms.filter(
      (term) =>
        normalize(term) !== "" && normalizedOutput.includes(normalize(term)),
    );
    const novelNumericClaims = [...numericClaims(outputText)]
      .filter((claim) => !numericClaims(evaluationCase.input).has(claim))
      .sort();

    caseChecks.push({
      id: evaluationCase.id,
      missingSummaryTerms,
      missingTodoTerms,
      missingEvidenceTerms,
      missingTimelineTerms,
      missingDecisionTerms,
      forbiddenTermMatches,
      novelNumericClaims,
    });
  }

  return {
    total: cases.length,
    summaryTermRecall: recall(fieldTotals.summary, fieldMissing.summary),
    todoTermRecall: recall(fieldTotals.todo, fieldMissing.todo),
    evidenceTermRecall: recall(fieldTotals.evidence, fieldMissing.evidence),
    timelineTermRecall: recall(fieldTotals.timeline, fieldMissing.timeline),
    decisionTermRecall: recall(fieldTotals.decision, fieldMissing.decision),
    forbiddenTermViolationCount: caseChecks.reduce(
      (total, check) => total + check.forbiddenTermMatches.length,
      0,
    ),
    novelNumericClaimCount: caseChecks.reduce(
      (total, check) => total + check.novelNumericClaims.length,
      0,
    ),
    caseChecks,
  };
}

function toExtractionCase(value: unknown): ExtractionCase {
  const parsed = extractionCaseSchema.parse(value);
  return {
    id: parsed.id,
    input: parsed.input,
    bucketType: parsed.bucket_type,
    expectedSummaryTerms: parsed.expected_summary_terms,
    expectedTodoTerms: parsed.expected_todo_terms,
    expectedEvidenceTerms: parsed.expected_evidence_terms,
    expectedTimelineTerms: parsed.expected_timeline_terms,
    expectedDecisionTerms: parsed.expected_decision_terms,
    forbiddenTerms: parsed.forbidden_terms,
  };
}

function toExtractionPrediction(value: unknown): ExtractionPrediction {
  const parsed = extractionPredictionSchema.parse(value);
  return {
    id: parsed.id,
    result: createExtraction({
      summary: parsed.result.summary,
      todos: parsed.result.todos,
      evidences: parsed.result.evidences,
      timelineEvents: parsed.result.timeline_events.map((event) => ({
        text: event.text,
        occurredAt: event.event_time ?? undefined,
      })),
      decisions: parsed.result.decisions,
      hypotheses: parsed.result.hypotheses,
      entities: parsed.result.entities,
      tags: parsed.result.tags,
    }),
  };
}

function resultText(result: ExtractionResult): string[] {
  return [
    result.summary,
    ...result.todos,
    ...result.evidences,
    ...result.timelineEvents.map((event) =>
      [event.occurredAt, event.text]
        .filter((part) => part !== undefined)
        .join(" "),
    ),
    ...result.decisions,
    ...result.hypotheses,
    ...result.entities,
    ...result.tags,
  ];
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, "");
}

function missingTerms(
  expected: readonly string[],
  values: readonly string[],
): string[] {
  const haystack = normalize(values.join("\n"));
  return expected.filter((term) => !haystack.includes(normalize(term)));
}

function numericClaims(value: string): Set<string> {
  return new Set(
    [...value.matchAll(numberPattern)].map((match) =>
      (match[0] ?? "").replace(/%$/u, ""),
    ),
  );
}

function recall(totalTerms: number, missing: number): number {
  return totalTerms === 0 ? 1 : (totalTerms - missing) / totalTerms;
}

function parseJsonFile(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`could not read ${label}: ${detail}`);
  }
}

function requireUniqueIds(
  values: readonly { readonly id: string }[],
  label: string,
): void {
  const ids = new Set(values.map((value) => value.id));
  if (ids.size !== values.length)
    throw new RangeError(`${label} ids must be unique`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
