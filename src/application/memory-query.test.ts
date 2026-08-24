import { test } from "node:test";
import assert from "node:assert/strict";

import { BucketStatus } from "../domain/types.ts";
import {
  MAX_QUERY_CHARACTERS,
  MAX_STRUCTURED_FILTERS,
  MemoryQueryError,
  createStructuredFieldFilter,
  createTimeRange,
  parseMemoryQuery,
  queryHasConstraints,
  withMemoryQueryOverrides,
} from "./memory-query.ts";

test("parses entity, topic, relative UTC time, and lifecycle status", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const plan = parseMemoryQuery(
    "查询接口 A 最近两周的压测结果，并只看 ACTIVE 状态",
    20,
    now,
  );

  assert.deepEqual(plan.entityTerms, ["接口 A"]);
  assert.deepEqual(plan.topicTerms, ["压测结果"]);
  assert.deepEqual(plan.terms, ["接口 A", "压测结果"]);
  assert.deepEqual(plan.bucketTerms, plan.terms);
  assert.deepEqual(plan.statuses, [BucketStatus.Active]);
  assert.equal(plan.timeRange?.start.toISOString(), "2026-07-23T12:00:00.000Z");
  assert.equal(plan.timeRange?.end.toISOString(), "2026-08-06T12:00:00.000Z");
  assert.equal(plan.timeRange?.label, "最近两周");
});

test("recognizes archived explicitly and de-duplicates statuses case-insensitively", () => {
  const plan = parseMemoryQuery("查询接口 B archived 已归档 ARCHIVED 状态", 10);
  assert.deepEqual(plan.statuses, [BucketStatus.Archived]);
  assert.deepEqual(plan.entityTerms, ["接口 B"]);
});

test("accepts validated half-open ranges and structured overrides", () => {
  const base = parseMemoryQuery("质量", 10);
  const range = createTimeRange("2026-08-01", "2026-08-02", "一天");
  const plan = withMemoryQueryOverrides(base, {
    timeRange: range,
    statuses: [BucketStatus.Archived, BucketStatus.Archived],
    structuredFilters: [createStructuredFieldFilter(" tag ", " 性能 ")],
  });

  assert.equal(queryHasConstraints(plan), true);
  assert.equal(plan.timeRange?.start.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(plan.timeRange?.end.toISOString(), "2026-08-02T00:00:00.000Z");
  assert.deepEqual(plan.statuses, [BucketStatus.Archived]);
  assert.deepEqual(plan.structuredFilters, [{ field: "tag", value: "性能" }]);

  const cleared = withMemoryQueryOverrides(plan, { timeRange: undefined });
  assert.equal(cleared.timeRange, undefined);
});

test("parses only canonical UTC timestamp formats", () => {
  assert.equal(
    createTimeRange(
      "2026-08-24 12:34:56.789123",
      "2026-08-25",
      "sqlite",
    ).start.toISOString(),
    "2026-08-24T12:34:56.789Z",
  );
  assert.equal(
    createTimeRange(
      "2026-08-24T20:00:00+08:00",
      "2026-08-25T20:00:00+08:00",
      "offset",
    ).start.toISOString(),
    "2026-08-24T12:00:00.000Z",
  );

  for (const timestamp of [
    "08/24/2026",
    "2026-02-30",
    "2026-08-24T12:00:00",
    "2026-08-24T12:00:00+24:00",
  ]) {
    assert.throws(
      () => createTimeRange(timestamp, "2026-09-01", "invalid"),
      (error: unknown) =>
        error instanceof MemoryQueryError &&
        error.kind === "invalid_time_range",
    );
  }
});

test("rejects invalid query plans with typed errors", () => {
  const cases: readonly [() => unknown, MemoryQueryError["kind"]][] = [
    [() => parseMemoryQuery("  ", 10), "empty_query"],
    [
      () => parseMemoryQuery("界".repeat(MAX_QUERY_CHARACTERS + 1), 10),
      "query_too_long",
    ],
    [() => parseMemoryQuery("query", 0), "invalid_limit"],
    [
      () => createTimeRange("not-a-date", "2026-08-06", "bad"),
      "invalid_time_range",
    ],
    [
      () => createTimeRange("2026-08-07", "2026-08-06", "backwards"),
      "invalid_time_range",
    ],
    [() => createStructuredFieldFilter(" ", "x"), "invalid_structured_filter"],
    [
      () =>
        withMemoryQueryOverrides(parseMemoryQuery("x", 1), {
          structuredFilters: Array.from(
            { length: MAX_STRUCTURED_FILTERS + 1 },
            () => ({
              field: "tag",
              value: "x",
            }),
          ),
        }),
      "too_many_structured_filters",
    ],
  ];

  for (const [action, kind] of cases) {
    assert.throws(
      action,
      (error: unknown) =>
        error instanceof MemoryQueryError && error.kind === kind,
    );
  }
});
