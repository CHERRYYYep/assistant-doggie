/** L0 quality contrast using the actual Doggie query service and pinned Core BM25. */
import assert from "node:assert/strict";
import { MemoryQueryService } from "../../src/application/query.ts";
import { appendExisting, createNew } from "../../src/domain/classification.ts";
import { minimalExtraction } from "../../src/domain/memory.ts";
import { BucketType } from "../../src/domain/types.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { Store } from "../../src/storage/store.ts";
import { CoreClient, healthSchema, type Scope } from "./client.ts";
import {
  RETRIEVAL_CASES,
  RETRIEVAL_FIXTURE,
  RETRIEVAL_SOURCES,
  type RetrievalCase,
} from "./retrieval-fixtures.ts";
import { admitL0, type Binding } from "./source-guard.ts";

export function rankScore(
  expected: readonly string[],
  candidates: readonly string[],
) {
  const top = [...new Set(candidates)].slice(0, 5);
  const targets = new Set(expected);
  const hits = top.filter((id) => targets.has(id)).length;
  return {
    // Positive queries returning nothing count as zero precision, not as missing data.
    recallAt5: targets.size === 0 ? null : hits / targets.size,
    precisionAt5: targets.size === 0 ? null : hits / Math.max(1, top.length),
    unexpected: top.filter((id) => !targets.has(id)),
    negativePassed: targets.size === 0 ? top.length === 0 : null,
    top,
  };
}

type ScoredCase = {
  readonly queryId: string;
  readonly group: RetrievalCase["group"];
  readonly doggie: ReturnType<typeof rankScore>;
  readonly core: ReturnType<typeof rankScore>;
};
function summarize(rows: readonly ScoredCase[]) {
  const mean = (values: readonly (number | null)[]) => {
    const scored = values.filter((value): value is number => value !== null);
    return scored.length === 0
      ? null
      : Number((scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(4));
  };
  return Object.fromEntries(
    (
      ["all", "literal", "paraphrase", "disambiguation", "negative"] as const
    ).map((group) => {
      const subset = rows.filter(
        (row) => group === "all" || row.group === group,
      );
      return [
        group,
        Object.fromEntries(
          (["doggie", "core"] as const).map((engine) => {
            const scores = subset.map((row) => row[engine]);
            return [
              engine,
              {
                recallAt5: mean(scores.map((score) => score.recallAt5)),
                precisionAt5: mean(scores.map((score) => score.precisionAt5)),
                unexpectedAt5: scores.reduce(
                  (total, score) => total + score.unexpected.length,
                  0,
                ),
                negativePassed: scores.filter(
                  (score) => score.negativePassed === true,
                ).length,
                negativeTotal: scores.filter(
                  (score) => score.negativePassed !== null,
                ).length,
              },
            ];
          }),
        ),
      ];
    }),
  );
}

export function doggieRetrievalBaseline() {
  const db = openDatabase(":memory:");
  const time = Date.parse("2026-11-18T00:00:00Z");
  let current = time;
  try {
    const store = new Store(db, () => new Date(current));
    const service = new MemoryQueryService(
      store,
      () => new Date(time + 60_000),
    );
    const buckets = new Map<string, string>();
    const ids = new Map<string, string>();
    for (const source of RETRIEVAL_SOURCES) {
      current += 1000;
      const bucket = buckets.get(source.bucket);
      const decision =
        bucket === undefined
          ? createNew(BucketType.Task, source.bucket, 1, "synthetic fixture")
          : appendExisting(bucket, BucketType.Task, 1, "synthetic fixture");
      const result = store.archive(
        source.text,
        decision,
        minimalExtraction(source.text),
        {
          candidateBucketIds: [],
          promptVersion: RETRIEVAL_FIXTURE,
          modelName: "synthetic",
        },
      );
      assert.ok(result.entryId && result.bucketId);
      buckets.set(source.bucket, result.bucketId);
      ids.set(result.entryId, source.id);
      if (!source.active) store.deleteEntry(result.entryId, "synthetic revoke");
    }
    return RETRIEVAL_CASES.map(({ id, query }) => {
      const result = service.search(query, 20);
      return {
        id,
        sourceIds: result.results.map(({ entry }) => {
          const sourceId = ids.get(entry.id);
          assert.ok(sourceId);
          return sourceId;
        }),
      };
    });
  } finally {
    db.close();
  }
}

export async function runRetrievalProbe(
  core: CoreClient,
  namespace: string,
  signal: AbortSignal,
) {
  const startedAt = new Date().toISOString();
  const sources = RETRIEVAL_SOURCES.map((source) => ({
    ...source,
    version: 1,
  }));
  const snapshot = { epoch: 1, revision: 1, ready: true };
  const rows: (ScoredCase & {
    readonly iteration: number;
    readonly coreCandidates: number;
    readonly coreUnbound: number;
  })[] = [];
  let failedAt: string | null = "fixture_and_local_baseline";
  try {
    const baseline = new Map(
      doggieRetrievalBaseline().map(({ id, sourceIds }) => [id, sourceIds]),
    );
    for (let iteration = 1; iteration <= 3; iteration++) {
      failedAt = `capture_round_${iteration}`;
      signal.throwIfAborted();
      const health = await core.request("/health", healthSchema);
      assert.equal(health.status, "ok");
      assert.equal(health.stores.ftsAvailable, true);
      assert.equal(health.stores.embeddingService, false);
      const scope: Scope = {
        team_id: `${namespace}-retrieval-${iteration}`,
        agent_id: "d3-retrieval-agent",
        user_id: "d3-retrieval-user",
      };
      const bindings: Binding[] = [];
      for (const source of sources.filter(({ active }) => active)) {
        signal.throwIfAborted();
        const session = `retrieval-${source.id}`;
        const added = await core.add(scope, session, source.text);
        const remoteId = added.accepted_ids[0];
        assert.ok(remoteId && added.total_count === 1);
        bindings.push({
          remoteId,
          sourceId: source.id,
          sourceVersion: source.version,
          session,
          epoch: snapshot.epoch,
          scope,
        });
      }
      assert.equal(
        new Set(bindings.map(({ remoteId }) => remoteId)).size,
        bindings.length,
      );
      const readback = await core.query(scope);
      assert.equal(readback.total, bindings.length);
      assert.equal(readback.messages.length, bindings.length);
      assert.equal(
        admitL0(readback.messages, bindings, sources, scope, snapshot, snapshot)
          .length,
        bindings.length,
      );
      for (const item of RETRIEVAL_CASES) {
        failedAt = `${item.id}_round_${iteration}`;
        signal.throwIfAborted();
        const doggie = baseline.get(item.id);
        assert.ok(doggie);
        const candidates = (await core.search(scope, item.query)).messages;
        const admitted = admitL0(
          candidates,
          bindings,
          sources,
          scope,
          snapshot,
          snapshot,
        );
        const score = {
          iteration,
          queryId: item.id,
          group: item.group,
          doggie: rankScore(item.expected, doggie),
          core: rankScore(
            item.expected,
            admitted.map(({ sourceId }) => sourceId),
          ),
          coreCandidates: candidates.length,
          coreUnbound: candidates.length - admitted.length,
        };
        rows.push(score);
        assert.equal(score.coreUnbound, 0);
      }
    }
    failedAt = null;
  } catch {
    // Persist a stable stage and any accumulated fixture-only measurements.
  }
  return {
    startedAt,
    fixtureVersion: RETRIEVAL_FIXTURE,
    failedAt,
    rows,
    summary: summarize(rows),
  };
}
