import { z } from "zod";
import type { ContentCheck, L1Case } from "./l1-fixtures.ts";

export const sourceIdSchema = z.string().regex(/^synthetic-l1-source-\d{2}$/);
export const recordSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(8192),
  type: z.enum([
    "persona",
    "episodic",
    "instruction",
    "work_fact",
    "work_task",
    "work_method",
    "work_artifact",
  ]),
  source_message_ids: z.array(z.string().max(200)).max(30),
  sessionId: z.string().max(100),
  teamId: z.string().max(100),
  userId: z.string().max(100),
  agentId: z.string().max(100),
}); // Upstream record metadata is projected away; it is never trusted as authority.
export const extractionSchema = z.object({
  success: z.boolean(),
  extractedCount: z.number().int().min(0).max(100),
  storedCount: z.number().int().min(0).max(100),
  records: z.array(recordSchema).max(20),
});
export type L1Record = z.infer<typeof recordSchema>;
export const workerMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({
    kind: z.literal("model"),
    callId: z.number().int().positive().max(50),
    systemPrompt: z.string().min(1).max(65536),
    prompt: z.string().min(1).max(65536),
  }),
  z.strictObject({
    kind: z.literal("result"),
    caseId: z.string().regex(/^l1-case-\d{2}$/),
    iteration: z.number().int().min(0).max(2),
    extraction: extractionSchema,
    persistedRecordCount: z.number().int().min(0).max(20),
    persistedSourceIdsMatch: z.boolean(),
    sqliteL1Count: z.number().int().min(0).max(20),
    foreignUserL1Count: z.number().int().min(0).max(20),
    deletedL0Count: z.number().int().min(0).max(3),
    l1CountAfterL0Deletion: z.number().int().min(0).max(20),
    reopenedL1Count: z.number().int().min(0).max(20),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.enum(["upstream_contract", "worker_failed"]),
  }),
]);
export const parentMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("job"),
    caseId: z.string().regex(/^l1-case-\d{2}$/),
    iteration: z.number().int().min(0).max(2),
  }),
  z.strictObject({
    kind: z.literal("model_result"),
    callId: z.number().int().positive().max(50),
    text: z.string().max(65536),
  }),
  z.strictObject({
    kind: z.literal("model_error"),
    callId: z.number().int().positive().max(50),
  }),
]);

export function matchesTerms(text: string, check: ContentCheck): boolean {
  const lower = text.toLowerCase();
  return check.terms.every((alternatives) =>
    alternatives.some((term) => lower.includes(term.toLowerCase())),
  );
}

/** Mechanical source validity and literal coverage, never a semantic entailment score. */
export function evaluateL1(
  testCase: L1Case,
  records: readonly L1Record[],
  sessionId: string,
) {
  const active = new Set(
    testCase.sources.filter((s) => s.state === "active").map((s) => s.id),
  );
  const valid = records.filter(
    (r) =>
      r.source_message_ids.length > 0 &&
      new Set(r.source_message_ids).size === r.source_message_ids.length &&
      r.source_message_ids.every((id) => active.has(id)) &&
      r.sessionId === sessionId &&
      r.teamId === "d3-l1-team" &&
      r.userId === "d3-l1-user" &&
      r.agentId === "d3-l1-agent",
  );
  const checks = testCase.checks.map((c) => ({
    id: c.id,
    contentMatched: records.some((r) => matchesTerms(r.content, c)),
    contentAndSourcesMatched: valid.some(
      (r) =>
        matchesTerms(r.content, c) &&
        c.sourceIds.every((id) => r.source_message_ids.includes(id)),
    ),
  }));
  return {
    recordCount: records.length,
    sourceValidRecordCount: valid.length,
    rejectedRecordCount: records.length - valid.length,
    checks,
    totalChecks: checks.length,
    contentChecksPassed: checks.filter((c) => c.contentMatched).length,
    sourceChecksPassed: checks.filter((c) => c.contentAndSourcesMatched).length,
  };
}
