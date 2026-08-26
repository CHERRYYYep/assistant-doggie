import { test } from "node:test";

import { snapshotStorage } from "../../tests/storage-parity-snapshot.ts";
import assert from "node:assert/strict";

import { createExtraction } from "../domain/memory.ts";
import { BucketStatus, BucketType } from "../domain/types.ts";
import { openDatabase } from "../storage/database.ts";
import {
  Store,
  type ArchiveAudit,
  type ArchiveDecision,
} from "../storage/store.ts";
import {
  createStructuredFieldFilter,
  createTimeRange,
  parseMemoryQuery,
  withMemoryQueryOverrides,
} from "./memory-query.ts";
import { MemoryQueryService } from "./query.ts";

const AUDIT: ArchiveAudit = {
  candidateBucketIds: [],
  promptVersion: "query-test-v1",
  modelName: "fixture-model",
};
const NOW = new Date("2026-08-24T12:00:00.000Z");

function decision(title: string): ArchiveDecision {
  return {
    action: "create_new",
    bucketId: undefined,
    bucketType: BucketType.Experiment,
    title,
    confidence: 0.99,
    reason: "query fixture",
    question: undefined,
  };
}

function appendDecision(bucketId: string): ArchiveDecision {
  return {
    action: "append_existing",
    bucketId,
    bucketType: BucketType.Experiment,
    title: undefined,
    confidence: 0.98,
    reason: "query fixture append",
    question: undefined,
  };
}

function extraction(
  summary: string,
  evidence: string,
  tag: string,
  hypotheses: readonly string[] = [],
) {
  return createExtraction({
    summary,
    evidences: [evidence],
    hypotheses,
    entities: ["接口 A"],
    tags: [tag],
    timelineEvents: [{ text: "业务发生时间", occurredAt: "2020-01-01" }],
  });
}

function setup() {
  let tick = 0;
  const store = new Store(
    openDatabase(":memory:"),
    () => new Date(NOW.getTime() - 60_000 + tick++ * 1_000),
  );
  return { store, service: new MemoryQueryService(store, () => NOW) };
}

test("returns Entry hits across Buckets with grouped and de-duplicated evidence", () => {
  const { store, service } = setup();
  const first = store.archive(
    "接口 A 首轮压测完成，P99 为 120ms。",
    decision("接口 A 压测"),
    extraction("接口 A 压测结果：P99 为 120ms。", "Straße STATUS", "压测", [
      "ı marker",
    ]),
    AUDIT,
  );
  store.archive(
    "接口 A 第二轮压测完成，P99 为 110ms。",
    appendDecision(first.bucketId!),
    extraction("接口 A 压测结果：P99 为 110ms。", "STRASSE status", "压测", [
      "i marker",
    ]),
    AUDIT,
  );
  store.archive(
    "接口 A 回归测试发现无错误。",
    decision("接口 A 回归"),
    extraction("接口 A 压测回归结果：无错误。", "strasse STATUS", "回归", [
      "STRASSE status",
    ]),
    AUDIT,
  );

  const response = service.search("查询接口 A 最近两周的压测结果", 20);
  assert.equal(response.results.length, 3);
  assert.equal(response.buckets.length, 2);
  const foldedEvidence = response.evidence.filter(
    (memory) =>
      memory.text.trim().toUpperCase().replace("ẞ", "SS").replace("ß", "SS") ===
      "STRASSE STATUS",
  );
  assert.equal(
    foldedEvidence.filter((memory) => memory.kind === "evidence").length,
    1,
  );
  assert.equal(
    foldedEvidence.filter((memory) => memory.kind === "hypothesis").length,
    1,
  );
  assert.deepEqual(
    response.evidence
      .filter(
        (memory) =>
          memory.kind === "hypothesis" && memory.text.endsWith(" marker"),
      )
      .map((memory) => memory.text)
      .sort(),
    ["i marker", "ı marker"],
  );
  assert.match(response.answer, /找到 3 条相关 Entry，涉及 2 个 Bucket/);
  assert.ok(response.results.every((hit) => hit.lexicalSimilarity > 0));
  assert.ok(
    response.results.every((hit) => !Object.hasOwn(hit, "semanticScore")),
  );
});

test("uses Entry.created_at with half-open bounds, never memory occurred_at", () => {
  const { store, service } = setup();
  const fixtures = [
    ["before", "2026-07-31T23:59:59.999Z", "2026-08-01T12:00:00.000Z"],
    ["at-start", "2026-08-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"],
    ["before-end", "2026-08-01T23:59:59.999Z", "2099-01-01T00:00:00.000Z"],
    ["at-end", "2026-08-02T00:00:00.000Z", "2026-08-01T12:00:00.000Z"],
  ] as const;
  const ids = new Map<string, string>();
  for (const [label, createdAt, occurredAt] of fixtures) {
    const outcome = store.archive(
      `边界压测 ${label}`,
      decision(`边界 ${label}`),
      extraction(`边界压测 ${label}`, label, "边界"),
      AUDIT,
    );
    ids.set(label, outcome.entryId!);
    store.database
      .prepare("UPDATE entries SET created_at = ? WHERE id = ?")
      .run(createdAt, outcome.entryId!);
    store.database
      .prepare("UPDATE memory_items SET occurred_at = ? WHERE entry_id = ?")
      .run(occurredAt, outcome.entryId!);
  }

  const plan = withMemoryQueryOverrides(parseMemoryQuery("边界压测", 10, NOW), {
    timeRange: createTimeRange("2026-08-01", "2026-08-02", "一天"),
  });
  const response = service.searchWithPlan(plan, NOW);
  assert.deepEqual(
    new Set(response.results.map((hit) => hit.entry.id)),
    new Set([ids.get("at-start"), ids.get("before-end")]),
  );
});

test("applies lifecycle and every structured filter dimension", () => {
  const { store, service } = setup();
  const outcome = store.archive(
    "接口 A 质量压测",
    decision("接口 A 质量"),
    extraction("压测结果摘要", "证据", "性能"),
    AUDIT,
  );
  store.setBucketStatus(outcome.bucketId!, BucketStatus.Archived);
  store.database
    .prepare(
      "UPDATE memory_items SET metadata_json = ? WHERE entry_id = ? AND kind = 'evidence'",
    )
    .run(JSON.stringify([{ metrics: { region: "华东-1" } }]), outcome.entryId!);

  const base = parseMemoryQuery("质量", 10, NOW);
  const filters = [
    createStructuredFieldFilter("status", "archived"),
    createStructuredFieldFilter("kind", "experiment"),
    createStructuredFieldFilter("content_type", "note"),
    createStructuredFieldFilter("entity", "接口 A"),
    createStructuredFieldFilter("tag", "性能"),
    createStructuredFieldFilter("source", "LLM"),
    createStructuredFieldFilter("region", "华东"),
  ];
  const plan = withMemoryQueryOverrides(base, {
    statuses: [BucketStatus.Archived],
    structuredFilters: filters,
  });
  assert.equal(service.searchWithPlan(plan, NOW).results.length, 1);

  const activeOnly = withMemoryQueryOverrides(base, {
    statuses: [BucketStatus.Active],
  });
  assert.equal(service.searchWithPlan(activeOnly, NOW).results.length, 0);
});

test("query projection is deterministic, sorted, limited, and read-only", () => {
  const { store, service } = setup();
  store.archive(
    "排序查询 old",
    decision("排序 old"),
    extraction("排序查询 old", "old", "排序"),
    AUDIT,
  );
  store.archive(
    "排序查询 newest",
    decision("排序 newest"),
    extraction("排序查询 newest", "newest", "排序"),
    AUDIT,
  );
  store.appendChatMessage({ role: "user", content: "查询前消息" });
  const before = snapshotStorage(store.database);
  const bucketsBefore = store.listBuckets();

  const first = service.search("排序查询", 1);
  const second = service.search("排序查询", 1);
  assert.deepEqual(second, first);
  assert.equal(first.results.length, 1);
  assert.match(first.answer, /^找到 1 条相关 Entry/);
  assert.deepEqual(snapshotStorage(store.database), before);
  assert.deepEqual(store.listBuckets(), bucketsBefore);

  const empty = service.search("不存在的关键词", 10);
  assert.equal(empty.answer, "没有找到与「不存在的关键词」匹配的记忆。");
});

test("lexical similarity and tie-breaking are stable and deterministic", () => {
  const { store, service } = setup();
  const exact = store.archive(
    "alpha beta",
    decision("lexical"),
    extraction("alpha beta", "exact", "lexical"),
    AUDIT,
  );
  const partial = store.archive(
    "alpha only",
    decision("partial lexical"),
    extraction("alpha only", "partial", "lexical"),
    AUDIT,
  );

  const ranked = service.search("alpha beta", 10);
  const exactHit = ranked.results.find(
    (hit) => hit.entry.id === exact.entryId,
  )!;
  const partialHit = ranked.results.find(
    (hit) => hit.entry.id === partial.entryId,
  )!;
  assert.equal(exactHit.lexicalSimilarity, 1);
  assert.equal(partialHit.lexicalSimilarity, 0.5);
  assert.ok(exactHit.score > partialHit.score);

  store.database
    .prepare("UPDATE buckets SET title = 'lexical' WHERE id IN (?, ?)")
    .run(exact.bucketId!, partial.bucketId!);
  store.database
    .prepare(
      "UPDATE entries SET raw_text = ?, summary = ?, created_at = ? WHERE id IN (?, ?)",
    )
    .run(
      "tie query",
      "相同摘要",
      "2026-08-24T00:00:00.000Z",
      exact.entryId!,
      partial.entryId!,
    );
  const tied = service.search("tie query", 10);
  const expectedIds = [exact.entryId!, partial.entryId!].sort();
  assert.deepEqual(
    tied.results.map((hit) => hit.entry.id),
    expectedIds,
  );
  assert.equal(
    tied.answer,
    "找到 2 条相关 Entry，涉及 2 个 Bucket。\n" +
      "- 「lexical」：相同摘要\n" +
      "- 「lexical」：相同摘要",
  );
});
