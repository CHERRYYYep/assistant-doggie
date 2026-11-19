/** Durable proposals are data, never authority to execute a side effect. */
import { z } from "zod";
import { failureCodeSchema } from "./failure-code.ts";
import { BucketType } from "./types.ts";

const text = z
  .string()
  .min(1)
  .max(16_000)
  .refine((value) => value.trim() !== "");
const id = z.string().trim().min(1).max(200);
const bucketType = z.enum(BucketType);
// Archive input follows the existing one-MiB HTTP boundary, not the future tool argument budget.
const archiveText = z
  .string()
  .min(1)
  .max(1024 * 1024)
  .refine((value) => value.trim() !== "");

export const pendingActionDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("archive"),
      payload: z
        .object({
          rawText: archiveText,
          candidateBucketIds: z.array(id).max(200),
          focusBucketId: id.nullable(),
          suggestedBucketType: bucketType.nullable(),
          suggestedTitle: z.string().max(16_000).nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_task"),
      payload: z
        .object({ instruction: text, workspaceId: id.nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scheduled_run"),
      payload: z.object({ scheduleId: id }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("bulk_mutation"),
      payload: z
        .object({
          operation: z.enum(["move_entries", "delete_entries"]),
          entryIds: z.array(id).min(1).max(200),
          targetBucketId: id.nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export const proposedBySchema = z.enum(["model", "schedule", "user"]);
export const pendingStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
]);
export const approvalChoiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("append"), targetBucketId: id }).strict(),
  z.object({ action: z.literal("create"), title: text, bucketType }).strict(),
]);
export const actionResultSchema = z
  .object({
    bucketId: id.optional(),
    entryId: id.optional(),
    resultAttemptId: id.optional(),
    referenceId: id.optional(),
  })
  .strict();

export const actionCompletionSchema = z.discriminatedUnion("status", [
  z
    .object({ status: z.literal("executed"), result: actionResultSchema })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      failureCode: failureCodeSchema,
    })
    .strict(),
]);
export type ActionCompletion = z.infer<typeof actionCompletionSchema>;

export type PendingActionDraft = z.infer<typeof pendingActionDraftSchema>;
export type DeferredActionDraft = Exclude<
  PendingActionDraft,
  { kind: "archive" }
>;
export type ProposedBy = z.infer<typeof proposedBySchema>;
export type PendingActionStatus = z.infer<typeof pendingStatusSchema>;
export type ApprovalChoice = z.infer<typeof approvalChoiceSchema>;
export type ActionResult = z.infer<typeof actionResultSchema>;
export type PendingAction = PendingActionDraft & {
  readonly id: string;
  readonly proposedBy: ProposedBy;
  readonly binding: string;
  readonly status: PendingActionStatus;
  readonly approval: ApprovalChoice | null;
  readonly result: ActionResult | null;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export const MAX_PENDING_ACTION_BYTES = 32 * 1024;
// payload plus the exact binding copy, with room for bounded candidate metadata.
export const MAX_ARCHIVE_ACTION_BYTES = 2 * 1024 * 1024 + 64 * 1024;
