/** Explicit synthetic benchmark. Each run owns an in-memory database only. */
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { openDatabase, withTransaction } from "../src/storage/database.ts";
import { Store } from "../src/storage/store.ts";
import { MemoryQueryService } from "../src/application/query.ts";
import {
  parseMemoryQuery,
  withMemoryQueryOverrides,
} from "../src/application/memory-query.ts";

const layout = process.argv[2];
if (layout !== "single" && layout !== "multiple")
  throw new Error(
    "usage: node scripts/benchmark-memory-read.ts single|multiple",
  );
const bucketCount = layout === "single" ? 1 : 100;
const entryCount = 3_000;
const memoriesPerEntry = 6;
const repetitions = 9;
const now = new Date("2026-11-18T12:00:00.000Z");
const timestamp = now.toISOString();
const id = (prefix: string, index: number): string =>
  prefix + index.toString().padStart(5, "0");

using database = openDatabase(":memory:");
withTransaction(database, () => {
  const bucket = database.prepare(
    `INSERT INTO buckets (id,title,kind,lifecycle,summary,created_at,updated_at,last_active_at)
     VALUES (?,?,'task',?,?,?,?,?)`,
  );
  const tag = database.prepare("INSERT INTO bucket_tags VALUES (?,?,0)");
  const entry = database.prepare(
    `INSERT INTO entries (id,bucket_id,raw_text,created_at,archived_at,revoked_at)
     VALUES (?,?,?,?,?,?)`,
  );
  const memory = database.prepare(
    `INSERT INTO memory_items (id,bucket_id,entry_id,kind,text,created_at,updated_at,metadata_json)
     VALUES (?,?,?,'evidence',?,?,?,?)`,
  );
  for (let index = 0; index < bucketCount; index++) {
    const bucketId = id("bucket", index);
    bucket.run(
      bucketId,
      `fixture bucket ${index}`,
      index % 2 === 0 ? "active" : "archived",
      "synthetic group for memory retrieval",
      timestamp,
      timestamp,
      timestamp,
    );
    tag.run(bucketId, "fixture");
  }
  for (let index = 0; index < entryCount; index++) {
    const bucketId = id("bucket", index % bucketCount);
    const entryId = id("entry", index);
    const revoked = index % 10 === 0;
    entry.run(
      entryId,
      bucketId,
      `worklog item ${index} completed diagnostics for a synthetic workload`,
      timestamp,
      timestamp,
      revoked ? timestamp : null,
    );
    for (let ordinal = 0; ordinal < memoriesPerEntry; ordinal++) {
      memory.run(
        id("memory", index * memoriesPerEntry + ordinal),
        bucketId,
        entryId,
        revoked
          ? "withdrawn-only marker"
          : index % 101 === 1 && ordinal === 0
            ? "Straße"
            : "fixture measurement stable for integration workload",
        timestamp,
        timestamp,
        index % 3 === 0 ? '{"phase":"review"}' : '{"phase":"record"}',
      );
    }
  }
});

const store = new Store(database);
const search = new MemoryQueryService(store, () => now);
const cases = [
  { label: "miss", query: parseMemoryQuery("nonexistent-token", 12, now) },
  { label: "wide", query: parseMemoryQuery("worklog", 12, now) },
  { label: "unicode", query: parseMemoryQuery("STRASSE", 12, now) },
  { label: "revoked-only", query: parseMemoryQuery("withdrawn-only", 12, now) },
  {
    label: "filtered",
    query: withMemoryQueryOverrides(parseMemoryQuery("worklog", 12, now), {
      statuses: ["active"],
      structuredFilters: [{ field: "phase", value: "review" }],
    }),
  },
] as const;
function median(values: readonly number[]): number | undefined {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
const rows = [];
for (const scenario of cases) {
  const run = () => search.searchWithPlan(scenario.query, now);
  const expected = run(); // Warm up and record a fingerprint outside measurement.
  const hash = createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  const syncTimes: number[] = [];
  const loopWaits: number[] = [];
  for (let i = 0; i < repetitions; i++) {
    const started = performance.now();
    const loopWait = setImmediate().then(() => performance.now() - started);
    run();
    syncTimes.push(performance.now() - started);
    loopWaits.push(await loopWait);
  }
  rows.push({
    case: scenario.label,
    hits: expected.results.length,
    hash,
    syncMedianMs: median(syncTimes),
    loopWaitMedianMs: median(loopWaits),
    syncMaxMs: Math.max(...syncTimes),
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: platform(),
      arch: arch(),
      layout,
      buckets: bucketCount,
      entries: entryCount,
      memories: entryCount * memoriesPerEntry,
      repetitions,
      processPeakRssKiB: process.resourceUsage().maxRSS,
      rows,
    },
    null,
    2,
  ),
);
