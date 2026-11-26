/** Only this bounded, synthetic-data projection may leave the experiment. */
import { z } from "zod";

const scoreSchema = z.strictObject({
  recallAt5: z.number().min(0).max(1).nullable(),
  precisionAt5: z.number().min(0).max(1).nullable(),
  unexpected: z.array(z.string().regex(/^synthetic-entry-\d{2}$/)).max(5),
  negativePassed: z.boolean().nullable(),
});
const queryResultSchema = z.strictObject({
  queryId: z.string().regex(/^query-(synthetic-entry-\d{2}|missing-\d)$/),
  score: scoreSchema,
});
const coreQueryResultSchema = queryResultSchema.extend({
  candidateCount: z.number().int().min(0).max(100),
  admittedSourceIds: z
    .array(z.string().regex(/^synthetic-entry-\d{2}$/))
    .max(100),
  notAdmittedCount: z.number().int().min(0).max(100),
});
const summarySchema = z.strictObject({
  positiveRecallAt5: z.number().min(0).max(1),
  negativesPassed: z.number().int().nonnegative(),
  negativeTotal: z.number().int().nonnegative(),
});
export const smokeReportSchema = z.strictObject({
  phase: z.literal("L0 synthetic lexical smoke; no semantic L1 extraction"),
  upstreamCommit: z.string().regex(/^[a-f0-9]{40}$/),
  fixtureVersion: z.literal("l0-lexical-v1"),
  startedAt: z.iso.datetime(),
  node: z.string().regex(/^v\d+\.\d+\.\d+$/),
  isolation: z.literal(
    "synthetic empty scope and loopback endpoint; runner owns process/data isolation",
  ),
  baseline: z.array(queryResultSchema).length(20),
  baselineSummary: summarySchema.optional(),
  core: z
    .strictObject({ version: z.string().max(80), ftsAvailable: z.boolean() })
    .optional(),
  runs: z
    .array(
      z.strictObject({
        iteration: z.number().int().min(0).max(2),
        queryResults: z.array(coreQueryResultSchema).length(20),
        crossSessionCount: z.number().int().nonnegative(),
        crossUserCount: z.number().int().nonnegative(),
        revokedCandidateRejected: z.boolean(),
        staleSnapshotRejected: z.boolean(),
        ftsAvailable: z.boolean(),
        duplicateRequestProducedDistinctIds: z.boolean(),
        cleanupDeleted: z.number().int().nonnegative(),
      }),
    )
    .max(3),
  summary: summarySchema
    .extend({
      crossSessionAggregationPassed: z.boolean(),
      crossUserIsolationPassed: z.boolean(),
      duplicateRequestWasIdempotent: z.boolean(),
      cleanupPassed: z.boolean(),
    })
    .optional(),
  transport: z.strictObject({
    requests: z.number().int().nonnegative().max(1000),
    bytes: z.number().int().nonnegative().max(1048576000),
    latenciesMs: z.array(z.number().finite().nonnegative()).max(1000),
  }),
  errorCode: z
    .enum([
      "endpoint",
      "transport",
      "protocol",
      "limit",
      "remote",
      "experiment_failed",
    ])
    .optional(),
  finishedAt: z.iso.datetime(),
});
