/**
 * Domain vocabulary: Bucket types, lifecycle states, classification actions,
 * and the bounded Bucket projection used for candidate construction.
 *
 * These are `const` objects rather than TypeScript `enum`s because
 * `erasableSyntaxOnly` forbids enums — they emit runtime code and would break
 * `node src/main.ts`. The pattern below gives the same ergonomics: a value
 * namespace for construction and a union type for checking.
 */

import { DomainError, requiredText } from "./errors.ts";
import { normalizeStringList } from "./text.ts";

/** Long-lived work context categories, in stable display order. */
export const BucketType = {
  Idea: "idea",
  Task: "task",
  Incident: "incident",
  Experiment: "experiment",
  Decision: "decision",
  Meeting: "meeting",
  Knowledge: "knowledge",
  Draft: "draft",
} as const;
export type BucketType = (typeof BucketType)[keyof typeof BucketType];

export const BUCKET_TYPES: readonly BucketType[] = Object.values(BucketType);

export function isBucketType(value: unknown): value is BucketType {
  return (
    typeof value === "string" &&
    (BUCKET_TYPES as readonly string[]).includes(value)
  );
}

/** Bucket lifecycle values. */
export const BucketStatus = {
  Active: "active",
  Paused: "paused",
  Done: "done",
  Archived: "archived",
} as const;
export type BucketStatus = (typeof BucketStatus)[keyof typeof BucketStatus];

export const BUCKET_STATUSES: readonly BucketStatus[] =
  Object.values(BucketStatus);

export function isBucketStatus(value: unknown): value is BucketStatus {
  return (
    typeof value === "string" &&
    (BUCKET_STATUSES as readonly string[]).includes(value)
  );
}

/** Classifier actions accepted by the archive workflow. */
export const ClassificationAction = {
  AppendExisting: "append_existing",
  CreateNew: "create_new",
  AskUser: "ask_user",
} as const;
export type ClassificationAction =
  (typeof ClassificationAction)[keyof typeof ClassificationAction];

export const CLASSIFICATION_ACTIONS: readonly ClassificationAction[] =
  Object.values(ClassificationAction);

export function isClassificationAction(
  value: unknown,
): value is ClassificationAction {
  return (
    typeof value === "string" &&
    (CLASSIFICATION_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Bounded Bucket context used for candidate construction.
 *
 * The brand makes this constructible only through `createBucketView`, so a
 * value of this type is always normalized: id and title non-empty, summary
 * trimmed, tags de-duplicated.
 */
declare const bucketViewBrand: unique symbol;

/** The data of a `BucketView`, without the brand. */
type BucketViewFields = {
  readonly id: string;
  readonly title: string;
  readonly bucketType: BucketType;
  readonly status: BucketStatus;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly lastActiveAtUnixMs: number;
};

export type BucketView = BucketViewFields & {
  readonly [bucketViewBrand]: true;
};

export type BucketViewInput = {
  readonly id: string;
  readonly title: string;
  readonly bucketType: BucketType;
  readonly status: BucketStatus;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly lastActiveAtUnixMs: number;
};

export function createBucketView(input: BucketViewInput): BucketView {
  if (!Number.isFinite(input.lastActiveAtUnixMs)) {
    throw DomainError.inconsistentClassification(
      "last_active_at_unix_ms must be finite",
    );
  }
  // Checked as the unbranded shape, then widened once. The brand exists only
  // so a value of this type is proof that it came through this function.
  const fields: BucketViewFields = {
    id: requiredText(input.id, "bucket id"),
    title: requiredText(input.title, "bucket title"),
    bucketType: input.bucketType,
    status: input.status,
    summary: (input.summary ?? "").trim(),
    tags: normalizeStringList(input.tags ?? []),
    lastActiveAtUnixMs: input.lastActiveAtUnixMs,
  };
  return fields as BucketView;
}
