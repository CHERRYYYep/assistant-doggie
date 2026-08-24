/**
 * Deterministic classification safeguards.
 *
 * The governing rule of this file: **the model's confidence is not an
 * authorization to persist.** Every gate below can downgrade a confident
 * automatic action into a confirmation, and none can upgrade one.
 *
 * Ported from `crates/doggie-domain/src/classification.rs`. Behaviour is
 * pinned by `classification.test.ts`, whose assertions come from the Rust
 * test suite. See `docs/INVARIANTS.md` §1–§3.
 */

import { DomainError, requiredText } from "./errors.ts";
import { normalizeOptionalText, normalizeStringList } from "./text.ts";
import {
  ClassificationAction,
  type BucketType,
  type BucketView,
} from "./types.ts";

// These markers are deliberately broader than the model prompt. A model can be
// highly confident about a plausible Bucket even when the user supplied no new
// fact, so the server-side gate treats vague references and status-only
// updates as confirmation-worthy regardless of the model score.
const VAGUE_REFERENCE_MARKERS = [
  "刚才",
  "刚刚",
  "那个",
  "这个",
  "它",
  "上次",
  "之前",
  "前面",
  "那块",
  "这块",
  "相关",
  "该问题",
  "这件事",
  "那个任务",
  "这个任务",
] as const;

const LOW_INFORMATION_ACTION_MARKERS = [
  "继续",
  "更新",
  "完成",
  "好了",
  "正常了",
  "有进展",
  "搞定",
  "解决",
  "记一下",
  "记下",
  "再补一点",
  "补一点",
  "补一下",
  "补充一下",
  "跟进一下",
  "处理",
  "看一下",
] as const;

const CONCRETE_FACT_MARKERS = [
  "恢复",
  "决定",
  "确认",
  "回复说",
  "导致",
  "原因",
  "失败",
  "报错",
  "错误率",
  "日志",
  "影响",
  "降到",
  "升到",
  "验证",
  "上线",
  "回滚",
  "阻塞",
  "502",
  "P99",
  "QPS",
] as const;

const LOW_INFORMATION_CHAR_LIMIT = 24;

/**
 * Unicode numbers or a percent sign.
 *
 * `\p{N}` is General_Category ∈ {Nd, Nl, No}, which is exactly Rust's
 * `char::is_numeric()` — verified character-by-character against the Rust
 * implementation. Note that CJK number *words* (三, 百) are Lo, not N, so
 * they do **not** count as concrete facts in either implementation.
 */
const CONCRETE_NUMBER = /[\p{N}%]/u;

/** Configurable thresholds for automatic persistence. */
export type ConfidencePolicy = {
  readonly autoArchiveThreshold: number;
  readonly confirmThreshold: number;
};

export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = {
  autoArchiveThreshold: 0.85,
  confirmThreshold: 0.55,
};

export function createConfidencePolicy(
  autoArchiveThreshold: number,
  confirmThreshold: number,
): ConfidencePolicy {
  const valid =
    Number.isFinite(autoArchiveThreshold) &&
    Number.isFinite(confirmThreshold) &&
    confirmThreshold >= 0 &&
    confirmThreshold <= autoArchiveThreshold &&
    autoArchiveThreshold <= 1;
  if (!valid) {
    throw DomainError.invalidConfidenceThresholds(
      confirmThreshold,
      autoArchiveThreshold,
    );
  }
  return { autoArchiveThreshold, confirmThreshold };
}

/**
 * A validated classification result.
 *
 * Branded so it can only come from the constructors below, which reject
 * field combinations the archive workflow cannot execute.
 */
declare const classificationBrand: unique symbol;

/** The data of a `ClassificationResult`, without the brand. */
type ClassificationFields = {
  readonly action: ClassificationAction;
  readonly bucketId: string | undefined;
  readonly bucketType: BucketType | undefined;
  readonly title: string | undefined;
  readonly confidence: number;
  readonly reason: string;
  readonly shouldAskUser: boolean;
  readonly question: string | undefined;
  readonly candidateBucketIds: readonly string[];
};

export type ClassificationResult = ClassificationFields & {
  readonly [classificationBrand]: true;
};

export type ClassificationInput = {
  readonly action: ClassificationAction;
  readonly bucketId?: string | undefined;
  readonly bucketType?: BucketType | undefined;
  readonly title?: string | undefined;
  readonly confidence: number;
  readonly reason: string;
  readonly shouldAskUser?: boolean;
  readonly question?: string | undefined;
  readonly candidateBucketIds?: readonly string[];
};

export function createClassification(
  input: ClassificationInput,
): ClassificationResult {
  const { action, confidence } = input;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw DomainError.confidenceOutOfRange(confidence);
  }

  const bucketId = normalizeOptionalText(input.bucketId);
  const title = normalizeOptionalText(input.title);
  const question = normalizeOptionalText(input.question);
  const reason = requiredText(input.reason, "reason");
  const shouldAskUser = input.shouldAskUser ?? false;

  switch (action) {
    case ClassificationAction.AppendExisting:
      if (bucketId === undefined) {
        throw DomainError.inconsistentClassification(
          "append_existing requires bucket_id",
        );
      }
      if (shouldAskUser || question !== undefined) {
        throw DomainError.inconsistentClassification(
          "append_existing cannot request user confirmation",
        );
      }
      break;
    case ClassificationAction.CreateNew:
      if (bucketId !== undefined) {
        throw DomainError.inconsistentClassification(
          "create_new must not include bucket_id",
        );
      }
      if (input.bucketType === undefined || title === undefined) {
        throw DomainError.inconsistentClassification(
          "create_new requires bucket_type and title",
        );
      }
      if (shouldAskUser || question !== undefined) {
        throw DomainError.inconsistentClassification(
          "create_new cannot request user confirmation",
        );
      }
      break;
    case ClassificationAction.AskUser:
      if (!shouldAskUser) {
        throw DomainError.inconsistentClassification(
          "ask_user requires should_ask_user=true",
        );
      }
      if (question === undefined) {
        throw DomainError.inconsistentClassification(
          "ask_user requires question",
        );
      }
      break;
  }

  // Checked as the unbranded shape, then widened once. The brand exists only
  // so a value of this type is proof that it passed the checks above.
  const fields: ClassificationFields = {
    action,
    bucketId,
    bucketType: input.bucketType,
    title,
    confidence,
    reason,
    shouldAskUser,
    question,
    candidateBucketIds: normalizeStringList(input.candidateBucketIds ?? []),
  };
  return fields as ClassificationResult;
}

export function appendExisting(
  bucketId: string,
  bucketType: BucketType | undefined,
  confidence: number,
  reason: string,
  candidateBucketIds: readonly string[] = [],
): ClassificationResult {
  return createClassification({
    action: ClassificationAction.AppendExisting,
    bucketId,
    bucketType,
    confidence,
    reason,
    candidateBucketIds,
  });
}

export function createNew(
  bucketType: BucketType,
  title: string,
  confidence: number,
  reason: string,
  candidateBucketIds: readonly string[] = [],
): ClassificationResult {
  return createClassification({
    action: ClassificationAction.CreateNew,
    bucketType,
    title,
    confidence,
    reason,
    candidateBucketIds,
  });
}

export function askUser(
  bucketType: BucketType | undefined,
  title: string | undefined,
  confidence: number,
  reason: string,
  question: string,
  candidateBucketIds: readonly string[] = [],
): ClassificationResult {
  return createClassification({
    action: ClassificationAction.AskUser,
    bucketType,
    title,
    confidence,
    reason,
    shouldAskUser: true,
    question,
    candidateBucketIds,
  });
}

/** Downgrade a result to a confirmation, appending why to the reason. */
function intoConfirmation(
  result: ClassificationResult,
  question: string,
  candidateBucketIds: readonly string[],
  reasonSuffix: string,
): ClassificationResult {
  return askUser(
    result.bucketType,
    result.title,
    result.confidence,
    `${result.reason} ${reasonSuffix}`.trim(),
    question,
    candidateBucketIds,
  );
}

/**
 * De-duplicate candidates while preserving the service-provided order.
 *
 * Ranking is owned by the service/store layer so candidates can combine
 * recent and popular active Buckets without a UI selection overriding that
 * order. `currentFocusBucketId` is retained for API compatibility and audit
 * callers but deliberately does **not** influence order.
 *
 * Duplicate handling matches the original dict-comprehension semantics: the
 * **last** value for an id wins, at the **first** position that id appeared.
 */
export function buildBucketCandidates(
  buckets: readonly BucketView[],
  currentFocusBucketId: string | undefined,
  limit: number,
): BucketView[] {
  void currentFocusBucketId;
  if (!Number.isInteger(limit) || limit < 1)
    throw DomainError.candidateLimitTooSmall();

  const positions = new Map<string, number>();
  const deduplicated: BucketView[] = [];
  for (const bucket of buckets) {
    const position = positions.get(bucket.id);
    if (position !== undefined) {
      deduplicated[position] = bucket;
    } else {
      positions.set(bucket.id, deduplicated.length);
      deduplicated.push(bucket);
    }
  }
  return deduplicated.slice(0, limit);
}

/** The Buckets this result could plausibly land in: explicit target first. */
function likelyCandidateIds(result: ClassificationResult): string[] {
  const ids: string[] = [];
  if (result.bucketId !== undefined) ids.push(result.bucketId);
  for (const candidateId of result.candidateBucketIds) {
    if (!ids.includes(candidateId)) ids.push(candidateId);
  }
  return ids;
}

/** Reject generated Bucket IDs that were not supplied by the server. */
export function validateCandidateReference(
  result: ClassificationResult,
  candidates: readonly BucketView[],
): ClassificationResult {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const originalIds = [...result.candidateBucketIds];
  const mergedIds: string[] = [];

  // An explicit model target is the strongest recommendation. Then the model's
  // valid candidates, then the bounded server list, so the UI can always show
  // a real alternative-Bucket selector.
  if (result.bucketId !== undefined && candidateIds.has(result.bucketId)) {
    mergedIds.push(result.bucketId);
  }
  for (const candidateId of originalIds) {
    if (candidateIds.has(candidateId) && !mergedIds.includes(candidateId)) {
      mergedIds.push(candidateId);
    }
  }

  if (
    result.action === ClassificationAction.AppendExisting &&
    (result.bucketId === undefined || !candidateIds.has(result.bucketId))
  ) {
    return intoConfirmation(
      result,
      "模型给出的目标不存在，请选择要归档到哪个 Bucket。",
      candidates.map((candidate) => candidate.id),
      "目标 Bucket ID 不在服务端候选列表中，已阻止自动归档。",
    );
  }

  const hasInvalidCandidates = originalIds.some(
    (candidateId) => !candidateIds.has(candidateId),
  );
  const shouldIncludeServerCandidates =
    result.action === ClassificationAction.AskUser || hasInvalidCandidates;
  if (shouldIncludeServerCandidates) {
    for (const candidate of candidates) {
      if (!mergedIds.includes(candidate.id)) mergedIds.push(candidate.id);
    }
  }

  if (hasInvalidCandidates) {
    return intoConfirmation(
      result,
      result.question ?? "请从有效候选中选择目标 Bucket。",
      mergedIds,
      "模型返回了不存在的候选 ID，已过滤并要求确认。",
    );
  }

  if (
    result.action === ClassificationAction.AskUser &&
    !sameOrder(mergedIds, originalIds)
  ) {
    return intoConfirmation(
      result,
      result.question ?? "请从活跃 Bucket 中选择归档目标。",
      mergedIds,
      "已补充服务端候选列表，方便用户确认归档目标。",
    );
  }

  return result;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Convert uncertain or ambiguous automatic actions into confirmation. */
export function applyConfidenceGate(
  result: ClassificationResult,
  policy: ConfidencePolicy,
): ClassificationResult {
  if (result.action === ClassificationAction.AskUser) return result;

  const likelyIds = likelyCandidateIds(result);

  // More than one plausible target is ambiguous no matter how confident the
  // model is. This check deliberately precedes the threshold comparison.
  if (likelyIds.length > 1) {
    return intoConfirmation(
      result,
      "多个 Bucket 都可能匹配，请确认本条内容的归属。",
      likelyIds,
      "存在多个相似候选，已降级为用户确认。",
    );
  }

  if (result.confidence >= policy.autoArchiveThreshold) return result;

  const question =
    result.confidence >= policy.confirmThreshold
      ? result.action === ClassificationAction.CreateNew
        ? "请确认是否创建这个新 Bucket。"
        : "分类置信度一般，请确认是否追加到该 Bucket。"
      : "当前信息不足以安全归档，请确认目标 Bucket 或新建事务。";

  return intoConfirmation(
    result,
    question,
    likelyIds,
    "置信度未达到自动归档阈值。",
  );
}

/** Ask before automatically persisting vague or status-only input. */
export function applyLowInformationReferenceGate(
  text: string,
  result: ClassificationResult,
): ClassificationResult {
  if (
    result.action === ClassificationAction.AskUser ||
    !isLowInformationReference(text)
  ) {
    return result;
  }

  return intoConfirmation(
    result,
    result.action === ClassificationAction.CreateNew
      ? "输入只有模糊指代和低信息动作，请确认是否创建新 Bucket 或选择已有 Bucket。"
      : "输入只有模糊指代和低信息动作，请确认要追加到哪个 Bucket。",
    likelyCandidateIds(result),
    "输入缺少可核验事实、状态变化、决策或待办，已阻止高风险自动合并。",
  );
}

/** Apply every deterministic safeguard after an adapter parses model output. */
export function postprocessClassification(
  text: string,
  result: ClassificationResult,
  candidates: readonly BucketView[],
  policy: ConfidencePolicy,
): ClassificationResult {
  if (text.trim() === "") throw DomainError.emptyText("text");

  let gated = validateCandidateReference(result, candidates);
  gated = applyLowInformationReferenceGate(text.trim(), gated);
  gated = applyConfidenceGate(gated, policy);
  // The confidence and low-information gates can produce a fresh ask_user
  // result after the first validation pass. Run it again so a confirmation is
  // never returned without a usable Bucket selector when candidates exist.
  return validateCandidateReference(gated, candidates);
}

/**
 * Whether `text` carries no durable fact worth merging automatically.
 *
 * Two branches, both required:
 *   1. a vague reference plus a low-information action ("那个任务继续"), and
 *   2. a short status-only update that names no reference ("它现在正常了").
 *
 * Either is defeated by a concrete fact — a number, a percent, or one of the
 * outcome markers.
 */
export function isLowInformationReference(text: string): boolean {
  const hasVagueReference = VAGUE_REFERENCE_MARKERS.some((marker) =>
    text.includes(marker),
  );
  const hasLowInformationAction = LOW_INFORMATION_ACTION_MARKERS.some(
    (marker) => text.includes(marker),
  );
  const hasConcreteFact =
    CONCRETE_NUMBER.test(text) ||
    CONCRETE_FACT_MARKERS.some((marker) => text.includes(marker));
  const compactStatusUpdate = [...text].length <= LOW_INFORMATION_CHAR_LIMIT;

  return (
    (hasVagueReference && hasLowInformationAction && !hasConcreteFact) ||
    (hasLowInformationAction && compactStatusUpdate && !hasConcreteFact)
  );
}
