/**
 * Explicit synthetic-data smoke against an already-running pinned MemoryCore.
 * This file reads only D3_* environment variables; it never loads .env.
 */
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { createNew, appendExisting } from "../../src/domain/classification.ts";
import { minimalExtraction } from "../../src/domain/memory.ts";
import { BucketType } from "../../src/domain/types.ts";
import { MemoryQueryService } from "../../src/application/query.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { Store } from "../../src/storage/store.ts";
import {
  CoreClient,
  ExperimentError,
  healthSchema,
  UPSTREAM_COMMIT,
  type Scope,
} from "./client.ts";
import { SYNTHETIC_ENTRIES, SYNTHETIC_QUERIES } from "./fixtures.ts";
import { smokeReportSchema } from "./report.ts";
import {
  admitL0,
  scoreSources,
  type Binding,
  type Source,
} from "./source-guard.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error("Missing explicit D3 environment variable: " + name);
  return value;
};
const key = env("D3_GATEWAY_KEY");
if (!key.startsWith("d3-synthetic-"))
  throw new Error("D3_GATEWAY_KEY must be a synthetic test credential.");
const endpoint = env("D3_CORE_URL");
const instance = env("D3_INSTANCE_ID");
const scope: Scope = {
  team_id: "d3-synthetic-team",
  agent_id: "d3-synthetic-agent",
  user_id: "d3-synthetic-user",
};
const core = new CoreClient(endpoint, key, instance, 3000, 262144);

type RunResult = {
  readonly iteration: number;
  readonly queryResults: readonly {
    readonly queryId: string;
    readonly candidateCount: number;
    readonly admittedSourceIds: readonly string[];
    readonly notAdmittedCount: number;
    readonly score: ReturnType<typeof scoreSources>;
  }[];
  readonly crossSessionCount: number;
  readonly crossUserCount: number;
  readonly revokedCandidateRejected: boolean;
  readonly staleSnapshotRejected: boolean;
  readonly ftsAvailable: boolean;
  readonly duplicateRequestProducedDistinctIds: boolean;
  readonly cleanupDeleted: number;
};

async function runIteration(iteration: number): Promise<RunResult> {
  const epoch = iteration + 1;
  const sources: Source[] = SYNTHETIC_ENTRIES.filter(
    (entry) => entry.status === "active" || entry.status === "revoked",
  ).map((entry) => ({
    id: entry.id,
    bucket: entry.bucket,
    text: entry.text,
    active: entry.status === "active",
    version: 1,
  }));
  const bindings: Binding[] = [];
  const remoteIds: string[] = [];
  const captureEpoch = { epoch, revision: 1, ready: true } as const;
  try {
    for (const entry of SYNTHETIC_ENTRIES) {
      if (entry.status !== "active" && entry.status !== "revoked") continue;
      const requestId =
        entry.id === "synthetic-entry-01"
          ? "d3-synthetic-repeat-" + iteration
          : undefined;
      const added = await core.add(scope, entry.session, entry.text, requestId);
      const remoteId = added.accepted_ids[0];
      if (remoteId === undefined)
        throw new Error("Core returned an empty capture receipt");
      const source = sources.find(({ id }) => id === entry.id);
      if (source === undefined) throw new Error("Fixture source missing");
      remoteIds.push(remoteId);
      bindings.push({
        remoteId,
        sourceId: entry.id,
        sourceVersion: source.version,
        session: entry.session,
        epoch,
        scope,
      });
    }

    // x-request-id is trace correlation only. Reusing it must not cause this
    // harness to infer idempotency or make a safe automatic retry.
    const duplicate = await core.add(
      scope,
      "synthetic-session-01",
      "payments order-latency is 120ms on build 701",
      "d3-synthetic-repeat-" + iteration,
    );
    const duplicateId = duplicate.accepted_ids[0];
    if (duplicateId !== undefined) remoteIds.push(duplicateId);
    const duplicateRequestProducedDistinctIds =
      duplicateId !== undefined && duplicateId !== remoteIds[0];

    const health = await core.request("/health", healthSchema);
    if (health.status !== "ok" || !health.stores.ftsAvailable)
      throw new Error("MemoryCore is not ready for BM25 validation");
    const queryResults = [];
    for (const testCase of SYNTHETIC_QUERIES) {
      const result = await core.search(scope, testCase.query);
      const admitted = admitL0(
        result.messages,
        bindings,
        sources,
        scope,
        captureEpoch,
        captureEpoch,
      );
      const actual = admitted.map(({ sourceId }) => sourceId);
      queryResults.push({
        queryId: testCase.id,
        candidateCount: result.messages.length,
        admittedSourceIds: actual,
        notAdmittedCount: result.messages.length - actual.length,
        score: scoreSources(testCase.expected, actual),
      });
    }
    const crossSession = await core.query(scope);
    if (crossSession.total !== remoteIds.length)
      throw new Error(
        "Strictly scoped query did not aggregate all synthetic sessions",
      );
    const foreignScope = { ...scope, user_id: "d3-synthetic-other-user" };
    const foreign = await core.query(foreignScope);
    // Supplement the lexical benchmark with a local provenance-gate probe.
    // The revoked source deliberately remains in Core; no claim of upstream
    // L1-L3 deletion propagation follows from rejecting it here.
    const revokedSource = sources.find(({ active }) => !active);
    const revokedBinding = bindings.find(
      ({ sourceId }) => sourceId === revokedSource?.id,
    );
    if (
      revokedSource === undefined ||
      revokedBinding === undefined ||
      !crossSession.messages.some(({ id }) => id === revokedBinding.remoteId)
    )
      throw new Error("Missing revoked synthetic candidate for gate probe");
    const admitted = admitL0(
      crossSession.messages,
      bindings,
      sources,
      scope,
      captureEpoch,
      captureEpoch,
    );
    const revokedCandidateRejected = !admitted.some(
      ({ sourceId }) => sourceId === revokedSource.id,
    );
    const staleSnapshotRejected =
      admitted.length > 0 &&
      admitL0(crossSession.messages, bindings, sources, scope, captureEpoch, {
        ...captureEpoch,
        revision: captureEpoch.revision + 1,
      }).length === 0;
    if (!revokedCandidateRejected || !staleSnapshotRejected)
      throw new Error(
        "Local source gate admitted an invalid snapshot or revoked source",
      );
    const cleanup =
      remoteIds.length === 0
        ? 0
        : (await core.deleteMessages(scope, remoteIds)).deleted_count;
    if (cleanup !== remoteIds.length)
      throw new Error("Core did not delete every tracked synthetic message");
    const remaining = await core.query(scope);
    if (remaining.messages.some(({ id }) => remoteIds.includes(id)))
      throw new Error("Cleanup left captured synthetic L0 messages behind");
    return {
      iteration,
      queryResults,
      crossSessionCount: crossSession.total,
      crossUserCount: foreign.total,
      revokedCandidateRejected,
      staleSnapshotRejected,
      ftsAvailable: health.stores.ftsAvailable,
      duplicateRequestProducedDistinctIds,
      cleanupDeleted: cleanup,
    };
  } catch (error) {
    if (remoteIds.length > 0)
      await core.deleteMessages(scope, remoteIds).catch(() => undefined);
    throw error;
  }
}

function localBaseline() {
  const db = openDatabase(":memory:");
  try {
    const store = new Store(db);
    const bucketIds = new Map<string, string>();
    const sourceIds = new Map<string, string>();
    for (const entry of SYNTHETIC_ENTRIES) {
      if (entry.status !== "active" && entry.status !== "revoked") continue;
      const bucketId = bucketIds.get(entry.bucket);
      const decision =
        bucketId === undefined
          ? createNew(BucketType.Task, entry.bucket, 0.99, "synthetic fixture")
          : appendExisting(
              bucketId,
              BucketType.Task,
              0.99,
              "synthetic fixture",
            );
      const archived = store.archive(
        entry.text,
        decision,
        minimalExtraction(entry.text),
        {
          candidateBucketIds: [],
          promptVersion: "d3-fixture-v1",
          modelName: "synthetic",
        },
      );
      const entryId = archived.entryId;
      const createdBucketId = archived.bucketId;
      if (
        entryId === null ||
        entryId === undefined ||
        createdBucketId === null ||
        createdBucketId === undefined
      )
        throw new Error("Failed to build local synthetic baseline");
      bucketIds.set(entry.bucket, createdBucketId);
      sourceIds.set(entry.text, entry.id);
      if (entry.status === "revoked")
        store.deleteEntry(entryId, "synthetic D3 revoke");
    }
    const queryService = new MemoryQueryService(store);
    return SYNTHETIC_QUERIES.map((testCase) => {
      const response = queryService.search(testCase.query, 20);
      const actual = response.results
        .map(({ entry }) => sourceIds.get(entry.rawText))
        .filter((id): id is string => id !== undefined);
      return {
        queryId: testCase.id,
        score: scoreSources(testCase.expected, actual),
      };
    });
  } finally {
    db.close();
  }
}

const startedAt = new Date().toISOString();
const report = {
  phase: "L0 synthetic lexical smoke; no semantic L1 extraction",
  upstreamCommit: UPSTREAM_COMMIT,
  fixtureVersion: "l0-lexical-v1",
  startedAt,
  node: process.version,
  isolation:
    "synthetic empty scope and loopback endpoint; runner owns process/data isolation",
  baseline: localBaseline(),
  baselineSummary: undefined as
    | {
        positiveRecallAt5: number;
        negativesPassed: number;
        negativeTotal: number;
      }
    | undefined,
  core: undefined as { version: string; ftsAvailable: boolean } | undefined,
  runs: [] as RunResult[],
  summary: undefined as
    | {
        positiveRecallAt5: number;
        negativesPassed: number;
        negativeTotal: number;
        crossSessionAggregationPassed: boolean;
        crossUserIsolationPassed: boolean;
        duplicateRequestWasIdempotent: boolean;
        cleanupPassed: boolean;
      }
    | undefined,
  transport: core.metrics,
  errorCode: undefined as string | undefined,
  finishedAt: undefined as string | undefined,
};
try {
  // A separate invocation must never append to a pre-existing test scope.
  if ((await core.query(scope)).total !== 0)
    throw new Error("D3 requires an empty synthetic scope");
  const initialHealth = await core.request("/health", healthSchema);
  if (!initialHealth.stores.ftsAvailable)
    throw new Error(
      "FTS5 is unavailable; stopping before retrieval experiment.",
    );
  report.core = {
    version: initialHealth.version,
    ftsAvailable: initialHealth.stores.ftsAvailable,
  };
  const summarize = (
    scores: readonly { readonly score: ReturnType<typeof scoreSources> }[],
  ) => {
    const positive = scores
      .map(({ score }) => score.recallAt5)
      .filter((value): value is number => value !== null);
    const negative = scores
      .map(({ score }) => score.negativePassed)
      .filter((value): value is boolean => value !== null);
    return {
      positiveRecallAt5:
        positive.length === 0
          ? 1
          : positive.reduce((sum, value) => sum + value, 0) / positive.length,
      negativesPassed: negative.filter(Boolean).length,
      negativeTotal: negative.length,
    };
  };
  report.baselineSummary = summarize(
    report.baseline.map((score) => ({ score: score.score })),
  );
  const iterations = z.coerce
    .number()
    .int()
    .min(1)
    .max(3)
    .parse(process.env["D3_ITERATIONS"] ?? "3");
  for (let index = 0; index < iterations; index++)
    report.runs.push(await runIteration(index));
  const allScores = report.runs.flatMap((run) => run.queryResults);
  report.summary = {
    ...summarize(allScores),
    crossSessionAggregationPassed: report.runs.every(
      (run) => run.crossSessionCount === 31,
    ),
    crossUserIsolationPassed: report.runs.every(
      (run) => run.crossUserCount === 0,
    ),
    duplicateRequestWasIdempotent: report.runs.every(
      (run) => !run.duplicateRequestProducedDistinctIds,
    ),
    cleanupPassed: report.runs.every((run) => run.cleanupDeleted === 31),
  };
} catch (error) {
  report.errorCode =
    error instanceof ExperimentError ? error.code : "experiment_failed";
  process.stderr.write("D3 smoke failed: " + report.errorCode + "\n");
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const outputPath = process.env["D3_REPORT_PATH"];
  const rendered =
    JSON.stringify(smokeReportSchema.parse(report), null, 2) + "\n";
  if (outputPath !== undefined)
    writeFileSync(outputPath, rendered, { flag: "wx", mode: 0o600 });
  else process.stdout.write(rendered);
}
