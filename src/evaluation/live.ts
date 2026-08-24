/** Reproducible report builders for optional real-model evaluation runs. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createBucketView, type BucketView } from "../domain/types.ts";
import type { ClassificationResult } from "../domain/classification.ts";
import type { ExtractionResult } from "../domain/memory.ts";
import {
  LlmApiMode,
  type LlmApiMode as LlmApiModeValue,
} from "../llm/config.ts";
import {
  evaluateClassification,
  type ClassificationCase,
  type ClassificationMetrics,
  type ClassificationPrediction,
} from "./classification.ts";
import {
  evaluateExtractions,
  type ExtractionCase,
  type ExtractionMetrics,
  type ExtractionPrediction,
} from "./extraction.ts";

export const EVALUATION_PROMPT_VERSION = "doggie-engine-v1";

export type LiveEvaluationMetadata = {
  readonly modelName: string;
  readonly apiSite: string;
  readonly apiBaseUrl: string;
  readonly apiMode: LlmApiModeValue;
  readonly promptVersion?: string;
  readonly generatedAt?: string;
};

type ReportMetadata = {
  readonly generatedAt: string;
  readonly modelName: string;
  readonly apiSite: string;
  readonly apiBaseUrl: string;
  readonly apiMode: LlmApiModeValue;
  readonly promptVersion: string;
};

export type LiveClassificationReport = ReportMetadata & {
  readonly casesPath: string;
  readonly caseCount: number;
  readonly predictions: readonly ClassificationPrediction[];
  readonly metrics: ClassificationMetrics;
};

export type LiveExtractionReport = ReportMetadata & {
  readonly referenceDate: string;
  readonly casesPath: string;
  readonly caseCount: number;
  readonly predictions: readonly ExtractionPrediction[];
  readonly metrics: ExtractionMetrics;
};

export type LiveClassifier = (
  text: string,
  candidates: readonly BucketView[],
  currentFocusBucketId?: string,
) => ClassificationResult | Promise<ClassificationResult>;

export type LiveExtractor = (
  text: string,
  bucketType: ExtractionCase["bucketType"],
  referenceDate: string,
) => ExtractionResult | Promise<ExtractionResult>;

export async function runLiveClassification(
  cases: readonly ClassificationCase[],
  options: {
    readonly classifier: LiveClassifier;
    readonly metadata: LiveEvaluationMetadata;
    readonly casesPath?: string;
  },
): Promise<LiveClassificationReport> {
  if (cases.length === 0) {
    throw new RangeError("at least one classification case is required");
  }
  const metadata = reportMetadata(options.metadata);
  const casesPath =
    options.casesPath ?? "tests/fixtures/classification_cases.json";
  const predictions: ClassificationPrediction[] = [];
  for (const [index, evaluationCase] of cases.entries()) {
    const candidates = evaluationCase.buckets.map((bucket) =>
      createBucketView({
        id: bucket.id,
        title: bucket.title,
        bucketType: bucket.type,
        status: bucket.status,
        summary: bucket.summary,
        lastActiveAtUnixMs: Date.parse(metadata.generatedAt),
      }),
    );
    const result = await options.classifier(
      evaluationCase.input,
      candidates,
      evaluationCase.currentFocusBucketId,
    );
    predictions.push({
      id: evaluationCase.id,
      action: result.action,
      bucketId: result.bucketId,
      confidence: result.confidence,
      shouldAskUser: result.shouldAskUser,
    });
    console.log(
      `[${index + 1}/${cases.length}] ${evaluationCase.id}: ${result.action} (${result.confidence.toFixed(2)})`,
    );
  }
  return {
    ...metadata,
    casesPath,
    caseCount: cases.length,
    predictions,
    metrics: evaluateClassification(cases, predictions),
  };
}

export async function runLiveExtraction(
  cases: readonly ExtractionCase[],
  options: {
    readonly extractor: LiveExtractor;
    readonly metadata: LiveEvaluationMetadata;
    readonly casesPath?: string;
    readonly referenceDate?: string;
  },
): Promise<LiveExtractionReport> {
  if (cases.length === 0) {
    throw new RangeError("at least one extraction case is required");
  }
  const metadata = reportMetadata(options.metadata);
  const referenceDate =
    options.referenceDate ?? metadata.generatedAt.slice(0, 10);
  const casesPath = options.casesPath ?? "tests/fixtures/extraction_cases.json";
  const predictions: ExtractionPrediction[] = [];
  for (const [index, evaluationCase] of cases.entries()) {
    const result = await options.extractor(
      evaluationCase.input,
      evaluationCase.bucketType,
      referenceDate,
    );
    predictions.push({ id: evaluationCase.id, result });
    console.log(
      `[${index + 1}/${cases.length}] ${evaluationCase.id}: ${result.summary}`,
    );
  }
  return {
    ...metadata,
    referenceDate,
    casesPath,
    caseCount: cases.length,
    predictions,
    metrics: evaluateExtractions(cases, predictions),
  };
}

export function writeLiveClassificationReport(
  report: LiveClassificationReport,
  outputPath: string,
): void {
  writeJson(outputPath, serializeClassificationReport(report));
}

export function writeLiveExtractionReport(
  report: LiveExtractionReport,
  outputPath: string,
): void {
  writeJson(outputPath, serializeExtractionReport(report));
}

function reportMetadata(metadata: LiveEvaluationMetadata): ReportMetadata {
  const modelName = metadata.modelName.trim();
  const apiSite = metadata.apiSite.trim();
  const apiBaseUrl = metadata.apiBaseUrl.trim();
  if (modelName === "" || apiSite === "" || apiBaseUrl === "") {
    throw new TypeError("live evaluation metadata must contain non-empty text");
  }
  return {
    generatedAt: metadata.generatedAt ?? new Date().toISOString(),
    modelName,
    apiSite,
    apiBaseUrl,
    apiMode: metadata.apiMode,
    promptVersion: metadata.promptVersion ?? EVALUATION_PROMPT_VERSION,
  };
}

function serializeClassificationReport(report: LiveClassificationReport) {
  return {
    generated_at: report.generatedAt,
    model_name: report.modelName,
    api_site: report.apiSite,
    api_base_url: report.apiBaseUrl,
    api_mode: report.apiMode,
    prompt_version: report.promptVersion,
    cases_path: report.casesPath,
    case_count: report.caseCount,
    predictions: report.predictions.map((prediction) => ({
      id: prediction.id,
      action: prediction.action,
      bucket_id: prediction.bucketId ?? null,
      confidence: prediction.confidence,
      should_ask_user: prediction.shouldAskUser,
    })),
    metrics: {
      total: report.metrics.total,
      action_accuracy: report.metrics.actionAccuracy,
      existing_bucket_accuracy: report.metrics.existingBucketAccuracy,
      auto_archive_accuracy: report.metrics.autoArchiveAccuracy,
      ask_user_recall: report.metrics.askUserRecall,
      severe_mismerge_count: report.metrics.severeMismergeCount,
      confidence_bands: serializeConfidenceBands(
        report.metrics.confidenceBands,
      ),
    },
  };
}

function serializeExtractionReport(report: LiveExtractionReport) {
  return {
    generated_at: report.generatedAt,
    reference_date: report.referenceDate,
    model_name: report.modelName,
    api_site: report.apiSite,
    api_base_url: report.apiBaseUrl,
    api_mode: report.apiMode,
    prompt_version: report.promptVersion,
    cases_path: report.casesPath,
    case_count: report.caseCount,
    predictions: report.predictions.map((prediction) => ({
      id: prediction.id,
      result: {
        summary: prediction.result.summary,
        todos: [...prediction.result.todos],
        evidences: [...prediction.result.evidences],
        timeline_events: prediction.result.timelineEvents.map((event) => ({
          event_time: event.occurredAt ?? null,
          text: event.text,
        })),
        decisions: [...prediction.result.decisions],
        hypotheses: [...prediction.result.hypotheses],
        entities: [...prediction.result.entities],
        tags: [...prediction.result.tags],
      },
    })),
    metrics: {
      total: report.metrics.total,
      summary_term_recall: report.metrics.summaryTermRecall,
      todo_term_recall: report.metrics.todoTermRecall,
      evidence_term_recall: report.metrics.evidenceTermRecall,
      timeline_term_recall: report.metrics.timelineTermRecall,
      decision_term_recall: report.metrics.decisionTermRecall,
      forbidden_term_violation_count:
        report.metrics.forbiddenTermViolationCount,
      novel_numeric_claim_count: report.metrics.novelNumericClaimCount,
      case_checks: report.metrics.caseChecks.map((check) => ({
        id: check.id,
        missing_summary_terms: [...check.missingSummaryTerms],
        missing_todo_terms: [...check.missingTodoTerms],
        missing_evidence_terms: [...check.missingEvidenceTerms],
        missing_timeline_terms: [...check.missingTimelineTerms],
        missing_decision_terms: [...check.missingDecisionTerms],
        forbidden_term_matches: [...check.forbiddenTermMatches],
        novel_numeric_claims: [...check.novelNumericClaims],
      })),
    },
  };
}

function serializeConfidenceBands(
  bands: LiveClassificationReport["metrics"]["confidenceBands"],
) {
  return Object.fromEntries(
    Object.entries(bands).map(([name, values]) => [
      name,
      {
        count: values.count,
        accuracy: values.accuracy,
        ask_user_rate: values.askUserRate,
      },
    ]),
  );
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
