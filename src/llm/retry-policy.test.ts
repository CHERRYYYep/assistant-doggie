import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRetryAfter, retryBackoffMs } from "./retry-policy.ts";

const now = Date.UTC(2026, 10, 19, 9, 0, 0);

test("Retry-After parses delay-seconds and all HTTP-date forms as bounded metadata", () => {
  for (const [header, expected] of [
    ["0", 0],
    [" 0002\t", 2_000],
    ["Thu, 19 Nov 2026 09:00:03 GMT", 3_000],
    ["Thursday, 19-Nov-26 09:00:03 GMT", 3_000],
    ["Thu Nov 19 09:00:03 2026", 3_000],
    ["Thu, 19 Nov 2026 08:59:59 GMT", 0],
    ["Thu Nov  5 09:00:03 2026", 0],
    ["Thu, 31 Dec 2026 23:59:60 GMT", Date.UTC(2027, 0, 1) - now],
  ] as const) {
    assert.equal(parseRetryAfter(header, now), expected, header);
  }
});

test("Retry-After rejects malformed dates and conservatively stops for unsafe delays", () => {
  for (const header of [
    null,
    "",
    "-1",
    "1.5",
    "1e3",
    "+1",
    "1, 2",
    "2026-11-19",
    "Thu, 19 Nov 2026 09:00:03 UTC",
    "Wed, 19 Nov 2026 09:00:03 GMT",
    "Thu, 31 Nov 2026 09:00:03 GMT",
    "Thu, 19 Nov 2026 24:00:00 GMT",
    "Thu, 19 Nov 2026 09:00:60 GMT",
    "private-retry-data",
  ]) {
    assert.equal(parseRetryAfter(header, now), undefined, String(header));
  }
  assert.equal(parseRetryAfter("9".repeat(128), now), "too_long");
  assert.equal(parseRetryAfter("9".repeat(129), now), "too_long");
  assert.equal(parseRetryAfter("9007199254741", now), "too_long");
  assert.equal(parseRetryAfter("9007199254740", now), 9_007_199_254_740_000);
});

test("retry delay doubles to the cap and adds only 0–250 ms jitter", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 2000].map((i) => retryBackoffMs(i, () => 0)),
    [500, 1000, 2000, 4000, 8000, 8000, 8000],
  );
  assert.equal(
    retryBackoffMs(1, () => 1 - Number.EPSILON),
    750,
  );
  assert.equal(
    retryBackoffMs(6, () => 1 - Number.EPSILON),
    8250,
  );
});
