/**
 * Deterministic classification-evaluation harness.
 *
 * Human-labelled cases and model predictions are deliberately separate: the
 * transparent baseline reads only the input, focus and candidate metadata, so
 * expected labels remain evaluation truth rather than heuristic input.
 */

import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  BUCKET_STATUSES,
  BUCKET_TYPES,
  CLASSIFICATION_ACTIONS,
  ClassificationAction,
  type BucketStatus,
  type BucketType,
  type ClassificationAction as ClassificationActionValue,
} from "../domain/types.ts";

const errorCosts = ["low", "medium", "high"] as const;

const evaluationBucketSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    type: z.enum(BUCKET_TYPES),
    status: z.enum(BUCKET_STATUSES).default("active"),
    summary: z.string().trim().default(""),
  })
  .strict();

const classificationCaseSchema = z
  .object({
    id: z.string().trim().min(1),
    input: z.string().trim().min(1),
    current_focus_bucket_id: z.string().trim().min(1).nullable().default(null),
    buckets: z.array(evaluationBucketSchema).default([]),
    expected_action: z.enum(CLASSIFICATION_ACTIONS),
    expected_bucket_id: z.string().trim().min(1).nullable().default(null),
    should_ask_user: z.boolean(),
    error_cost: z.enum(errorCosts),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = new Set(value.buckets.map((bucket) => bucket.id));
    if (
      value.current_focus_bucket_id !== null &&
      !candidateIds.has(value.current_focus_bucket_id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["current_focus_bucket_id"],
        message: "current_focus_bucket_id must reference a candidate",
      });
    }
    if (value.expected_action === ClassificationAction.AppendExisting) {
      if (
        value.expected_bucket_id === null ||
        !candidateIds.has(value.expected_bucket_id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["expected_bucket_id"],
          message: "append_existing expected_bucket_id must be a candidate",
        });
      }
      if (value.should_ask_user) {
        context.addIssue({
          code: "custom",
          path: ["should_ask_user"],
          message: "append_existing cannot expect a user question",
        });
      }
    } else if (value.expected_action === ClassificationAction.AskUser) {
      if (!value.should_ask_user) {
        context.addIssue({
          code: "custom",
          path: ["should_ask_user"],
          message: "ask_user case must set should_ask_user=true",
        });
      }
    } else if (value.expected_bucket_id !== null) {
      context.addIssue({
        code: "custom",
        path: ["expected_bucket_id"],
        message: "create_new must not define expected_bucket_id",
      });
    }
  });

const classificationPredictionSchema = z
  .object({
    id: z.string().trim().min(1),
    action: z.enum(CLASSIFICATION_ACTIONS),
    bucket_id: z.string().trim().min(1).nullable().default(null),
    confidence: z.number().min(0).max(1),
    should_ask_user: z.boolean().default(false),
  })
  .strict();

export type EvaluationBucket = {
  readonly id: string;
  readonly title: string;
  readonly type: BucketType;
  readonly status: BucketStatus;
  readonly summary: string;
};

export type ClassificationCase = {
  readonly id: string;
  readonly input: string;
  readonly currentFocusBucketId: string | undefined;
  readonly buckets: readonly EvaluationBucket[];
  readonly expectedAction: ClassificationActionValue;
  readonly expectedBucketId: string | undefined;
  readonly shouldAskUser: boolean;
  readonly errorCost: (typeof errorCosts)[number];
};

export type ClassificationPrediction = {
  readonly id: string;
  readonly action: ClassificationActionValue;
  readonly bucketId: string | undefined;
  readonly confidence: number;
  readonly shouldAskUser: boolean;
};

export type ConfidenceBandMetrics = {
  readonly count: number;
  readonly accuracy: number;
  readonly askUserRate: number;
};

export type ClassificationMetrics = {
  readonly total: number;
  readonly actionAccuracy: number;
  readonly existingBucketAccuracy: number;
  readonly autoArchiveAccuracy: number;
  readonly askUserRecall: number;
  readonly severeMismergeCount: number;
  readonly confidenceBands: Readonly<
    Record<"low" | "medium" | "high", ConfidenceBandMetrics>
  >;
};

export function loadClassificationCases(path: string): ClassificationCase[] {
  const parsed = parseJsonFile(path, "classification fixture");
  if (!Array.isArray(parsed)) {
    throw new TypeError("classification fixture must be a JSON array");
  }
  const cases = parsed.map((value) => toClassificationCase(value));
  requireUniqueIds(cases, "classification case");
  return cases;
}

export function loadClassificationPredictions(
  path: string,
): ClassificationPrediction[] {
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
  return values.map((value) => toClassificationPrediction(value));
}

export function evaluateClassification(
  cases: readonly ClassificationCase[],
  predictions: readonly ClassificationPrediction[],
): ClassificationMetrics {
  if (cases.length === 0) {
    throw new RangeError("at least one classification case is required");
  }
  const predictionsById = new Map<string, ClassificationPrediction>();
  for (const prediction of predictions) {
    if (predictionsById.has(prediction.id)) {
      throw new RangeError("prediction ids must be unique");
    }
    predictionsById.set(prediction.id, prediction);
  }
  const expectedIds = new Set(cases.map((item) => item.id));
  const missing = cases
    .filter((item) => !predictionsById.has(item.id))
    .map((item) => item.id);
  const extra = [...predictionsById.keys()]
    .filter((id) => !expectedIds.has(id))
    .sort();
  if (missing.length > 0 || extra.length > 0) {
    throw new RangeError(
      `prediction ids mismatch; missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}`,
    );
  }

  let actionCorrect = 0;
  let appendTotal = 0;
  let appendCorrect = 0;
  let autoTotal = 0;
  let autoCorrect = 0;
  let askTotal = 0;
  let askCorrect = 0;
  let severeMismergeCount = 0;
  const bands: Record<"low" | "medium" | "high", Array<[boolean, boolean]>> = {
    low: [],
    medium: [],
    high: [],
  };

  for (const evaluationCase of cases) {
    const prediction = predictionsById.get(evaluationCase.id);
    if (prediction === undefined)
      throw new Error("prediction lookup invariant");
    const correct = isCorrect(evaluationCase, prediction);
    actionCorrect += Number(
      prediction.action === evaluationCase.expectedAction,
    );

    if (evaluationCase.expectedAction === ClassificationAction.AppendExisting) {
      appendTotal += 1;
      appendCorrect += Number(
        prediction.action === ClassificationAction.AppendExisting &&
          prediction.bucketId === evaluationCase.expectedBucketId,
      );
    }
    if (prediction.action !== ClassificationAction.AskUser) {
      autoTotal += 1;
      autoCorrect += Number(correct);
    }
    if (evaluationCase.expectedAction === ClassificationAction.AskUser) {
      askTotal += 1;
      askCorrect += Number(
        prediction.action === ClassificationAction.AskUser &&
          prediction.shouldAskUser,
      );
    }
    const wrongAppend =
      prediction.action === ClassificationAction.AppendExisting &&
      (evaluationCase.expectedAction !== ClassificationAction.AppendExisting ||
        prediction.bucketId !== evaluationCase.expectedBucketId);
    severeMismergeCount += Number(
      evaluationCase.errorCost === "high" && wrongAppend,
    );
    bands[confidenceBand(prediction.confidence)].push([
      correct,
      prediction.action === ClassificationAction.AskUser,
    ]);
  }

  return {
    total: cases.length,
    actionAccuracy: actionCorrect / cases.length,
    existingBucketAccuracy: appendTotal === 0 ? 0 : appendCorrect / appendTotal,
    autoArchiveAccuracy: autoTotal === 0 ? 0 : autoCorrect / autoTotal,
    askUserRecall: askTotal === 0 ? 0 : askCorrect / askTotal,
    severeMismergeCount,
    confidenceBands: {
      low: toBandMetrics(bands.low),
      medium: toBandMetrics(bands.medium),
      high: toBandMetrics(bands.high),
    },
  };
}

export function keywordBaselinePredictions(
  cases: readonly ClassificationCase[],
): ClassificationPrediction[] {
  const explicitNewMarkers = [
    "新开",
    "新建",
    "单独",
    "另开",
    "另一个",
    "另记",
    "开始写",
    "开始准备",
    "建立一个独立",
  ];
  const vagueMarkers = [
    "刚才那个",
    "继续刚才",
    "这个事情",
    "它现在",
    "这个结论",
    "上次",
    "那个问题",
    "接口问题",
    "支付相关",
  ];
  const continuationMarkers = [
    "继续",
    "刚才",
    "这个",
    "那个",
    "补充",
    "更新",
    "已经",
    "现在",
    "恢复",
    "完成",
  ];
  const keywords = [
    "支付",
    "接口",
    "压测",
    "会议",
    "评审",
    "Agent",
    "Pydantic",
    "稳定性",
    "数据库",
  ];

  return cases.map((evaluationCase) => {
    const text = evaluationCase.input;
    let action: ClassificationActionValue;
    let bucketId: string | undefined;
    let confidence: number;

    if (includesAny(text, explicitNewMarkers)) {
      action = ClassificationAction.CreateNew;
      bucketId = undefined;
      confidence = 0.9;
    } else if (evaluationCase.buckets.length === 0) {
      if (includesAny(text, [...vagueMarkers, ...continuationMarkers])) {
        action = ClassificationAction.AskUser;
        bucketId = undefined;
        confidence = 0.35;
      } else {
        action = ClassificationAction.CreateNew;
        bucketId = undefined;
        confidence = 0.75;
      }
    } else {
      const scores = evaluationCase.buckets.map((bucket) => {
        let score = 0;
        const bucketText =
          `${bucket.title}${bucket.summary}`.toLocaleLowerCase();
        for (const keyword of keywords) {
          if (
            text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()) &&
            bucketText.includes(keyword.toLocaleLowerCase())
          ) {
            score += 2;
          }
        }
        if (
          bucket.id === evaluationCase.currentFocusBucketId &&
          includesAny(text, continuationMarkers)
        ) {
          score += 3;
        }
        return { score, bucketId: bucket.id };
      });
      scores.sort(
        (left, right) =>
          right.score - left.score ||
          // Code-point order, not collation: some collations ignore
          // punctuation, which makes the dashes in a UUID tiebreak
          // differently depending on the runtime locale.
          (right.bucketId < left.bucketId
            ? -1
            : right.bucketId > left.bucketId
              ? 1
              : 0),
      );
      const first = scores[0];
      if (first === undefined) throw new Error("candidate scoring invariant");
      const bestIds = scores
        .filter((item) => item.score === first.score)
        .map((item) => item.bucketId);
      if (
        first.score === 0 ||
        bestIds.length > 1 ||
        includesAny(text, vagueMarkers)
      ) {
        action = ClassificationAction.AskUser;
        bucketId = undefined;
        confidence = 0.4;
      } else {
        action = ClassificationAction.AppendExisting;
        bucketId = first.bucketId;
        confidence = 0.88;
      }
    }

    return {
      id: evaluationCase.id,
      action,
      bucketId,
      confidence,
      shouldAskUser: action === ClassificationAction.AskUser,
    };
  });
}

function toClassificationCase(value: unknown): ClassificationCase {
  const parsed = classificationCaseSchema.parse(value);
  return {
    id: parsed.id,
    input: parsed.input,
    currentFocusBucketId: parsed.current_focus_bucket_id ?? undefined,
    buckets: parsed.buckets.map((bucket) => ({
      id: bucket.id,
      title: bucket.title,
      type: bucket.type,
      status: bucket.status,
      summary: bucket.summary,
    })),
    expectedAction: parsed.expected_action,
    expectedBucketId: parsed.expected_bucket_id ?? undefined,
    shouldAskUser: parsed.should_ask_user,
    errorCost: parsed.error_cost,
  };
}

function toClassificationPrediction(value: unknown): ClassificationPrediction {
  const parsed = classificationPredictionSchema.parse(value);
  return {
    id: parsed.id,
    action: parsed.action,
    bucketId: parsed.bucket_id ?? undefined,
    confidence: parsed.confidence,
    shouldAskUser: parsed.should_ask_user,
  };
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
  if (ids.size !== values.length) {
    throw new RangeError(`${label} ids must be unique`);
  }
}

function isCorrect(
  evaluationCase: ClassificationCase,
  prediction: ClassificationPrediction,
): boolean {
  if (prediction.action !== evaluationCase.expectedAction) return false;
  if (evaluationCase.expectedAction === ClassificationAction.AppendExisting) {
    return prediction.bucketId === evaluationCase.expectedBucketId;
  }
  return prediction.shouldAskUser === evaluationCase.shouldAskUser;
}

function confidenceBand(confidence: number): "low" | "medium" | "high" {
  if (confidence < 0.55) return "low";
  if (confidence < 0.85) return "medium";
  return "high";
}

function toBandMetrics(
  values: readonly [boolean, boolean][],
): ConfidenceBandMetrics {
  return {
    count: values.length,
    accuracy:
      values.length === 0
        ? 0
        : values.filter(([correct]) => correct).length / values.length,
    askUserRate:
      values.length === 0
        ? 0
        : values.filter(([, asked]) => asked).length / values.length,
  };
}

function includesAny(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => value.includes(marker));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
