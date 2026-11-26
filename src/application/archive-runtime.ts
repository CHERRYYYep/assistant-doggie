/** Model-backed archive orchestration with deterministic server-side gates. */

import {
  askUser,
  buildBucketCandidates,
  DEFAULT_CONFIDENCE_POLICY,
  postprocessClassification,
  type ClassificationResult,
  type ConfidencePolicy,
} from "../domain/classification.ts";
import { requiredText } from "../domain/errors.ts";
import { createExtraction, type ExtractionResult } from "../domain/memory.ts";
import {
  localTimeZone,
  parseNaturalTodoPlan,
  shouldAutoPromoteTodo,
} from "../domain/todo-time.ts";
import {
  BucketStatus,
  createBucketView,
  type BucketType,
  type BucketView,
} from "../domain/types.ts";
import {
  abortError,
  isAbortError,
  throwIfAborted,
  withCancellation,
} from "../llm/cancellation.ts";
import {
  classificationContract,
  extractionContract,
} from "../llm/contracts.ts";
import type { StructuredOutputAdapter } from "../llm/structured-output.ts";
import { StorageError } from "../storage/database.ts";
import type { BucketRow, Store } from "../storage/store.ts";
import {
  ArchiveService,
  type ArchiveResult,
  type DiscardResult,
} from "./archive.ts";

export const RUNTIME_PROMPT_VERSION = "doggie-engine-v1";
export const DEFAULT_ACTIVE_BUCKET_LIMIT = 20;
export const DEFAULT_STRUCTURED_OUTPUT_RETRIES = 2;

export const CLASSIFICATION_SYSTEM_PROMPT =
  "你是工作记忆分类器。只返回符合 ClassificationResult schema 的 JSON。" +
  "候选 Bucket 是服务端根据最近活跃和热门程度自动提供的唯一有效 ID，不代表用户手动选择。" +
  "优先使用唯一且明确匹配的候选；无法安全判断时使用 ask_user。" +
  "如果输入只有“那个/这个/它/上次/相关”等模糊指代，或只有“继续/更新了/完成了/好了/正常了/记一下”等低信息状态动作，" +
  "且没有数字、指标、错误、日志、决定、原因或其他可核验事实，必须使用 ask_user，即使你很确定最像哪个 Bucket。不要臆造 Bucket ID。";

export const EXTRACTION_SYSTEM_PROMPT =
  "你是工作记忆提取器。只返回符合 ExtractionResult schema 的 JSON。" +
  "完整保留用户事实，不要把建议、猜测或助手内容伪装成已发生事实；时间表达式保留用户原文。" +
  "如果用户输入包含待完成的个人任务、作业、会议、提醒或日程安排（例如「明天早上写计网作业」「下周一前交报告」），必须将其放入 todos 数组并保留原始时间表达。";

export type MemoryModel = {
  readonly modelName: string;
  readonly classify: (
    text: string,
    candidates: readonly BucketView[],
    signal?: AbortSignal,
  ) => Promise<ClassificationResult>;
  readonly extract: (
    text: string,
    signal?: AbortSignal,
  ) => Promise<ExtractionResult>;
};

/** Production facade over the transport-independent strict output adapter. */
export class StructuredMemoryModel implements MemoryModel {
  readonly modelName: string;
  readonly #adapter: StructuredOutputAdapter;
  readonly #maxRetries: number;

  constructor(
    adapter: StructuredOutputAdapter,
    modelName: string,
    maxRetries: number = DEFAULT_STRUCTURED_OUTPUT_RETRIES,
  ) {
    this.#adapter = adapter;
    this.modelName = requiredText(modelName, "model_name");
    this.#maxRetries = maxRetries;
  }

  classify(
    text: string,
    candidates: readonly BucketView[],
    signal?: AbortSignal,
  ): Promise<ClassificationResult> {
    return this.#adapter.parse(
      classificationContract,
      this.modelName,
      CLASSIFICATION_SYSTEM_PROMPT,
      JSON.stringify({ text, candidates: candidates.map(projectCandidate) }),
      this.#maxRetries,
      signal,
    );
  }

  extract(text: string, signal?: AbortSignal): Promise<ExtractionResult> {
    return this.#adapter.parse(
      extractionContract,
      this.modelName,
      EXTRACTION_SYSTEM_PROMPT,
      JSON.stringify({
        current_time: new Date().toISOString(),
        time_zone: localTimeZone(),
        text,
      }),
      this.#maxRetries,
      signal,
    );
  }
}

export type ArchiveExecution = {
  readonly result: ArchiveResult;
  readonly candidates: readonly BucketView[];
  readonly bucket: BucketRow | undefined;
};

export type ConfirmationExecution =
  | ArchiveExecution
  | {
      readonly result: DiscardResult;
      readonly candidates: readonly BucketView[];
      readonly bucket: undefined;
    };

export type RuntimeConfirmationRequest =
  | {
      readonly action: "append";
      readonly attemptId: string;
      readonly rawText: string;
      readonly targetBucketId: string;
      readonly focusBucketId?: string;
    }
  | {
      readonly action: "create";
      readonly attemptId: string;
      readonly rawText: string;
      readonly title: string;
      readonly bucketType: BucketType;
      readonly focusBucketId?: string;
    }
  | {
      readonly action: "discard";
      readonly attemptId: string;
      readonly rawText: string;
    };

export class ArchiveRuntime {
  readonly #store: Store;
  readonly #service: ArchiveService;
  readonly #model: MemoryModel;
  readonly #policy: ConfidencePolicy;

  constructor(
    store: Store,
    model: MemoryModel,
    policy: ConfidencePolicy = DEFAULT_CONFIDENCE_POLICY,
  ) {
    this.#store = store;
    this.#service = new ArchiveService(store);
    this.#model = model;
    this.#policy = policy;
  }

  async archiveText(
    rawText: string,
    focusBucketId?: string,
    signal?: AbortSignal,
  ): Promise<ArchiveExecution> {
    throwIfAborted(signal);
    const text = requiredText(rawText, "text");
    const memoryRevision = this.#store.getMemoryContextRevision();
    const candidates = this.#candidates(focusBucketId);
    const raw = await withCancellation(signal, () =>
      this.#model.classify(text, candidates, signal),
    );
    this.#assertMemoryRevision(memoryRevision);
    const classification = postprocessClassification(
      text,
      raw,
      candidates,
      this.#policy,
    );
    const rawExtraction =
      classification.action === "ask_user"
        ? undefined
        : await withCancellation(signal, () =>
            this.#model.extract(text, signal),
          );
    const extraction =
      rawExtraction === undefined
        ? undefined
        : enrichAutoTodoExtraction(
            text,
            classification.bucketType,
            rawExtraction,
          );
    this.#assertMemoryRevision(memoryRevision);
    return this.#execute(text, classification, extraction, candidates, {
      focusBucketId,
      signal,
    });
  }

  #assertMemoryRevision(revision: number): void {
    if (revision !== this.#store.getMemoryContextRevision()) {
      throw new StorageError(
        "memory_context_changed",
        "记忆已更新，此次归档未执行，请重新提交。",
      );
    }
  }

  async appendConfirmed(
    rawText: string,
    bucketId: string,
    focusBucketId?: string,
    signal?: AbortSignal,
  ): Promise<ArchiveExecution> {
    throwIfAborted(signal);
    const text = requiredText(rawText, "text");
    const target = this.#requireActiveBucket(bucketId);
    return this.#confirmUserAction(
      text,
      {
        action: "append",
        targetBucketId: target.id,
        ...(focusBucketId === undefined ? {} : { focusBucketId }),
      },
      signal,
    );
  }

  async createConfirmed(
    rawText: string,
    title: string,
    bucketType: BucketType,
    focusBucketId?: string,
    signal?: AbortSignal,
  ): Promise<ArchiveExecution> {
    throwIfAborted(signal);
    const text = requiredText(rawText, "text");
    return this.#confirmUserAction(
      text,
      {
        action: "create",
        title: requiredText(title, "title"),
        bucketType,
        ...(focusBucketId === undefined ? {} : { focusBucketId }),
      },
      signal,
    );
  }

  async #confirmUserAction(
    text: string,
    choice:
      | {
          readonly action: "append";
          readonly targetBucketId: string;
          readonly focusBucketId?: string;
        }
      | {
          readonly action: "create";
          readonly title: string;
          readonly bucketType: BucketType;
          readonly focusBucketId?: string;
        },
    signal?: AbortSignal,
  ): Promise<ArchiveExecution> {
    throwIfAborted(signal);
    const candidates = this.#candidates(choice.focusBucketId);
    // Extract before registering a one-shot explicit choice. A model failure
    // must not leave an invisible pending proposal with no recovery card.
    const extraction = await withCancellation(signal, () =>
      this.#model.extract(text, signal),
    );
    const pending = this.#execute(
      text,
      askUser(
        undefined,
        undefined,
        1,
        "用户提交了明确的归档选择。",
        "等待执行用户选择。",
        candidates.map(({ id }) => id),
      ),
      undefined,
      candidates,
      { focusBucketId: choice.focusBucketId, proposedBy: "user", signal },
    );
    let execution: ConfirmationExecution;
    try {
      execution = await this.#confirm(
        { ...choice, attemptId: pending.result.attemptId, rawText: text },
        signal,
        extraction,
      );
    } catch (error: unknown) {
      // A one-shot explicit request has no durable UI card. Retain rejected
      // audit instead of leaving an inaccessible pending action on failure.
      throwIfAborted(signal);
      if (isAbortError(error)) throw abortError();
      this.#store.discardArchiveAttempt(pending.result.attemptId, text);
      throw error;
    }
    if (execution.result.archiveState === "discarded") {
      throw StorageError.invalidWrite("confirmation", "unexpected discard");
    }
    return { ...execution, result: execution.result };
  }

  async confirm(
    request: RuntimeConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<ConfirmationExecution> {
    return this.#confirm(request, signal);
  }

  async #confirm(
    request: RuntimeConfirmationRequest,
    signal?: AbortSignal,
    preparedExtraction?: ExtractionResult,
  ): Promise<ConfirmationExecution> {
    throwIfAborted(signal);
    const attempt = this.#requirePendingAttempt(
      request.attemptId,
      request.rawText,
    );
    const candidates = attempt.candidateBucketIds
      .map((id) => this.#store.getBucket(id))
      .filter((bucket): bucket is BucketRow => bucket !== undefined)
      .map(toBucketView);

    if (request.action === "discard") {
      throwIfAborted(signal);
      return {
        result: this.#service.confirm({
          action: "discard",
          attemptId: attempt.id,
          rawText: request.rawText,
        }),
        candidates,
        bucket: undefined,
      };
    }

    let targetBucketType: BucketType | undefined;
    if (request.action === "append") {
      targetBucketType = this.#requireActiveBucket(request.targetBucketId).kind;
    } else {
      targetBucketType = request.bucketType;
    }
    const rawExtraction =
      preparedExtraction ??
      (await withCancellation(signal, () =>
        this.#model.extract(request.rawText, signal),
      ));
    const extraction = enrichAutoTodoExtraction(
      request.rawText,
      targetBucketType,
      rawExtraction,
    );
    let result: ArchiveResult;
    if (request.action === "append") {
      throwIfAborted(signal);
      result = this.#service.confirm({
        action: "append",
        attemptId: attempt.id,
        rawText: request.rawText,
        targetBucketId: request.targetBucketId,
        ...(request.focusBucketId === undefined
          ? {}
          : { focusBucketId: request.focusBucketId }),
        extraction,
        confidence: attempt.confidence,
        reason: attempt.reason,
        modelName: attempt.modelName,
      });
    } else {
      throwIfAborted(signal);
      result = this.#service.confirm({
        action: "create",
        attemptId: attempt.id,
        rawText: request.rawText,
        title: request.title,
        bucketType: request.bucketType,
        ...(request.focusBucketId === undefined
          ? {}
          : { focusBucketId: request.focusBucketId }),
        extraction,
        confidence: attempt.confidence,
        reason: attempt.reason,
        modelName: attempt.modelName,
      });
    }
    return {
      result,
      candidates,
      bucket:
        result.bucketId === undefined
          ? undefined
          : this.#store.getBucket(result.bucketId),
    };
  }

  #execute(
    text: string,
    classification: ClassificationResult,
    extraction: ExtractionResult | undefined,
    candidates: readonly BucketView[],
    options: {
      readonly focusBucketId: string | undefined;
      readonly proposedBy?: "user" | "model";
      readonly signal?: AbortSignal | undefined;
    },
  ): ArchiveExecution {
    throwIfAborted(options.signal);
    const result = this.#service.archiveClassifiedInput(
      text,
      classification,
      extraction,
      {
        candidateBucketIds: candidates.map((candidate) => candidate.id),
        proposedBy: options.proposedBy ?? "model",
        focusBucketId: options.focusBucketId,
        promptVersion: RUNTIME_PROMPT_VERSION,
        modelName: this.#model.modelName,
      },
    );
    return {
      result,
      candidates,
      bucket:
        result.bucketId === undefined
          ? undefined
          : this.#store.getBucket(result.bucketId),
    };
  }

  #candidates(focusBucketId?: string): BucketView[] {
    const rows = [
      ...this.#store.listActiveBuckets(DEFAULT_ACTIVE_BUCKET_LIMIT),
      ...this.#store.listPopularActiveBuckets(DEFAULT_ACTIVE_BUCKET_LIMIT),
    ];
    return buildBucketCandidates(
      rows.map(toBucketView),
      focusBucketId,
      DEFAULT_ACTIVE_BUCKET_LIMIT,
    );
  }

  #requireActiveBucket(bucketId: string): BucketRow {
    const id = requiredText(bucketId, "bucket_id");
    const bucket = this.#store.getBucket(id);
    if (bucket === undefined) throw StorageError.missingRecord("buckets", id);
    if (bucket.lifecycle !== BucketStatus.Active) {
      throw StorageError.inactiveBucket(id);
    }
    return bucket;
  }

  #requirePendingAttempt(attemptId: string, rawText: string) {
    return this.#store.requirePendingArchiveAttempt(
      requiredText(attemptId, "attempt_id"),
      rawText,
    );
  }
}

export function toBucketView(bucket: BucketRow): BucketView {
  return createBucketView({
    id: bucket.id,
    title: bucket.title,
    bucketType: bucket.kind,
    status: bucket.lifecycle,
    summary: bucket.summary,
    tags: bucket.tags,
    lastActiveAtUnixMs: Date.parse(bucket.lastActiveAt),
  });
}

function enrichAutoTodoExtraction(
  text: string,
  bucketType: BucketType | undefined,
  extraction: ExtractionResult,
): ExtractionResult {
  if (extraction.todos.length > 0) return extraction;
  const plan = parseNaturalTodoPlan(text, new Date());
  if (!shouldAutoPromoteTodo(text, bucketType, plan)) return extraction;
  return createExtraction({
    summary: extraction.summary,
    todos: [text],
    evidences: [...extraction.evidences],
    timelineEvents: [...extraction.timelineEvents],
    decisions: [...extraction.decisions],
    hypotheses: [...extraction.hypotheses],
    entities: [...extraction.entities],
    tags: [...extraction.tags],
  });
}

function projectCandidate(candidate: BucketView) {
  return {
    id: candidate.id,
    title: candidate.title,
    bucket_type: candidate.bucketType,
    status: candidate.status,
    summary: candidate.summary,
    tags: [...candidate.tags],
    last_active_at_unix_ms: candidate.lastActiveAtUnixMs,
  } as const;
}
