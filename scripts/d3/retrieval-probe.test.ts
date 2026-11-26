import assert from "node:assert/strict";
import { test } from "node:test";
import { RETRIEVAL_CASES, RETRIEVAL_SOURCES } from "./retrieval-fixtures.ts";
import { doggieRetrievalBaseline, rankScore } from "./retrieval-probe.ts";

test("retrieval scoring counts empty positives, missed targets and irrelevant negatives distinctly", () => {
  assert.deepEqual(rankScore(["a"], []), {
    recallAt5: 0,
    precisionAt5: 0,
    unexpected: [],
    negativePassed: null,
    top: [],
  });
  assert.deepEqual(rankScore(["a", "b"], ["a", "a", "x", "y", "z", "w", "b"]), {
    recallAt5: 0.5,
    precisionAt5: 0.2,
    unexpected: ["x", "y", "z", "w"],
    negativePassed: null,
    top: ["a", "x", "y", "z", "w"],
  });
  assert.equal(rankScore([], ["x"]).negativePassed, false);
  assert.equal(rankScore([], []).negativePassed, true);
});

test("fixed retrieval labels refer to live sources and Doggie's real query excludes the revoked source", () => {
  const activeIds = new Set<string>(
    RETRIEVAL_SOURCES.filter(({ active }) => active).map(({ id }) => id),
  );
  assert.equal(RETRIEVAL_SOURCES.length, 12);
  assert.equal(new Set(RETRIEVAL_CASES.map(({ id }) => id)).size, 16);
  for (const sample of RETRIEVAL_CASES) {
    assert.equal(sample.group === "negative", sample.expected.length === 0);
    assert.ok(sample.expected.every((id) => activeIds.has(id)));
  }
  const results = doggieRetrievalBaseline();
  assert.ok(
    results.every((row) => row.sourceIds.every((id) => activeIds.has(id))),
  );
  assert.deepEqual(results.find(({ id }) => id === "q13")?.sourceIds, []);
  assert.ok(results.find(({ id }) => id === "q02")?.sourceIds.includes("r03"));
});
