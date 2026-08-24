/** Deterministic Entry-level memory retrieval, filtering, ranking and projection. */

import { unicodeCaseFold } from "../domain/text.ts";
import type {
  BucketRow,
  EntryRow,
  MemoryRow,
  QueryEntryCandidate,
  Store,
} from "../storage/store.ts";
import {
  parseMemoryQuery,
  queryHasConstraints,
  type MemoryQueryPlan,
  type StructuredFieldFilter,
} from "./memory-query.ts";

export type MemorySearchHit = {
  readonly bucket: BucketRow;
  readonly entry: EntryRow;
  readonly memories: readonly MemoryRow[];
  readonly matchedFields: readonly string[];
  readonly keywordScore: number;
  /** Lexical term-hit ratio. This is not an embedding or vector score. */
  readonly lexicalSimilarity: number;
  readonly score: number;
};

export type MemoryBucketGroup = {
  readonly bucket: BucketRow;
  readonly matchedEntryCount: number;
  readonly topScore: number;
};

export type MemorySearchResponse = {
  readonly query: MemoryQueryPlan;
  readonly results: readonly MemorySearchHit[];
  readonly buckets: readonly MemoryBucketGroup[];
  readonly evidence: readonly MemoryRow[];
  readonly answer: string;
};

export class MemoryQueryService {
  readonly #store: Store;
  readonly #clock: () => Date;

  constructor(store: Store, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#clock = clock;
  }

  search(text: string, limit: number): MemorySearchResponse {
    const now = this.#clock();
    return this.searchWithPlan(parseMemoryQuery(text, limit, now), now);
  }

  searchWithPlan(
    query: MemoryQueryPlan,
    now: Date = this.#clock(),
  ): MemorySearchResponse {
    const results: MemorySearchHit[] = [];
    for (const candidate of this.#store.searchEntryCandidates(query.terms)) {
      if (!matchesStatus(candidate, query)) continue;
      if (!inTimeRange(candidate.entry.createdAt, query)) continue;
      if (
        !query.structuredFilters.every((filter) =>
          matchesStructuredFilter(filter, candidate),
        )
      )
        continue;

      const scored = scoreCandidate(candidate, query, now);
      const hasLexicalMatch = scored.keywordScore > 0;
      const hasOnlyConstraints =
        query.terms.length === 0 && queryHasConstraints(query);
      if (!hasLexicalMatch && !hasOnlyConstraints) continue;
      results.push({
        ...candidate,
        matchedFields: scored.matchedFields,
        keywordScore: query.terms.length === 0 ? 1 : scored.keywordScore,
        lexicalSimilarity: scored.lexicalSimilarity,
        score:
          (query.terms.length === 0 ? 1 : scored.keywordScore) +
          Math.round(scored.lexicalSimilarity * 10) +
          recencyBonus(candidate.entry.createdAt, now),
      });
    }

    results.sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.entry.createdAt) - Date.parse(left.entry.createdAt) ||
        compareStrings(left.entry.id, right.entry.id),
    );
    results.splice(query.limit);

    const buckets = groupBuckets(results);
    return {
      query,
      results,
      buckets,
      evidence: dedupeEvidence(results),
      answer: buildAnswer(query, results, buckets),
    };
  }
}

function matchesStatus(
  candidate: QueryEntryCandidate,
  query: MemoryQueryPlan,
): boolean {
  return (
    query.statuses.length === 0 ||
    query.statuses.includes(candidate.bucket.lifecycle)
  );
}

function inTimeRange(createdAt: string, query: MemoryQueryPlan): boolean {
  if (query.timeRange === undefined) return true;
  const timestamp = Date.parse(createdAt);
  return (
    timestamp >= query.timeRange.start.getTime() &&
    timestamp < query.timeRange.end.getTime()
  );
}

function scoreCandidate(
  candidate: QueryEntryCandidate,
  query: MemoryQueryPlan,
  _now: Date,
): {
  keywordScore: number;
  lexicalSimilarity: number;
  matchedFields: string[];
} {
  let keywordScore = scoreBucket(candidate.bucket, query);
  const matchedFields: string[] = [];
  keywordScore += scoreField(
    matchedFields,
    "entry.raw_text",
    candidate.entry.rawText,
    query.terms,
    55,
  );
  if (candidate.entry.summary !== null) {
    keywordScore += scoreField(
      matchedFields,
      "entry.summary",
      candidate.entry.summary,
      query.topicTerms,
      42,
    );
  }
  for (const memory of candidate.memories) {
    keywordScore += scoreField(
      matchedFields,
      `memory.${memory.kind}`,
      memory.text,
      query.terms,
      24,
    );
    if (memory.kind === "entity") {
      keywordScore += scoreField(
        matchedFields,
        "memory.entity",
        memory.text,
        query.entityTerms,
        48,
      );
    }
    if (memory.kind === "tag") {
      keywordScore += scoreField(
        matchedFields,
        "memory.tag",
        memory.text,
        query.topicTerms,
        34,
      );
    }
  }
  return {
    keywordScore,
    lexicalSimilarity: lexicalSimilarity(candidate, query),
    matchedFields: [...new Set(matchedFields)].sort(),
  };
}

function scoreBucket(bucket: BucketRow, query: MemoryQueryPlan): number {
  let score = 0;
  const title = unicodeCaseFold(bucket.title);
  const summary = unicodeCaseFold(bucket.summary);
  for (const term of query.bucketTerms) {
    const folded = unicodeCaseFold(term);
    if (title === folded) score += 110;
    else if (title.includes(folded)) score += 65;
    if (summary.includes(folded)) score += 30;
    if (bucket.tags.some((tag) => unicodeCaseFold(tag).includes(folded)))
      score += 35;
  }
  return score;
}

function scoreField(
  matchedFields: string[],
  label: string,
  value: string,
  terms: readonly string[],
  weight: number,
): number {
  const foldedValue = unicodeCaseFold(value);
  let score = 0;
  for (const term of terms) {
    const foldedTerm = unicodeCaseFold(term);
    if (foldedTerm === "" || !foldedValue.includes(foldedTerm)) continue;
    score +=
      foldedValue === foldedTerm ? weight + Math.floor(weight / 2) : weight;
    matchedFields.push(label);
  }
  return score;
}

function matchesStructuredFilter(
  filter: StructuredFieldFilter,
  candidate: QueryEntryCandidate,
): boolean {
  const field = unicodeCaseFold(filter.field);
  const value = unicodeCaseFold(filter.value);
  const { bucket, entry, memories } = candidate;

  if (field === "status" || field === "状态") {
    return (
      unicodeCaseFold(bucket.lifecycle) === value ||
      memories.some(
        (memory) =>
          memory.status !== null && unicodeCaseFold(memory.status) === value,
      )
    );
  }
  if (field === "kind" || field === "类型") {
    return (
      unicodeCaseFold(bucket.kind) === value ||
      memories.some((memory) => unicodeCaseFold(memory.kind) === value)
    );
  }
  if (field === "content_type" || field === "内容类型") {
    return unicodeCaseFold(entry.contentType) === value;
  }
  if (field === "entity" || field === "实体") {
    return memories.some(
      (memory) =>
        memory.kind === "entity" &&
        unicodeCaseFold(memory.text).includes(value),
    );
  }
  if (field === "tag" || field === "标签") {
    return (
      bucket.tags.some((tag) => unicodeCaseFold(tag).includes(value)) ||
      memories.some(
        (memory) =>
          memory.kind === "tag" && unicodeCaseFold(memory.text).includes(value),
      )
    );
  }
  if (field === "source" || field === "来源") {
    return memories.some(
      (memory) =>
        memory.source !== null &&
        unicodeCaseFold(memory.source).includes(value),
    );
  }
  return memories.some((memory) =>
    metadataContains(memory.metadata, field, value),
  );
}

function metadataContains(
  value: unknown,
  field: string,
  expected: string,
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => metadataContains(item, field, expected));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (unicodeCaseFold(key) === field && scalarContains(item, expected)) ||
      metadataContains(item, field, expected),
  );
}

function scalarContains(value: unknown, expected: string): boolean {
  if (typeof value === "string")
    return unicodeCaseFold(value).includes(expected);
  return unicodeCaseFold(JSON.stringify(value)).includes(expected);
}

function lexicalSimilarity(
  candidate: QueryEntryCandidate,
  query: MemoryQueryPlan,
): number {
  if (query.terms.length === 0) return 0;
  const corpus = unicodeCaseFold(
    [
      candidate.bucket.title,
      candidate.bucket.summary,
      candidate.entry.rawText,
      candidate.entry.summary ?? "",
      ...candidate.memories.map((memory) => memory.text),
    ].join(" "),
  );
  const matched = query.terms.filter((term) =>
    corpus.includes(unicodeCaseFold(term)),
  ).length;
  const wholePhrase = unicodeCaseFold(query.terms.join(" "));
  return wholePhrase !== "" && corpus.includes(wholePhrase)
    ? 1
    : Math.min(1, Math.max(0, matched / query.terms.length));
}

function recencyBonus(createdAt: string, now: Date): number {
  const ageDays = Math.trunc(
    (now.getTime() - Date.parse(createdAt)) / 86_400_000,
  );
  return ageDays < 0 ? 10 : Math.min(10, Math.max(0, 10 - ageDays));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function groupBuckets(
  results: readonly MemorySearchHit[],
): MemoryBucketGroup[] {
  const groups = new Map<string, MemoryBucketGroup>();
  for (const result of results) {
    const existing = groups.get(result.bucket.id);
    groups.set(result.bucket.id, {
      bucket: result.bucket,
      matchedEntryCount: (existing?.matchedEntryCount ?? 0) + 1,
      topScore: Math.max(existing?.topScore ?? 0, result.score),
    });
  }
  return [...groups.values()].sort(
    (left, right) =>
      right.topScore - left.topScore ||
      compareStrings(left.bucket.id, right.bucket.id),
  );
}

function dedupeEvidence(results: readonly MemorySearchHit[]): MemoryRow[] {
  const seen = new Set<string>();
  const evidence: MemoryRow[] = [];
  for (const result of results) {
    for (const memory of result.memories) {
      const key = `${memory.kind}:${unicodeCaseFold(memory.text.trim())}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(memory);
    }
  }
  return evidence;
}

function buildAnswer(
  query: MemoryQueryPlan,
  results: readonly MemorySearchHit[],
  buckets: readonly MemoryBucketGroup[],
): string {
  if (results.length === 0) return `没有找到与「${query.rawText}」匹配的记忆。`;
  let answer = `找到 ${results.length} 条相关 Entry，涉及 ${buckets.length} 个 Bucket。`;
  for (const result of results.slice(0, 5)) {
    const snippet = [...(result.entry.summary ?? result.entry.rawText).trim()]
      .slice(0, 180)
      .join("");
    answer += `\n- 「${result.bucket.title}」：${snippet}`;
  }
  return answer;
}
