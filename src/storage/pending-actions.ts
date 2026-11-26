/** Internal helpers; all mutations run inside the Store's transaction. */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  actionResultSchema,
  actionCompletionSchema,
  approvalChoiceSchema,
  MAX_PENDING_ACTION_BYTES,
  MAX_ARCHIVE_ACTION_BYTES,
  pendingActionDraftSchema,
  pendingStatusSchema,
  proposedBySchema,
  type ActionCompletion,
  type ApprovalChoice,
  type PendingAction,
  type PendingActionDraft,
  type PendingActionStatus,
  type ProposedBy,
} from "../domain/pending-action.ts";
import { StorageError } from "./database.ts";

const rowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  proposed_by: proposedBySchema,
  binding_text: z.string(),
  payload_json: z.string(),
  status: pendingStatusSchema,
  approval_json: z.string().nullable(),
  result_json: z.string().nullable(),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function readPendingAction(
  database: DatabaseSync,
  id: string,
): PendingAction | undefined {
  const value = database
    .prepare("SELECT * FROM pending_actions WHERE id = ?")
    .get(id);
  if (value === undefined) return undefined;
  try {
    const row = rowSchema.parse(value);
    const draft = pendingActionDraftSchema.parse({
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown,
    });
    return {
      ...draft,
      id: row.id,
      proposedBy: row.proposed_by,
      binding: row.binding_text,
      status: row.status,
      approval:
        row.approval_json === null
          ? null
          : approvalChoiceSchema.parse(
              JSON.parse(row.approval_json) as unknown,
            ),
      result:
        row.result_json === null
          ? null
          : actionResultSchema.parse(JSON.parse(row.result_json) as unknown),
      failureCode: row.failure_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    throw StorageError.invalidWrite(
      "pending_action",
      "has invalid stored data",
    );
  }
}

export function insertPendingAction(
  database: DatabaseSync,
  id: string,
  draft: PendingActionDraft,
  proposedBy: ProposedBy,
  binding: string,
  timestamp: string,
): void {
  const parsed = pendingActionDraftSchema.safeParse(draft);
  const author = proposedBySchema.safeParse(proposedBy);
  if (
    !parsed.success ||
    !author.success ||
    binding.trim() === "" ||
    binding.length >
      (parsed.success && parsed.data.kind === "archive" ? 1024 * 1024 : 16_000)
  ) {
    throw StorageError.invalidWrite(
      "pending_action",
      "has invalid proposal data",
    );
  }
  const payload = JSON.stringify(parsed.data.payload);
  if (
    Buffer.byteLength(payload) + Buffer.byteLength(binding) >
    (parsed.data.kind === "archive"
      ? MAX_ARCHIVE_ACTION_BYTES
      : MAX_PENDING_ACTION_BYTES)
  ) {
    throw StorageError.invalidWrite(
      "pending_action",
      "exceeds its byte budget",
    );
  }
  database
    .prepare(
      `INSERT INTO pending_actions
    (id, kind, proposed_by, binding_text, payload_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      id,
      parsed.data.kind,
      author.data,
      binding,
      payload,
      timestamp,
      timestamp,
    );
}

export function requirePendingAction(
  database: DatabaseSync,
  id: string,
  binding: string,
  status: PendingActionStatus = "pending",
): PendingAction {
  const row = readPendingAction(database, id);
  if (row === undefined)
    throw StorageError.missingRecord("pending_actions", id);
  if (row.binding !== binding)
    throw StorageError.invalidWrite(
      "pending_action",
      "does not match its original input",
    );
  if (row.status !== status)
    throw StorageError.invalidWrite("pending_action", `is not ${status}`);
  return row;
}

export function approvePendingAction(
  database: DatabaseSync,
  id: string,
  binding: string,
  choice: ApprovalChoice,
  timestamp: string,
): void {
  const row = requirePendingAction(database, id, binding);
  const parsed = approvalChoiceSchema.safeParse(choice);
  if (
    !parsed.success ||
    (row.kind === "archive"
      ? parsed.data.action === "approve"
      : parsed.data.action !== "approve")
  ) {
    throw StorageError.invalidWrite(
      "pending_action",
      "has an invalid approval choice",
    );
  }
  transition(
    database,
    id,
    "pending",
    "approved",
    timestamp,
    JSON.stringify(parsed.data),
    null,
    null,
  );
}

export function rejectPendingAction(
  database: DatabaseSync,
  id: string,
  binding: string,
  timestamp: string,
): void {
  requirePendingAction(database, id, binding);
  transition(database, id, "pending", "rejected", timestamp, null, null, null);
}

export function finishPendingAction(
  database: DatabaseSync,
  id: string,
  binding: string,
  outcome: ActionCompletion,
  timestamp: string,
): void {
  const row = requirePendingAction(database, id, binding, "approved");
  const completion = actionCompletionSchema.safeParse(outcome);
  if (!completion.success)
    throw StorageError.invalidWrite(
      "pending_action",
      "has an invalid completion outcome",
    );
  const parsed = completion.data;
  transition(
    database,
    id,
    "approved",
    parsed.status,
    timestamp,
    JSON.stringify(row.approval),
    parsed.status === "executed" ? JSON.stringify(parsed.result) : null,
    parsed.status === "failed" ? parsed.failureCode : null,
  );
}

function transition(
  database: DatabaseSync,
  id: string,
  from: PendingActionStatus,
  to: PendingActionStatus,
  timestamp: string,
  approval: string | null,
  result: string | null,
  failureCode: string | null,
): void {
  const changed = database
    .prepare(
      `UPDATE pending_actions SET status = ?, approval_json = ?, result_json = ?,
    failure_code = ?, updated_at = ? WHERE id = ? AND status = ?`,
    )
    .run(to, approval, result, failureCode, timestamp, id, from);
  if (changed.changes !== 1)
    throw StorageError.invalidWrite("pending_action", "was already resolved");
}
