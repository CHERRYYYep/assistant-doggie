/** Application orchestration for archive and explicit confirmation writes. */

import {
  appendExisting,
  createNew,
  type ClassificationResult,
} from "../domain/classification.ts";
import { requiredText } from "../domain/errors.ts";
import type { ExtractionResult } from "../domain/memory.ts";
import type { BucketType } from "../domain/types.ts";
import {
  Store,
  type ArchiveAudit,
  type ArchiveOutcome,
  type ChatMessageInput,
} from "../storage/store.ts";

export const CLASSIFICATION_PROMPT_VERSION = "classification-v2";

export type ApplicationErrorKind =
  "missing_extraction" | "unexpected_extraction" | "invalid_confirmation";

export class ApplicationError extends Error {
  readonly kind: ApplicationErrorKind;

  constructor(kind: ApplicationErrorKind, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.kind = kind;
  }
}

export type ArchiveResult = ArchiveOutcome & {
  readonly action: ClassificationResult["action"];
  readonly bucketTitle: string | undefined;
  readonly bucketType: BucketType | undefined;
  readonly confidence: number;
  readonly reason: string;
  readonly question: string | undefined;
  readonly candidateBucketIds: readonly string[];
  readonly extraction: ExtractionResult | undefined;
  readonly sourceAttemptId: string | undefined;
};

export type ConfirmationRequest =
  | {
      readonly action: "append" | "append_alternative";
      readonly attemptId: string;
      readonly rawText: string;
      readonly targetBucketId: string;
      readonly focusBucketId?: string;
      readonly extraction: ExtractionResult;
      readonly confidence?: number;
      readonly reason?: string;
      readonly modelName: string;
    }
  | {
      readonly action: "create";
      readonly attemptId: string;
      readonly rawText: string;
      readonly title: string;
      readonly bucketType: BucketType;
      readonly focusBucketId?: string;
      readonly extraction: ExtractionResult;
      readonly confidence?: number;
      readonly reason?: string;
      readonly modelName: string;
    }
  | {
      readonly action: "discard";
      readonly attemptId: string;
      readonly rawText: string;
    };

export type DiscardResult = {
  readonly archiveState: "discarded";
  readonly sourceAttemptId: string;
  readonly resultAttemptId: undefined;
};

export class ArchiveService {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  archiveClassifiedInput(
    rawText: string,
    classification: ClassificationResult,
    extraction: ExtractionResult | undefined,
    audit: ArchiveAudit,
    messageForResult?: (result: ArchiveResult) => ChatMessageInput,
  ): ArchiveResult {
    const text = requiredText(rawText, "text");
    if (audit.confirmationAttemptId !== undefined) {
      this.#store.requirePendingArchiveAttempt(
        audit.confirmationAttemptId,
        rawText,
      );
    }
    if (classification.action === "ask_user" && extraction !== undefined) {
      throw new ApplicationError(
        "unexpected_extraction",
        "ask_user archive must not include extraction",
      );
    }
    if (classification.action !== "ask_user" && extraction === undefined) {
      throw new ApplicationError(
        "missing_extraction",
        `${classification.action} requires extraction`,
      );
    }
    const projectResult = (outcome: ArchiveOutcome): ArchiveResult => ({
      ...outcome,
      action: classification.action,
      // Proposed fields describe only a possible new Bucket. Existing Bucket
      // metadata is projected separately by the HTTP/runtime boundary.
      bucketTitle: classification.title,
      bucketType: classification.bucketType,
      confidence: classification.confidence,
      reason: classification.reason,
      question: classification.question,
      candidateBucketIds: classification.candidateBucketIds,
      extraction,
      sourceAttemptId: audit.confirmationAttemptId,
    });
    let result: ArchiveResult | undefined;
    const outcome = this.#store.archive(
      text,
      classification,
      extraction,
      audit,
      messageForResult === undefined
        ? undefined
        : (outcome) => {
            result = projectResult(outcome);
            return messageForResult(result);
          },
    );
    return result ?? projectResult(outcome);
  }

  confirm(
    request: Extract<ConfirmationRequest, { readonly action: "discard" }>,
  ): DiscardResult;
  confirm(
    request: Exclude<ConfirmationRequest, { readonly action: "discard" }>,
  ): ArchiveResult;
  confirm(request: ConfirmationRequest): ArchiveResult | DiscardResult {
    const attemptId = requiredText(request.attemptId, "attempt_id");
    requiredText(request.rawText, "text");
    const rawText = request.rawText;
    this.#store.requirePendingArchiveAttempt(attemptId, rawText);
    if (request.action === "discard") {
      this.#store.discardArchiveAttempt(attemptId, rawText);
      return {
        archiveState: "discarded",
        sourceAttemptId: attemptId,
        resultAttemptId: undefined,
      };
    }

    const confidence = request.confidence ?? 1;
    const auditBase = {
      promptVersion: CLASSIFICATION_PROMPT_VERSION,
      modelName: requiredText(request.modelName, "model_name"),
      confirmationAttemptId: attemptId,
    } as const;

    if (
      request.action === "append" ||
      request.action === "append_alternative"
    ) {
      const targetBucketId = requiredText(
        request.targetBucketId,
        "target_bucket_id",
      );
      return this.archiveClassifiedInput(
        rawText,
        appendExisting(
          targetBucketId,
          undefined,
          confidence,
          request.reason ?? "用户明确确认目标 Bucket。",
        ),
        request.extraction,
        {
          ...auditBase,
          candidateBucketIds: [targetBucketId],
          focusBucketId: request.focusBucketId ?? targetBucketId,
        },
      );
    }

    if (request.action === "create") {
      return this.archiveClassifiedInput(
        rawText,
        createNew(
          request.bucketType,
          request.title,
          confidence,
          request.reason ?? "用户明确确认创建新 Bucket。",
        ),
        request.extraction,
        {
          ...auditBase,
          candidateBucketIds: [],
          focusBucketId: request.focusBucketId,
        },
      );
    }

    throw new ApplicationError(
      "invalid_confirmation",
      "unsupported confirmation action",
    );
  }
}
