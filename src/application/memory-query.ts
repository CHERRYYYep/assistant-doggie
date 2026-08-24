/**
 * Deterministic natural-language memory query planning.
 *
 * This ports the canonical Rust query parser without introducing an LLM into
 * the read path. Relative time is resolved against an injectable UTC clock so
 * callers and tests can hold one stable query snapshot.
 */

import { unicodeCaseFold } from "../domain/text.ts";
import { BucketStatus, type BucketStatus as BucketStatusValue } from "../domain/types.ts";

export const MAX_QUERY_CHARACTERS = 500;
export const MAX_STRUCTURED_FILTERS = 16;

export type MemoryQueryErrorKind =
  | "empty_query"
  | "query_too_long"
  | "invalid_limit"
  | "invalid_time_range"
  | "invalid_structured_filter"
  | "too_many_structured_filters";

export class MemoryQueryError extends Error {
  readonly kind: MemoryQueryErrorKind;

  constructor(kind: MemoryQueryErrorKind, message: string) {
    super(message);
    this.name = "MemoryQueryError";
    this.kind = kind;
  }
}

export type TimeRange = {
  readonly start: Date;
  readonly end: Date;
  readonly label: string;
};

export function createTimeRange(
  start: Date | string,
  end: Date | string,
  label: string,
): TimeRange {
  const parsedStart = parseTimestamp(start);
  const parsedEnd = parseTimestamp(end);
  if (parsedStart.getTime() >= parsedEnd.getTime()) {
    throw new MemoryQueryError(
      "invalid_time_range",
      "time range start must be before end",
    );
  }
  return { start: parsedStart, end: parsedEnd, label: label.trim() };
}

export type StructuredFieldFilter = {
  readonly field: string;
  readonly value: string;
};

export function createStructuredFieldFilter(
  field: string,
  value: string,
): StructuredFieldFilter {
  const normalizedField = field.trim();
  const normalizedValue = value.trim();
  if (normalizedField === "" || normalizedValue === "") {
    throw new MemoryQueryError(
      "invalid_structured_filter",
      "structured filter field and value must not be empty",
    );
  }
  return { field: normalizedField, value: normalizedValue };
}

export type MemoryQueryPlan = {
  readonly rawText: string;
  readonly terms: readonly string[];
  readonly entityTerms: readonly string[];
  readonly topicTerms: readonly string[];
  readonly bucketTerms: readonly string[];
  readonly timeRange: TimeRange | undefined;
  readonly statuses: readonly BucketStatusValue[];
  readonly structuredFilters: readonly StructuredFieldFilter[];
  readonly limit: number;
};

export type MemoryQueryOverrides = {
  readonly timeRange?: TimeRange | undefined;
  readonly statuses?: readonly BucketStatusValue[] | undefined;
  readonly structuredFilters?: readonly StructuredFieldFilter[] | undefined;
};

export function parseMemoryQuery(
  text: string,
  limit: number,
  now: Date = new Date(),
): MemoryQueryPlan {
  const rawText = text.trim();
  if (rawText === "") {
    throw new MemoryQueryError("empty_query", "memory query must not be empty");
  }
  if ([...rawText].length > MAX_QUERY_CHARACTERS) {
    throw new MemoryQueryError(
      "query_too_long",
      `memory query exceeds ${MAX_QUERY_CHARACTERS} characters`,
    );
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new MemoryQueryError(
      "invalid_limit",
      "memory query limit must be a positive integer",
    );
  }
  if (!Number.isFinite(now.getTime())) {
    throw new MemoryQueryError("invalid_time_range", "query clock is invalid");
  }

  const time = parseRelativeTime(rawText, now);
  const status = parseStatuses(time.residual);
  let residual = stripQueryPrefix(status.residual)
    .replaceAll("的", " ")
    .replace(/[，。？?!！,:：]/gu, " ");

  const entityTerms = extractEntityTerms(residual);
  for (const entity of entityTerms) residual = residual.replaceAll(entity, " ");
  const topicTerms = meaningfulTerms(residual);
  const terms = dedupeTerms([...entityTerms, ...topicTerms]);

  return {
    rawText,
    terms,
    entityTerms,
    topicTerms,
    bucketTerms: [...terms],
    timeRange: time.timeRange,
    statuses: status.statuses,
    structuredFilters: [],
    limit,
  };
}

export function withMemoryQueryOverrides(
  plan: MemoryQueryPlan,
  overrides: MemoryQueryOverrides,
): MemoryQueryPlan {
  const filters = overrides.structuredFilters ?? plan.structuredFilters;
  if (filters.length > MAX_STRUCTURED_FILTERS) {
    throw new MemoryQueryError(
      "too_many_structured_filters",
      `memory query has more than ${MAX_STRUCTURED_FILTERS} structured filters`,
    );
  }
  for (const filter of filters) {
    createStructuredFieldFilter(filter.field, filter.value);
  }
  return {
    ...plan,
    timeRange: overrides.timeRange ?? plan.timeRange,
    statuses:
      overrides.statuses === undefined
        ? plan.statuses
        : dedupeStatuses(overrides.statuses),
    structuredFilters: filters.map((filter) => ({
      field: filter.field.trim(),
      value: filter.value.trim(),
    })),
  };
}

export function queryHasConstraints(plan: MemoryQueryPlan): boolean {
  return (
    plan.timeRange !== undefined ||
    plan.statuses.length > 0 ||
    plan.structuredFilters.length > 0
  );
}

function parseTimestamp(value: Date | string): Date {
  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    if (Number.isFinite(copy.getTime())) return copy;
  } else {
    const trimmed = value.trim();
    const normalized = /^\d{4}-\d{2}-\d{2}$/u.test(trimmed)
      ? `${trimmed}T00:00:00.000Z`
      : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(trimmed)
        ? `${trimmed.replace(" ", "T")}Z`
        : trimmed;
    const parsed = new Date(normalized);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  throw new MemoryQueryError(
    "invalid_time_range",
    `invalid timestamp: ${String(value)}`,
  );
}

function parseRelativeTime(
  text: string,
  now: Date,
): { residual: string; timeRange: TimeRange | undefined } {
  const patterns: readonly [string, number][] = [
    ["最近两周", 14], ["过去两周", 14], ["近两周", 14],
    ["最近2周", 14], ["过去2周", 14], ["最近一周", 7],
    ["过去一周", 7], ["最近1周", 7], ["最近7天", 7],
    ["过去7天", 7], ["最近一个月", 30], ["过去一个月", 30],
    ["最近1个月", 30], ["最近30天", 30], ["过去30天", 30],
  ];
  for (const [phrase, days] of patterns) {
    if (!text.includes(phrase)) continue;
    return {
      residual: text.replaceAll(phrase, " "),
      timeRange: createTimeRange(
        new Date(now.getTime() - days * 86_400_000),
        now,
        phrase,
      ),
    };
  }
  return { residual: text, timeRange: undefined };
}

function parseStatuses(text: string): {
  residual: string;
  statuses: BucketStatusValue[];
} {
  let residual = text;
  const statuses: BucketStatusValue[] = [];
  const values: readonly [string, BucketStatusValue][] = [
    ["active", BucketStatus.Active], ["paused", BucketStatus.Paused],
    ["done", BucketStatus.Done], ["archived", BucketStatus.Archived],
    ["活跃", BucketStatus.Active], ["暂停", BucketStatus.Paused],
    ["已完成", BucketStatus.Done], ["完成", BucketStatus.Done],
    ["已归档", BucketStatus.Archived], ["归档", BucketStatus.Archived],
  ];
  for (const [phrase, status] of values) {
    if (!unicodeCaseFold(residual).includes(unicodeCaseFold(phrase))) continue;
    statuses.push(status);
    residual = /^[\x00-\x7f]+$/u.test(phrase)
      ? removeAsciiCaseInsensitive(residual, phrase)
      : residual.replaceAll(phrase, " ");
  }
  const deduped = dedupeStatuses(statuses);
  if (deduped.length > 0) {
    for (const phrase of ["状态为", "生命周期", "只看", "仅看", "状态", "并", "且"])
      residual = residual.replaceAll(phrase, " ");
    for (const phrase of ["status", "only", "show", "and"])
      residual = removeAsciiCaseInsensitive(residual, phrase);
  }
  return { residual, statuses: deduped };
}

function removeAsciiCaseInsensitive(text: string, needle: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.replace(new RegExp(escaped, "giu"), " ");
}

function stripQueryPrefix(text: string): string {
  let value = text.trim();
  for (const prefix of [
    "请帮我查询", "请帮我查一下", "帮我查询", "帮我查一下", "请查询",
    "查询", "查一下", "查找", "搜索", "查看", "找出", "找",
  ]) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  return value;
}

function extractEntityTerms(text: string): string[] {
  for (const marker of ["接口", "服务", "系统", "项目"]) {
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const phrase = text.slice(start).trim().split(/\s+/u).slice(0, 2).join(" ");
    if (phrase !== "") return dedupeTerms([phrase]);
  }
  return [];
}

function meaningfulTerms(text: string): string[] {
  const stopWords = new Set([
    "请", "帮我", "查询", "查", "一下", "看看", "关于", "有关", "最近",
    "过去", "的", "和", "与", "以及", "结果", "记录", "信息", "有哪些", "是什么",
  ]);
  const terms = text
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term !== "" && !stopWords.has(term));
  if (terms.length > 0) return dedupeTerms(terms);
  const fallback = text.trim();
  return fallback === "" ? [] : [fallback];
}

function dedupeTerms(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    const key = unicodeCaseFold(cleaned);
    if (cleaned !== "" && !seen.has(key)) {
      seen.add(key);
      output.push(cleaned);
    }
  }
  return output;
}

function dedupeStatuses(values: readonly BucketStatusValue[]): BucketStatusValue[] {
  return [...new Set(values)];
}
