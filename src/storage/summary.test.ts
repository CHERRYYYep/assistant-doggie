import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SUMMARY_LIMIT,
  mergeBucketSummary,
  rebuildBucketSummary,
} from "./summary.ts";

/**
 * Ported from the Rust test
 * `rolling_summary_preserves_first_and_newest_fragments_with_a_bound`
 * (`crates/doggie-storage-sqlite/src/archive_write.rs`). See
 * `docs/INVARIANTS.md` §4.9.
 */
test("rolling summary preserves the first and newest fragments within a bound", () => {
  const existing = `first\n${"a".repeat(60)}\n${"b".repeat(60)}`;
  const merged = mergeBucketSummary(existing, "c".repeat(60), 130);

  assert.ok(merged.startsWith("first\n"), "the origin fragment is kept");
  assert.ok(
    !merged.includes("a".repeat(60)),
    "the oldest middle fragment is dropped",
  );
  assert.ok(
    merged.includes("b".repeat(60)),
    "the recent middle fragment survives",
  );
  assert.ok(merged.includes("c".repeat(60)), "the new fragment is appended");
  assert.ok([...merged].length <= 130, "the bound holds");
});

test("a repeated fragment does not evict the origin", () => {
  let summary = "接口 A 压测基线";
  for (let round = 0; round < 20; round += 1) {
    summary = mergeBucketSummary(summary, "  状态更新  ", 120);
  }
  assert.equal(summary, "接口 A 压测基线\n状态更新");
});

test("de-duplication uses the folded key, so casing and spacing do not slip through", () => {
  const summary = mergeBucketSummary(
    "Payments Down",
    "  payments   down  ",
    200,
  );
  assert.equal(summary, "Payments Down");
});

test("an empty fragment is ignored rather than appended as a blank line", () => {
  assert.equal(mergeBucketSummary("origin", "   ", 200), "origin");
  assert.equal(mergeBucketSummary("", "", 200), "");
});

test("summary truncation counts Unicode characters and marks the cut", () => {
  const summary = mergeBucketSummary(
    "接口压测结果非常长的一段中文摘要",
    "第二段",
    10,
  );
  assert.ok(
    [...summary].length <= 10,
    `got ${[...summary].length} characters: ${summary}`,
  );
  assert.ok(summary.endsWith("…"), "a truncated summary is marked");
});

test("truncation never splits a surrogate pair", () => {
  const summary = mergeBucketSummary("👍".repeat(20), "👎".repeat(20), 8);
  assert.ok([...summary].length <= 8);
  assert.ok(
    !summary.includes("�"),
    "no replacement character from a split pair",
  );
});

test("a summary already within the bound is returned unchanged", () => {
  const summary = mergeBucketSummary("first", "second", DEFAULT_SUMMARY_LIMIT);
  assert.equal(summary, "first\nsecond");
});

test("rebuild composes oldest-first and skips missing entry summaries", () => {
  const summary = rebuildBucketSummary(
    ["首次记录", null, "  ", "第二次记录", "首次记录"],
    200,
  );
  assert.equal(summary, "首次记录\n第二次记录");
});

test("rebuild of an empty bucket clears the summary", () => {
  assert.equal(rebuildBucketSummary([], 200), "");
  assert.equal(rebuildBucketSummary([null, "   "], 200), "");
});
