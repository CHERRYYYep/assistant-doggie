/**
 * The transactional store.
 *
 * Every method that changes anything does so inside exactly one transaction,
 * so a failure anywhere leaves the database as it was. That is
 * `docs/INVARIANTS.md` §4.1–§4.2 and it is the reason this layer exists as a
 * boundary at all: callers get typed operations, never a SQL connection.
 */

import type { DatabaseSync } from "node:sqlite";
import { MemoryReadStore, type MemoryColumns } from "./memory-read.ts";
import {
  parseMetadata,
  parseTodoRawTime,
  parseTodoRule,
} from "./memory-rows.ts";
import {
  ConversationStore,
  type ChatMessageInput,
  type ChatMessageRow,
} from "./conversation.ts";
export type { ChatMessageInput, ChatMessageRow } from "./conversation.ts";
import { z } from "zod";

import type {
  BucketStatus,
  BucketType,
  ClassificationAction,
} from "../domain/types.ts";
import {
  calculateNextTodoOccurrence,
  createTodoPlan,
  isTodoStatus,
  normalizeTodoTime,
  transitionTodoStatus,
  type RepeatRule,
  type TodoPlan,
  type TodoRawTime,
  type TodoStatus,
} from "../domain/todo.ts";
import { parseNaturalTodoPlan } from "../domain/todo-time.ts";
import {
  extractionToMemoryRows,
  type ExtractionResult,
} from "../domain/memory.ts";
import { mergeTags, normalizedKey, unicodeCaseFold } from "../domain/text.ts";
import {
  DEFAULT_REBUILD_ENTRY_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
  mergeBucketSummary,
  rebuildBucketSummary,
} from "./summary.ts";
import {
  StorageError,
  formatTimestamp,
  newId,
  optionalField,
  requiredField,
  systemClock,
  withTransaction,
  type Clock,
} from "./database.ts";

import { pendingActionDraftSchema } from "../domain/pending-action.ts";
import type {
  PendingAction,
  DeferredActionDraft,
  ProposedBy,
  ActionCompletion,
  ApprovalChoice,
} from "../domain/pending-action.ts";
import {
  readPendingAction,
  insertPendingAction,
  requirePendingAction,
  approvePendingAction,
  rejectPendingAction,
  finishPendingAction,
} from "./pending-actions.ts";

export type BucketRow = {
  readonly id: string;
  readonly title: string;
  readonly kind: BucketType;
  readonly lifecycle: BucketStatus;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastActiveAt: string;
  readonly archivedAt: string | null;
};

export type EntryRow = {
  readonly id: string;
  readonly bucketId: string;
  readonly rawText: string;
  readonly summary: string | null;
  readonly contentType: string;
  readonly classificationConfidence: number | null;
  readonly classificationReason: string | null;
  readonly createdAt: string;
  readonly movedFromBucketId: string | null;
  readonly archiveState: string;
  readonly archivedAt: string;
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type MemoryRow = {
  readonly id: string;
  readonly bucketId: string;
  readonly entryId: string | null;
  readonly kind: string;
  readonly text: string;
  readonly status: string | null;
  readonly dueAt: string | null;
  readonly scheduledAt: string | null;
  readonly todoRule: RepeatRule | null;
  readonly todoRawTime: TodoRawTime | null;
  readonly todoOccurrence: number | null;
  readonly occurredAt: string | null;
  readonly source: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonValue;
};

export type TodoRow = MemoryRow & {
  readonly kind: "todo";
  readonly status: TodoStatus;
};

export type TodoAgendaInput = {
  readonly now?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly bucketId?: string | undefined;
  readonly statuses?: readonly unknown[] | undefined;
  readonly includeHistory?: boolean | undefined;
};

export type TodoMutationOutcome = {
  readonly todo: TodoRow;
  readonly correctionId: string;
};

export type QueryEntryCandidate = {
  readonly bucket: BucketRow;
  readonly entry: EntryRow;
  readonly memories: readonly MemoryRow[];
};

export type BucketSearchHit = {
  readonly bucket: BucketRow;
  readonly matchedEntryCount: number;
  readonly score: number;
};

export type BucketDetail = {
  readonly bucket: BucketRow;
  readonly entries: readonly EntryRow[];
  readonly memories: readonly MemoryRow[];
};

/** Metadata every archive attempt records for audit. */
export type ArchiveAudit = {
  readonly proposedBy?: ProposedBy;
  readonly candidateBucketIds: readonly string[];
  readonly focusBucketId?: string | undefined;
  readonly promptVersion: string;
  readonly modelName: string;
  readonly confirmationAttemptId?: string | undefined;
};

export type ArchiveAttemptRow = {
  readonly id: string;
  readonly rawText: string;
  readonly action: ClassificationAction;
  readonly archiveState: string;
  readonly bucketId: string | null;
  readonly entryId: string | null;
  readonly confidence: number;
  readonly reason: string;
  readonly question: string | null;
  readonly suggestedBucketType: BucketType | null;
  readonly suggestedTitle: string | null;
  readonly candidateBucketIds: readonly string[];
  readonly focusBucketId: string | null;
  readonly promptVersion: string;
  readonly modelName: string;
  readonly corrected: boolean;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
};

export type ArchiveOutcome = {
  readonly attemptId: string;
  readonly archiveState: "archived" | "needs_confirmation";
  readonly bucketId: string | undefined;
  readonly entryId: string | undefined;
};

/** What the classifier decided, reduced to what the store needs to persist. */
export type ArchiveDecision = {
  readonly action: ClassificationAction;
  readonly bucketId: string | undefined;
  readonly bucketType: BucketType | undefined;
  readonly title: string | undefined;
  readonly confidence: number;
  readonly reason: string;
  readonly question: string | undefined;
};

export type AppendEntryInput = {
  readonly bucketId: string;
  readonly rawText: string;
  readonly summary?: string | null;
  readonly contentType?: string;
  readonly classificationConfidence?: number | null;
  readonly classificationReason?: string | null;
};

export type MoveEntryOutcome = EntryRow & {
  readonly correctionId: string;
  readonly sourceBucketId: string;
  readonly targetBucketId: string;
};

export type SaveExtractionInput = {
  readonly bucketId: string;
  readonly entryId: string;
  readonly extraction: ExtractionResult;
};

export type EntryRevocation = {
  readonly entryId: string;
  readonly bucketId: string;
  readonly correctionId: string;
  readonly revokedAt: string;
  readonly memoryItemIds: readonly string[];
};

const revocationAuditSchema = z.object({
  bucket_id: z.string().min(1),
  revoked_at: z.string().min(1),
  memory_item_ids: z.array(z.string().min(1)),
});

export type DeleteBucketOutcome = {
  readonly bucketId: string;
  readonly deletedEntryIds: readonly string[];
  readonly deletedMemoryItemIds: readonly string[];
  readonly updatedArchiveAttemptIds: readonly string[];
  readonly correctionId: string;
};

export class Store {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;
  readonly conversation: ConversationStore;
  readonly memory: MemoryReadStore;

  constructor(database: DatabaseSync, clock: Clock = systemClock) {
    this.#database = database;
    this.#clock = clock;
    this.conversation = new ConversationStore(database, clock);
    this.memory = new MemoryReadStore(database);
  }

  get database(): DatabaseSync {
    return this.#database;
  }

  #now(): string {
    return formatTimestamp(this.#clock());
  }

  // ── archive ──────────────────────────────────────────────────────────────

  /**
   * Persist one archive decision.
   *
   * `ask_user` records the attempt and nothing else — no Bucket, no Entry, no
   * memory (§4.1, §1.1). The other two actions write the whole graph in this
   * single transaction, so a failure at any step leaves nothing behind.
   */
  archive(
    rawText: string,
    decision: ArchiveDecision,
    extraction: ExtractionResult | undefined,
    audit: ArchiveAudit,
    messageForOutcome?: (outcome: ArchiveOutcome) => ChatMessageInput,
  ): ArchiveOutcome {
    const text = requiredField(rawText, "raw_text");
    const promptVersion = requiredField(audit.promptVersion, "prompt_version");
    const modelName = requiredField(audit.modelName, "model_name");

    return withTransaction(this.#database, () => {
      const finish = (outcome: ArchiveOutcome): ArchiveOutcome => {
        if (messageForOutcome !== undefined) {
          this.conversation.appendChatMessageWithinTransaction(
            messageForOutcome(outcome),
          );
        }
        return outcome;
      };
      const timestamp = this.#now();
      const attemptId = newId();
      const confirmationAttemptId = audit.confirmationAttemptId;
      if (confirmationAttemptId !== undefined) {
        this.requirePendingArchiveAttempt(confirmationAttemptId, rawText);
        if (decision.action === "ask_user") {
          throw StorageError.invalidWrite(
            "confirmation",
            "cannot resolve to ask_user",
          );
        }
      }

      if (decision.action === "ask_user") {
        this.#insertAttempt(attemptId, text, decision, audit, {
          archiveState: "needs_confirmation",
          bucketId: null,
          entryId: null,
          timestamp,
          promptVersion,
          modelName,
        });
        return finish({
          attemptId,
          archiveState: "needs_confirmation",
          bucketId: undefined,
          entryId: undefined,
        });
      }

      if (confirmationAttemptId !== undefined) {
        let choice: ApprovalChoice;
        if (decision.action === "create_new") {
          if (decision.bucketType === undefined)
            throw StorageError.invalidWrite("bucket_type", "is required");
          choice = {
            action: "create",
            title: decision.title ?? "",
            bucketType: decision.bucketType,
          };
        } else {
          choice = {
            action: "append",
            targetBucketId: decision.bucketId ?? "",
          };
        }
        approvePendingAction(
          this.#database,
          confirmationAttemptId,
          text,
          choice,
          timestamp,
        );
      }

      if (extraction === undefined) {
        throw StorageError.invalidWrite(
          "extraction",
          "is required for an automatic archive",
        );
      }

      const bucketId =
        decision.action === "create_new"
          ? this.#createBucket(decision, timestamp)
          : this.#requireBucket(decision.bucketId, timestamp);

      const entryId = this.#insertEntry(
        bucketId,
        text,
        decision,
        extraction,
        timestamp,
      );
      this.#insertMemories(
        bucketId,
        entryId,
        extraction,
        timestamp,
        false,
        text,
      );
      this.#applyExtractionToBucket(bucketId, extraction, timestamp);
      this.#insertAttempt(attemptId, text, decision, audit, {
        archiveState: "archived",
        bucketId,
        entryId,
        timestamp,
        promptVersion,
        modelName,
      });
      if (confirmationAttemptId !== undefined) {
        const updated = this.#database
          .prepare(
            `UPDATE archive_attempts
             SET archive_state = 'archived', bucket_id = ?, entry_id = ?, resolved_at = ?
             WHERE id = ? AND archive_state = 'needs_confirmation'
               AND resolved_at IS NULL AND corrected = 0`,
          )
          .run(bucketId, entryId, timestamp, confirmationAttemptId);
        if (updated.changes !== 1) {
          throw StorageError.archiveAttemptNotPending(confirmationAttemptId);
        }
        finishPendingAction(
          this.#database,
          confirmationAttemptId,
          text,
          {
            status: "executed",
            result: { bucketId, entryId, resultAttemptId: attemptId },
          },
          timestamp,
        );
      }

      return finish({
        attemptId,
        archiveState: "archived",
        bucketId,
        entryId,
      });
    });
  }

  /** Append one Entry without derived memory rows, mirroring the legacy path. */
  appendEntry(request: AppendEntryInput): EntryRow {
    const bucketId = requiredField(request.bucketId, "bucket_id");
    const rawText = requiredField(request.rawText, "raw_text");
    const contentType = requiredField(
      request.contentType ?? "note",
      "content_type",
    );
    const summary = optionalField(request.summary);
    const classificationReason = optionalField(request.classificationReason);
    const confidence = request.classificationConfidence;
    if (
      confidence !== undefined &&
      confidence !== null &&
      (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    ) {
      throw StorageError.invalidWrite(
        "classification_confidence",
        "must be between 0 and 1",
      );
    }

    return withTransaction(this.#database, () => {
      const timestamp = this.#now();
      this.#requireBucket(bucketId, timestamp);
      const entryId = newId();
      this.#database
        .prepare(
          `INSERT INTO entries
             (id, bucket_id, raw_text, summary, content_type,
              classification_confidence, classification_reason,
              created_at, moved_from_bucket_id, archive_state, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'archived', ?)`,
        )
        .run(
          entryId,
          bucketId,
          rawText,
          summary,
          contentType,
          confidence ?? null,
          classificationReason,
          timestamp,
          timestamp,
        );
      const entry = this.getEntry(entryId);
      if (entry === undefined) {
        throw StorageError.missingRecord("entries", entryId);
      }
      return entry;
    });
  }

  /** Persist a refreshed extraction for an existing Entry. */
  saveExtraction(request: SaveExtractionInput): EntryRow {
    const bucketId = requiredField(request.bucketId, "bucket_id");
    const entryId = requiredField(request.entryId, "entry_id");

    return withTransaction(this.#database, () => {
      const bucket = this.getBucket(bucketId);
      if (bucket === undefined) {
        throw StorageError.missingRecord("buckets", bucketId);
      }
      const entry = this.getEntry(entryId);
      if (entry === undefined || entry.bucketId !== bucketId) {
        throw StorageError.missingRecord("entries", entryId);
      }

      const timestamp = this.#now();
      this.#insertMemories(
        bucketId,
        entryId,
        request.extraction,
        timestamp,
        true,
        entry.rawText,
      );
      this.#database
        .prepare("UPDATE entries SET summary = ? WHERE id = ?")
        .run(request.extraction.summary, entryId);
      this.#applyExtractionToBucket(bucketId, request.extraction, timestamp);

      const updated = this.getEntry(entryId);
      if (updated === undefined) {
        throw StorageError.missingRecord("entries", entryId);
      }
      return updated;
    });
  }

  #createBucket(decision: ArchiveDecision, timestamp: string): string {
    if (decision.bucketType === undefined || decision.title === undefined) {
      throw StorageError.invalidWrite(
        "create_new",
        "requires bucket_type and title",
      );
    }
    const bucketId = newId();
    this.#database
      .prepare(
        `INSERT INTO buckets
           (id, title, kind, lifecycle, summary, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, 'active', '', ?, ?, ?)`,
      )
      .run(
        bucketId,
        requiredField(decision.title, "title"),
        decision.bucketType,
        timestamp,
        timestamp,
        timestamp,
      );
    return bucketId;
  }

  #requireBucket(bucketId: string | undefined, timestamp: string): string {
    if (bucketId === undefined) {
      throw StorageError.invalidWrite("append_existing", "requires bucket_id");
    }
    const bucket = this.#database
      .prepare("SELECT lifecycle FROM buckets WHERE id = ?")
      .get(bucketId) as { lifecycle: string } | undefined;
    if (bucket === undefined)
      throw StorageError.missingRecord("buckets", bucketId);
    if (bucket.lifecycle !== "active") {
      throw StorageError.inactiveBucket(bucketId);
    }
    this.#database
      .prepare(
        "UPDATE buckets SET updated_at = ?, last_active_at = ? WHERE id = ?",
      )
      .run(timestamp, timestamp, bucketId);
    return bucketId;
  }

  #insertEntry(
    bucketId: string,
    rawText: string,
    decision: ArchiveDecision,
    extraction: ExtractionResult,
    timestamp: string,
  ): string {
    const entryId = newId();
    this.#database
      .prepare(
        `INSERT INTO entries
           (id, bucket_id, raw_text, summary, content_type,
            classification_confidence, classification_reason,
            created_at, archive_state, archived_at)
         VALUES (?, ?, ?, ?, 'note', ?, ?, ?, 'archived', ?)`,
      )
      .run(
        entryId,
        bucketId,
        rawText,
        extraction.summary,
        decision.confidence,
        decision.reason,
        timestamp,
        timestamp,
      );
    return entryId;
  }

  #insertMemories(
    bucketId: string,
    entryId: string,
    extraction: ExtractionResult,
    timestamp: string,
    dedupeExisting = false,
    rawSourceText?: string,
  ): string[] {
    const seen = dedupeExisting
      ? this.#existingMemoryKeys(entryId)
      : new Set<string>();
    const hasTodoPlanColumns =
      this.#database
        .prepare(
          "SELECT 1 FROM pragma_table_info('memory_items') WHERE name = 'scheduled_at'",
        )
        .get() !== undefined;
    const insert = this.#database.prepare(
      hasTodoPlanColumns
        ? `INSERT INTO memory_items
             (id, bucket_id, entry_id, kind, text, status, due_at, occurred_at, source,
              scheduled_at, todo_rule_json, todo_raw_time_json, todo_occurrence,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO memory_items
             (id, bucket_id, entry_id, kind, text, status, occurred_at, source,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const referenceNow = new Date(timestamp);
    const insertedIds: string[] = [];
    for (const row of extractionToMemoryRows(extraction)) {
      const key = this.#memoryKey(row);
      if (seen.has(key)) continue;
      const id = newId();
      if (hasTodoPlanColumns) {
        const plan =
          row.kind === "todo"
            ? (parseNaturalTodoPlan(row.text, referenceNow) ??
              (rawSourceText === undefined
                ? null
                : parseNaturalTodoPlan(rawSourceText, referenceNow)))
            : null;
        insert.run(
          id,
          bucketId,
          entryId,
          row.kind,
          row.text,
          row.status,
          plan?.dueAt ?? null,
          row.occurredAt,
          row.source,
          plan?.scheduledAt ?? null,
          plan?.repeatRule === null || plan?.repeatRule === undefined
            ? null
            : JSON.stringify(plan.repeatRule),
          plan?.rawTime === null || plan?.rawTime === undefined
            ? null
            : JSON.stringify(plan.rawTime),
          row.kind === "todo" ? 1 : null,
          timestamp,
          timestamp,
        );
      } else {
        insert.run(
          id,
          bucketId,
          entryId,
          row.kind,
          row.text,
          row.status,
          row.occurredAt,
          row.source,
          timestamp,
          timestamp,
        );
      }
      insertedIds.push(id);
      seen.add(key);
    }
    return insertedIds;
  }

  #existingMemoryKeys(entryId: string): Set<string> {
    const rows = this.#database
      .prepare(
        "SELECT kind, text, occurred_at FROM memory_items WHERE entry_id = ?",
      )
      .all(entryId) as {
      kind: string;
      text: string;
      occurred_at: string | null;
    }[];
    return new Set(rows.map((row) => this.#memoryKey(row)));
  }

  #memoryKey(row: {
    kind: string;
    text: string;
    occurredAt?: string | null;
    occurred_at?: string | null;
  }): string {
    const occurredAt = row.occurredAt ?? row.occurred_at ?? null;
    return row.kind === "timeline"
      ? `timeline|${occurredAt ?? ""}|${normalizedKey(row.text)}`
      : `${row.kind}|${normalizedKey(row.text)}`;
  }

  /** Fold the extraction's summary and tags into the Bucket. */
  #applyExtractionToBucket(
    bucketId: string,
    extraction: ExtractionResult,
    timestamp: string,
  ): void {
    const current = this.#database
      .prepare("SELECT summary FROM buckets WHERE id = ?")
      .get(bucketId) as { summary: string } | undefined;
    const summary = mergeBucketSummary(
      current?.summary ?? "",
      extraction.summary,
      DEFAULT_SUMMARY_LIMIT,
    );
    this.#database
      .prepare("UPDATE buckets SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, timestamp, bucketId);
    this.#mergeBucketTags(bucketId, extraction.tags);
  }

  #mergeBucketTags(bucketId: string, incoming: readonly string[]): void {
    if (incoming.length === 0) return;
    const existing = this.#database
      .prepare(
        "SELECT tag FROM bucket_tags WHERE bucket_id = ? ORDER BY position ASC",
      )
      .all(bucketId) as { tag: string }[];
    const merged = mergeTags(
      existing.map((row) => row.tag),
      incoming,
    );
    this.#database
      .prepare("DELETE FROM bucket_tags WHERE bucket_id = ?")
      .run(bucketId);
    const insert = this.#database.prepare(
      "INSERT INTO bucket_tags(bucket_id, tag, position) VALUES (?, ?, ?)",
    );
    merged.forEach((tag, position) => insert.run(bucketId, tag, position));
  }

  #insertAttempt(
    attemptId: string,
    rawText: string,
    decision: ArchiveDecision,
    audit: ArchiveAudit,
    context: {
      archiveState: string;
      bucketId: string | null;
      entryId: string | null;
      timestamp: string;
      promptVersion: string;
      modelName: string;
    },
  ): void {
    const candidateBucketIds = [...audit.candidateBucketIds];
    if (
      decision.bucketId !== undefined &&
      !candidateBucketIds.includes(decision.bucketId)
    ) {
      candidateBucketIds.push(decision.bucketId);
    }

    this.#database
      .prepare(
        `INSERT INTO archive_attempts
           (id, raw_text, action, archive_state, bucket_id, entry_id, confidence,
            reason, question, suggested_bucket_type, suggested_title,
            candidate_bucket_ids_json, focus_bucket_id, prompt_version,
            model_name, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        rawText,
        decision.action,
        context.archiveState,
        context.bucketId,
        context.entryId,
        decision.confidence,
        decision.reason,
        optionalField(decision.question),
        decision.bucketType ?? null,
        optionalField(decision.title),
        JSON.stringify(candidateBucketIds),
        optionalField(audit.focusBucketId),
        context.promptVersion,
        context.modelName,
        context.timestamp,
        context.archiveState === "archived" ? context.timestamp : null,
      );
    if (context.archiveState === "needs_confirmation") {
      insertPendingAction(
        this.#database,
        attemptId,
        {
          kind: "archive",
          payload: {
            rawText,
            candidateBucketIds,
            focusBucketId: optionalField(audit.focusBucketId),
            suggestedBucketType: decision.bucketType ?? null,
            suggestedTitle: optionalField(decision.title),
          },
        },
        audit.proposedBy ?? "model",
        rawText,
        context.timestamp,
      );
    }
  }

  requirePendingArchiveAttempt(
    attemptId: string,
    rawText: string,
  ): ArchiveAttemptRow {
    const attempt = this.getArchiveAttempt(attemptId);
    if (attempt === undefined) {
      throw StorageError.archiveAttemptNotFound(attemptId);
    }
    if (attempt.rawText !== rawText) {
      throw StorageError.archiveAttemptTextMismatch(attemptId);
    }
    if (
      attempt.archiveState !== "needs_confirmation" ||
      attempt.resolvedAt !== null ||
      attempt.corrected
    ) {
      throw StorageError.archiveAttemptNotPending(attemptId);
    }
    const pending = readPendingAction(this.#database, attemptId);
    if (
      pending === undefined ||
      pending.kind !== "archive" ||
      pending.status !== "pending"
    ) {
      throw StorageError.archiveAttemptNotPending(attemptId);
    }
    if (pending.binding !== rawText || pending.payload.rawText !== rawText) {
      throw StorageError.archiveAttemptTextMismatch(attemptId);
    }
    return attempt;
  }

  getArchiveAttempt(attemptId: string): ArchiveAttemptRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, raw_text, action, archive_state, bucket_id, entry_id,
                confidence, reason, question, suggested_bucket_type,
                suggested_title, candidate_bucket_ids_json, focus_bucket_id,
                prompt_version, model_name, corrected,
                created_at, resolved_at
         FROM archive_attempts WHERE id = ?`,
      )
      .get(attemptId) as ArchiveAttemptColumns | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      rawText: row.raw_text,
      action: row.action,
      archiveState: row.archive_state,
      bucketId: row.bucket_id,
      entryId: row.entry_id,
      confidence: row.confidence,
      reason: row.reason,
      question: row.question,
      suggestedBucketType: row.suggested_bucket_type,
      suggestedTitle: row.suggested_title,
      candidateBucketIds: JSON.parse(row.candidate_bucket_ids_json) as string[],
      focusBucketId: row.focus_bucket_id,
      promptVersion: row.prompt_version,
      modelName: row.model_name,
      corrected: row.corrected === 1,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  discardArchiveAttempt(attemptId: string, rawText: string): void {
    const id = requiredField(attemptId, "attempt_id");
    const text = requiredField(rawText, "raw_text");
    withTransaction(this.#database, () => {
      this.requirePendingArchiveAttempt(id, rawText);
      const timestamp = this.#now();
      rejectPendingAction(this.#database, id, text, timestamp);
      const updated = this.#database
        .prepare(
          `UPDATE archive_attempts
           SET archive_state = 'discarded', resolved_at = ?
           WHERE id = ? AND archive_state = 'needs_confirmation'
             AND resolved_at IS NULL AND corrected = 0`,
        )
        .run(timestamp, id);
      if (updated.changes !== 1) {
        throw StorageError.archiveAttemptNotPending(id);
      }
    });
  }

  getPendingAction(id: string): PendingAction | undefined {
    return readPendingAction(
      this.#database,
      requiredField(id, "pending_action_id"),
    );
  }

  /** Future use cases can persist proposals; no executor is dispatched here. */
  proposePendingAction(
    draft: DeferredActionDraft,
    binding: string,
    proposedBy: ProposedBy,
  ): PendingAction {
    const parsed = pendingActionDraftSchema.safeParse(draft);
    if (!parsed.success || parsed.data.kind === "archive") {
      throw StorageError.invalidWrite(
        "pending_action",
        "requires a valid non-archive proposal",
      );
    }
    return withTransaction(this.#database, () => {
      const id = newId();
      insertPendingAction(
        this.#database,
        id,
        parsed.data,
        proposedBy,
        binding,
        this.#now(),
      );
      return requirePendingAction(this.#database, id, binding);
    });
  }

  approvePendingAction(id: string, binding: string): void {
    withTransaction(this.#database, () => {
      this.#requireDeferredAction(id, binding);
      approvePendingAction(
        this.#database,
        id,
        binding,
        { action: "approve" },
        this.#now(),
      );
    });
  }

  rejectPendingAction(id: string, binding: string): void {
    withTransaction(this.#database, () => {
      this.#requireDeferredAction(id, binding);
      rejectPendingAction(this.#database, id, binding, this.#now());
    });
  }

  finishPendingAction(
    id: string,
    binding: string,
    outcome: ActionCompletion,
  ): void {
    withTransaction(this.#database, () => {
      this.#requireDeferredAction(id, binding, "approved");
      finishPendingAction(this.#database, id, binding, outcome, this.#now());
    });
  }

  #requireDeferredAction(
    id: string,
    binding: string,
    status: "pending" | "approved" = "pending",
  ): PendingAction {
    const row = requirePendingAction(this.#database, id, binding, status);
    if (row.kind === "archive")
      throw StorageError.invalidWrite(
        "pending_action",
        "archive actions must use bound confirmation",
      );
    return row;
  }

  // ── correction ───────────────────────────────────────────────────────────

  /**
   * Move an Entry to another Bucket, carrying its structured memory with it
   * and recording a correction snapshot (§4.6).
   *
   * If the source Bucket was created *for this Entry* and is now empty, it is
   * removed (§4.7) — otherwise a mis-classification leaves an empty Bucket
   * behind every time the user fixes it.
   */
  moveEntry(
    entryId: string,
    targetBucketId: string,
    commandText: string,
  ): MoveEntryOutcome {
    const command = requiredField(commandText, "command_text");

    return withTransaction(this.#database, () => {
      const source = this.#database
        .prepare(
          "SELECT bucket_id FROM entries WHERE id = ? AND revoked_at IS NULL",
        )
        .get(entryId) as { bucket_id: string } | undefined;
      if (source === undefined)
        throw StorageError.missingRecord("entries", entryId);

      const target = this.#database
        .prepare("SELECT lifecycle FROM buckets WHERE id = ?")
        .get(targetBucketId) as { lifecycle: string } | undefined;
      if (target === undefined)
        throw StorageError.missingRecord("buckets", targetBucketId);
      if (target.lifecycle !== "active") {
        throw StorageError.inactiveBucket(targetBucketId);
      }

      const sourceBucketId = source.bucket_id;
      if (sourceBucketId === targetBucketId) {
        throw StorageError.invalidWrite(
          "move_entry",
          "source and target buckets must differ",
        );
      }

      const timestamp = this.#now();
      this.#database
        .prepare(
          "UPDATE entries SET bucket_id = ?, moved_from_bucket_id = ? WHERE id = ?",
        )
        .run(targetBucketId, sourceBucketId, entryId);
      this.#database
        .prepare("UPDATE memory_items SET bucket_id = ? WHERE entry_id = ?")
        .run(targetBucketId, entryId);
      const tags = this.#entryTags(entryId);
      this.#removeUnsupportedTags(sourceBucketId, tags);
      this.#mergeBucketTags(targetBucketId, tags);
      this.#database
        .prepare(
          "UPDATE buckets SET updated_at = ?, last_active_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, targetBucketId);

      if (this.#sourceShouldBeRemoved(sourceBucketId, entryId)) {
        this.#database
          .prepare("DELETE FROM buckets WHERE id = ?")
          .run(sourceBucketId);
      } else {
        this.#database
          .prepare(
            "UPDATE buckets SET updated_at = ?, last_active_at = ? WHERE id = ?",
          )
          .run(timestamp, timestamp, sourceBucketId);
        this.#rebuildSummary(sourceBucketId, timestamp);
      }
      this.#rebuildSummary(targetBucketId, timestamp);

      const correctionId = newId();
      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
           VALUES (?, ?, 'move_entry', 'entry', ?, ?, ?, ?)`,
        )
        .run(
          correctionId,
          command,
          entryId,
          JSON.stringify({ bucket_id: sourceBucketId }),
          JSON.stringify({
            bucket_id: targetBucketId,
            reason: "user_correction",
          }),
          timestamp,
        );

      this.#database
        .prepare(
          `UPDATE archive_attempts
             SET corrected = 1, archive_state = 'corrected', resolved_at = ?
           WHERE entry_id = ? AND corrected = 0`,
        )
        .run(timestamp, entryId);

      const moved = this.getEntry(entryId);
      if (moved === undefined)
        throw StorageError.missingRecord("entries", entryId);
      return {
        ...moved,
        correctionId,
        sourceBucketId,
        targetBucketId,
      };
    });
  }

  /**
   * Whether the source Bucket exists only because this Entry was misfiled.
   *
   * Both conditions are required: the Bucket was created by the same archive
   * attempt that created this Entry, **and** nothing else is left in it. A
   * Bucket the user created on purpose is never removed by a correction.
   */
  #sourceShouldBeRemoved(
    sourceBucketId: string,
    movedEntryId: string,
  ): boolean {
    const createdForEntry = this.#database
      .prepare(
        `SELECT 1 FROM archive_attempts
         WHERE action = 'create_new' AND bucket_id = ? AND entry_id = ?`,
      )
      .get(sourceBucketId, movedEntryId);
    if (createdForEntry === undefined) return false;

    const remaining = this.#database
      .prepare(
        `SELECT (SELECT COUNT(*) FROM entries WHERE bucket_id = ?1)
              + (SELECT COUNT(*) FROM memory_items WHERE bucket_id = ?1) AS total`,
      )
      .get(sourceBucketId) as { total: number };
    return remaining.total === 0;
  }

  #rebuildSummary(bucketId: string, timestamp: string): void {
    const rows = this.#database
      .prepare(
        `SELECT summary FROM entries WHERE bucket_id = ? AND revoked_at IS NULL
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(bucketId, DEFAULT_REBUILD_ENTRY_LIMIT) as {
      summary: string | null;
    }[];
    const summary = rebuildBucketSummary(
      rows.map((row) => row.summary),
      DEFAULT_SUMMARY_LIMIT,
    );
    this.#database
      .prepare("UPDATE buckets SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, timestamp, bucketId);
  }

  // ── deletion ─────────────────────────────────────────────────────────────

  /** Delete a Bucket and everything that belongs to it (§4.5). */
  deleteBucket(bucketId: string, commandText: string): DeleteBucketOutcome {
    const command = requiredField(commandText, "command_text");
    return withTransaction(this.#database, () => {
      const exists = this.#database
        .prepare("SELECT 1 FROM buckets WHERE id = ?")
        .get(bucketId);
      if (exists === undefined)
        throw StorageError.missingRecord("buckets", bucketId);

      const entryRows = this.#database
        .prepare("SELECT id FROM entries WHERE bucket_id = ? ORDER BY id")
        .all(bucketId) as { id: string }[];
      const memoryRows = this.#database
        .prepare("SELECT id FROM memory_items WHERE bucket_id = ? ORDER BY id")
        .all(bucketId) as { id: string }[];
      const attemptRows = this.#database
        .prepare(
          `SELECT id FROM archive_attempts
           WHERE bucket_id = ?1
              OR entry_id IN (SELECT id FROM entries WHERE bucket_id = ?1)
           ORDER BY id`,
        )
        .all(bucketId) as { id: string }[];

      // Entries, tags and memory go by ON DELETE CASCADE; archive attempts
      // keep their audit row with the link cleared by ON DELETE SET NULL.
      this.#database.prepare("DELETE FROM buckets WHERE id = ?").run(bucketId);
      const correctionId = newId();
      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
           VALUES (?, ?, 'delete_bucket', 'bucket', ?, ?, ?, ?)`,
        )
        .run(
          correctionId,
          command,
          bucketId,
          JSON.stringify({ bucket_id: bucketId }),
          JSON.stringify(this.#nextMemoryContext()),
          this.#now(),
        );
      return {
        bucketId,
        deletedEntryIds: entryRows.map((row) => row.id),
        deletedMemoryItemIds: memoryRows.map((row) => row.id),
        updatedArchiveAttemptIds: attemptRows.map((row) => row.id),
        correctionId,
      };
    });
  }

  /** Revoke one Entry. Source text and audit survive outside effective memory. */
  deleteEntry(entryId: string, commandText: string): EntryRevocation {
    const id = requiredField(entryId, "entry_id");
    const command = requiredField(commandText, "command_text");
    return withTransaction(this.#database, () => {
      const previous = this.getEntryRevocation(id);
      if (previous !== undefined) return previous;
      const entry = this.#database
        .prepare(
          "SELECT bucket_id FROM entries WHERE id = ? AND revoked_at IS NULL",
        )
        .get(id) as { bucket_id: string } | undefined;
      if (entry === undefined) throw StorageError.missingRecord("entries", id);

      const timestamp = this.#now();
      const memoryItemIds = this.#database
        .prepare("SELECT id FROM memory_items WHERE entry_id = ? ORDER BY id")
        .all(id)
        .map((row) => z.string().parse(row["id"]));
      const tags = this.#entryTags(id);
      this.#database
        .prepare("UPDATE entries SET revoked_at = ? WHERE id = ?")
        .run(timestamp, id);
      this.#removeUnsupportedTags(entry.bucket_id, tags);
      this.#rebuildSummary(entry.bucket_id, timestamp);
      this.#database
        .prepare(
          `UPDATE archive_attempts SET archive_state = 'revoked', corrected = 1, resolved_at = ?
           WHERE entry_id = ?`,
        )
        .run(timestamp, id);
      const correctionId = newId();
      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
           VALUES (?, ?, 'delete_entry', 'entry', ?, ?, ?, ?)`,
        )
        .run(
          correctionId,
          command,
          id,
          JSON.stringify({ bucket_id: entry.bucket_id }),
          JSON.stringify({
            bucket_id: entry.bucket_id,
            revoked_at: timestamp,
            memory_item_ids: memoryItemIds,
            ...this.#nextMemoryContext(),
          }),
          timestamp,
        );
      return {
        entryId: id,
        bucketId: entry.bucket_id,
        correctionId,
        revokedAt: timestamp,
        memoryItemIds,
      };
    });
  }

  /** The revocation audit is durable even if its Bucket is later deleted. */
  getEntryRevocation(entryId: string): EntryRevocation | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, after_json FROM corrections
         WHERE action = 'delete_entry' AND target_type = 'entry' AND target_id = ?
           AND after_json IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(entryId);
    if (row === undefined) return undefined;
    try {
      const audit = revocationAuditSchema.parse(
        JSON.parse(z.string().parse(row["after_json"])) as unknown,
      );
      return {
        entryId,
        bucketId: audit.bucket_id,
        correctionId: z.string().parse(row["id"]),
        revokedAt: audit.revoked_at,
        memoryItemIds: audit.memory_item_ids,
      };
    } catch {
      throw StorageError.invalidWrite(
        "entry_revocation",
        "has invalid stored data",
      );
    }
  }

  getMemoryContextRevision(): number {
    return this.conversation.getMemoryContextRevision();
  }

  #nextMemoryContext(): {
    readonly context_revision: number;
    readonly history_sequence: number;
  } {
    const revision = this.getMemoryContextRevision() + 1;
    if (!Number.isSafeInteger(revision))
      throw StorageError.invalidWrite(
        "memory_context",
        "revision limit reached",
      );
    const row = this.#database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS maximum FROM conversation_messages",
      )
      .get();
    return {
      context_revision: revision,
      history_sequence: z.number().int().nonnegative().parse(row?.["maximum"]),
    };
  }

  #entryTags(entryId: string): readonly string[] {
    return this.#database
      .prepare(
        "SELECT text FROM memory_items WHERE entry_id = ? AND kind = 'tag'",
      )
      .all(entryId)
      .map((row) => z.string().parse(row["text"]));
  }

  /** Remove only known contributions with no effective support; keep legacy tags. */
  #removeUnsupportedTags(
    bucketId: string,
    contributed: readonly string[],
  ): void {
    if (contributed.length === 0) return;
    const contributedKeys = new Set(contributed.map(normalizedKey));
    const supportedKeys = new Set(
      this.#database
        .prepare(
          `SELECT text FROM memory_items WHERE bucket_id = ? AND kind = 'tag'
           AND (entry_id IS NULL OR EXISTS (
             SELECT 1 FROM entries source WHERE source.id = memory_items.entry_id AND source.revoked_at IS NULL
           ))`,
        )
        .all(bucketId)
        .map((row) => normalizedKey(z.string().parse(row["text"]))),
    );
    const tags = this.#database
      .prepare(
        "SELECT tag FROM bucket_tags WHERE bucket_id = ? ORDER BY position",
      )
      .all(bucketId)
      .map((row) => z.string().parse(row["tag"]))
      .filter(
        (tag) =>
          !contributedKeys.has(normalizedKey(tag)) ||
          supportedKeys.has(normalizedKey(tag)),
      );
    this.#database
      .prepare("DELETE FROM bucket_tags WHERE bucket_id = ?")
      .run(bucketId);
    const insert = this.#database.prepare(
      "INSERT INTO bucket_tags (bucket_id, tag, position) VALUES (?, ?, ?)",
    );
    tags.forEach((tag, position) => insert.run(bucketId, tag, position));
  }

  // ── Bucket lifecycle ─────────────────────────────────────────────────────

  /** Set any valid lifecycle value, matching the canonical Rust service. */
  setBucketStatus(bucketId: string, status: BucketStatus): BucketRow {
    const id = requiredField(bucketId, "bucket_id");
    return withTransaction(this.#database, () => {
      const timestamp = this.#now();
      const archivedAt = status === "archived" ? timestamp : null;
      const updated = this.#database
        .prepare(
          `UPDATE buckets SET lifecycle = ?, updated_at = ?, archived_at = ?
           WHERE id = ?`,
        )
        .run(status, timestamp, archivedAt, id);
      if (updated.changes !== 1) {
        throw StorageError.missingRecord("buckets", id);
      }
      const bucket = this.getBucket(id);
      if (bucket === undefined) {
        throw StorageError.missingRecord("buckets", id);
      }
      return bucket;
    });
  }

  appendChatMessage(message: ChatMessageInput): ChatMessageRow {
    return this.conversation.appendChatMessage(message);
  }

  appendChatMessageWithinTransaction(
    message: ChatMessageInput,
  ): ChatMessageRow {
    return this.conversation.appendChatMessageWithinTransaction(message);
  }

  listChatMessages(limit: number): ChatMessageRow[] {
    return this.conversation.listChatMessages(limit);
  }

  listModelChatMessages(
    limit: number,
    throughSequence?: number,
  ): ChatMessageRow[] {
    return this.conversation.listModelChatMessages(limit, throughSequence);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  listBuckets(): BucketRow[] {
    return this.memory.listBuckets();
  }
  getBucket(id: string): BucketRow | undefined {
    return this.memory.getBucket(id);
  }
  getEntry(id: string): EntryRow | undefined {
    return this.memory.getEntry(id);
  }
  getLatestEntry(): EntryRow | undefined {
    return this.memory.getLatestEntry();
  }
  listActiveBuckets(limit: number): BucketRow[] {
    return this.memory.listActiveBuckets(limit);
  }
  searchBuckets(query: string, limit: number): BucketSearchHit[] {
    return this.memory.searchBuckets(query, limit);
  }
  listPopularActiveBuckets(limit: number): BucketRow[] {
    return this.memory.listPopularActiveBuckets(limit);
  }
  searchEntryCandidates(terms: readonly string[]): QueryEntryCandidate[] {
    return this.memory.searchEntryCandidates(terms);
  }
  listEffectiveMemoryIdsForEntry(entryId: string, bucketId: string): string[] {
    return this.memory.listEffectiveMemoryIdsForEntry(entryId, bucketId);
  }
  getBucketDetail(id: string): BucketDetail | undefined {
    return this.memory.getBucketDetail(id);
  }

  /** Return one effective TODO, excluding a revoked source Entry. */
  getTodo(todoId: string): TodoRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, bucket_id, entry_id, kind, text, status, due_at, scheduled_at,
                todo_rule_json, todo_raw_time_json, todo_occurrence, occurred_at,
                source, reason, created_at, updated_at, metadata_json
         FROM memory_items
         WHERE id = ? AND kind = 'todo'
           AND (entry_id IS NULL OR EXISTS (
             SELECT 1 FROM entries source
             WHERE source.id = memory_items.entry_id AND source.revoked_at IS NULL
           ))`,
      )
      .get(todoId) as MemoryColumns | undefined;
    return row === undefined ? undefined : toTodoRow(row);
  }

  /** Stable Agenda projection with explicit history and time-window controls. */
  listAgenda(input: TodoAgendaInput = {}): TodoRow[] {
    const now =
      input.now === undefined
        ? this.#now()
        : normalizeTodoTime(input.now, "agenda now");
    const from =
      input.from === undefined || input.from === null
        ? undefined
        : normalizeTodoTime(input.from, "agenda from");
    const to =
      input.to === undefined || input.to === null
        ? undefined
        : normalizeTodoTime(input.to, "agenda to");
    if (from !== undefined && to !== undefined && from > to) {
      throw StorageError.invalidWrite(
        "agenda",
        "from must not be later than to",
      );
    }

    const statuses = input.statuses?.map((status) => {
      if (!isTodoStatus(status)) {
        throw StorageError.invalidWrite("agenda status", "is invalid");
      }
      return status;
    });
    const where = [
      "m.kind = 'todo'",
      `(m.entry_id IS NULL OR EXISTS (
        SELECT 1 FROM entries source
        WHERE source.id = m.entry_id AND source.revoked_at IS NULL
      ))`,
    ];
    const parameters: (string | number)[] = [];
    if (input.bucketId !== undefined) {
      where.push("m.bucket_id = ?");
      parameters.push(requiredField(input.bucketId, "bucket_id"));
    }
    if (statuses !== undefined && statuses.length > 0) {
      where.push(`m.status IN (${statuses.map(() => "?").join(",")})`);
      parameters.push(...statuses);
    } else if (input.includeHistory !== true) {
      where.push("m.status IN ('open', 'in_progress', 'blocked')");
    }
    if (from !== undefined || to !== undefined) {
      const window: string[] = [];
      if (from !== undefined) {
        window.push("(m.due_at IS NULL OR m.due_at >= ?)");
        parameters.push(from);
      }
      if (to !== undefined) {
        window.push("(m.scheduled_at IS NULL OR m.scheduled_at <= ?)");
        parameters.push(to);
      }
      where.push(
        `(m.scheduled_at IS NULL AND m.due_at IS NULL OR ${window.join(" AND ")})`,
      );
    }
    const rows = this.#database
      .prepare(
        `SELECT m.id, m.bucket_id, m.entry_id, m.kind, m.text, m.status,
                m.due_at, m.scheduled_at, m.todo_rule_json, m.todo_raw_time_json,
                m.todo_occurrence, m.occurred_at, m.source, m.reason,
                m.created_at, m.updated_at, m.metadata_json
         FROM memory_items m
         WHERE ${where.join(" AND ")}
         ORDER BY
           CASE WHEN m.status IN ('open', 'in_progress', 'blocked')
                     AND m.due_at IS NOT NULL AND m.due_at < ? THEN 0 ELSE 1 END,
           CASE m.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1
                         WHEN 'blocked' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
           COALESCE(m.due_at, m.scheduled_at, '9999-12-31T23:59:59.999Z'),
           m.updated_at DESC, m.id ASC`,
      )
      .all(...parameters, now) as MemoryColumns[];
    return rows.map(toTodoRow);
  }

  transitionTodo(
    todoId: string,
    nextStatus: unknown,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    const command = requiredField(commandText, "command_text");
    const expected = requiredField(expectedUpdatedAt, "expected_updated_at");
    return withTransaction(this.#database, () => {
      const current = this.#requireTodoForMutation(todoId);
      this.#assertTodoVersion(current, expected);
      const status = transitionTodoStatus(current.status, nextStatus);
      const timestamp = this.#nextTodoTimestamp(current.updatedAt);
      this.#database
        .prepare(
          "UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ? AND updated_at = ?",
        )
        .run(status, timestamp, todoId, expected);
      const correctionId = this.#insertTodoCorrection(
        command,
        todoId,
        current,
        { ...current, status, updatedAt: timestamp },
        timestamp,
        "todo_transition",
      );
      const todo = this.#requireTodoForMutation(todoId);
      return { todo, correctionId };
    });
  }

  updateTodoPlan(
    todoId: string,
    planInput: Parameters<typeof createTodoPlan>[0],
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    const command = requiredField(commandText, "command_text");
    const expected = requiredField(expectedUpdatedAt, "expected_updated_at");
    const plan = createTodoPlan(planInput);
    return withTransaction(this.#database, () => {
      const current = this.#requireTodoForMutation(todoId);
      this.#assertTodoVersion(current, expected);
      const timestamp = this.#nextTodoTimestamp(current.updatedAt);
      const occurrence =
        plan.repeatRule === null
          ? null
          : current.todoRule === null ||
              JSON.stringify(current.todoRule) !==
                JSON.stringify(plan.repeatRule)
            ? 1
            : (current.todoOccurrence ?? 1);
      this.#database
        .prepare(
          `UPDATE memory_items
           SET scheduled_at = ?, due_at = ?, todo_rule_json = ?,
               todo_raw_time_json = ?, todo_occurrence = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(
          plan.scheduledAt,
          plan.dueAt,
          plan.repeatRule === null ? null : JSON.stringify(plan.repeatRule),
          plan.rawTime === null ? null : JSON.stringify(plan.rawTime),
          occurrence,
          timestamp,
          todoId,
          expected,
        );
      const updated = {
        ...current,
        scheduledAt: plan.scheduledAt,
        dueAt: plan.dueAt,
        todoRule: plan.repeatRule,
        todoRawTime: plan.rawTime,
        todoOccurrence: occurrence,
        updatedAt: timestamp,
      };
      const correctionId = this.#insertTodoCorrection(
        command,
        todoId,
        current,
        updated,
        timestamp,
        "todo_plan",
      );
      return { todo: this.#requireTodoForMutation(todoId), correctionId };
    });
  }

  advanceRepeatingTodo(
    todoId: string,
    commandText: string,
    expectedUpdatedAt: string,
  ): TodoMutationOutcome {
    const command = requiredField(commandText, "command_text");
    const expected = requiredField(expectedUpdatedAt, "expected_updated_at");
    return withTransaction(this.#database, () => {
      const current = this.#requireTodoForMutation(todoId);
      this.#assertTodoVersion(current, expected);
      if (current.todoRule === null || current.scheduledAt === null) {
        throw StorageError.invalidWrite(
          "todo",
          "cannot advance without a repeat rule and scheduled_at",
        );
      }
      if (current.status !== "open" && current.status !== "in_progress") {
        throw StorageError.invalidWrite(
          "todo",
          "only open or in_progress TODOs can be advanced",
        );
      }
      const next = calculateNextTodoOccurrence(
        current.scheduledAt,
        current.todoRule,
        current.todoOccurrence ?? 1,
      );
      const timestamp = this.#nextTodoTimestamp(current.updatedAt);
      let status: TodoStatus = "done";
      let scheduledAt = current.scheduledAt;
      let dueAt = current.dueAt;
      let occurrence = current.todoOccurrence ?? 1;
      if (next !== null) {
        status = "open";
        scheduledAt = next;
        occurrence += 1;
        if (current.dueAt !== null) {
          const offset =
            Date.parse(current.dueAt) - Date.parse(current.scheduledAt);
          dueAt = new Date(Date.parse(next) + offset).toISOString();
        }
      }
      this.#database
        .prepare(
          `UPDATE memory_items
           SET status = ?, scheduled_at = ?, due_at = ?, todo_occurrence = ?, updated_at = ?
           WHERE id = ? AND updated_at = ?`,
        )
        .run(
          status,
          scheduledAt,
          dueAt,
          occurrence,
          timestamp,
          todoId,
          expected,
        );
      const updated = {
        ...current,
        status,
        scheduledAt,
        dueAt,
        todoOccurrence: occurrence,
        updatedAt: timestamp,
      };
      const correctionId = this.#insertTodoCorrection(
        command,
        todoId,
        current,
        updated,
        timestamp,
        "todo_advance",
      );
      return { todo: this.#requireTodoForMutation(todoId), correctionId };
    });
  }

  #requireTodoForMutation(todoId: string): TodoRow {
    const raw = this.#database
      .prepare(
        `SELECT id, bucket_id, entry_id, kind, text, status, due_at, scheduled_at,
                todo_rule_json, todo_raw_time_json, todo_occurrence, occurred_at,
                source, reason, created_at, updated_at, metadata_json
         FROM memory_items WHERE id = ?`,
      )
      .get(todoId) as MemoryColumns | undefined;
    if (raw === undefined)
      throw StorageError.missingRecord("memory_items", todoId);
    if (raw.kind !== "todo") {
      throw StorageError.invalidWrite(
        "todo_id",
        "must reference a TODO memory",
      );
    }
    if (raw.entry_id !== null) {
      const source = this.#database
        .prepare("SELECT revoked_at FROM entries WHERE id = ?")
        .get(raw.entry_id) as { revoked_at: string | null } | undefined;
      if (source?.revoked_at !== null) {
        throw StorageError.invalidWrite("todo", "source Entry is revoked");
      }
    }
    return toTodoRow(raw);
  }

  #assertTodoVersion(todo: TodoRow, expected: string): void {
    if (todo.updatedAt !== expected) {
      throw StorageError.staleWrite("todo", todo.id);
    }
  }

  #nextTodoTimestamp(previous: string): string {
    const candidate = this.#now();
    const previousMs = Date.parse(previous);
    if (!Number.isFinite(previousMs)) {
      throw StorageError.invalidWrite("todo.updated_at", "is invalid");
    }
    return candidate > previous
      ? candidate
      : new Date(previousMs + 1).toISOString();
  }

  #insertTodoCorrection(
    command: string,
    todoId: string,
    before: TodoRow,
    after: TodoRow,
    timestamp: string,
    action: string,
  ): string {
    const correctionId = newId();
    this.#database
      .prepare(
        `INSERT INTO corrections
           (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
         VALUES (?, ?, ?, 'memory', ?, ?, ?, ?)`,
      )
      .run(
        correctionId,
        command,
        action,
        todoId,
        JSON.stringify(todoAuditSnapshot(before)),
        JSON.stringify(todoAuditSnapshot(after)),
        timestamp,
      );
    return correctionId;
  }
}

function toTodoRow(row: MemoryColumns): TodoRow {
  if (row.kind !== "todo" || !isTodoStatus(row.status)) {
    throw StorageError.invalidWrite("todo", "contains invalid stored status");
  }
  if (
    row.todo_occurrence !== null &&
    (!Number.isSafeInteger(row.todo_occurrence) || row.todo_occurrence < 1)
  ) {
    throw StorageError.invalidWrite(
      "todo_occurrence",
      "contains invalid stored data",
    );
  }
  return {
    id: row.id,
    bucketId: row.bucket_id,
    entryId: row.entry_id,
    kind: "todo",
    text: row.text,
    status: row.status,
    dueAt: row.due_at,
    scheduledAt: row.scheduled_at,
    todoRule: parseTodoRule(row.todo_rule_json),
    todoRawTime: parseTodoRawTime(row.todo_raw_time_json),
    todoOccurrence: row.todo_occurrence,
    occurredAt: row.occurred_at,
    source: row.source,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

function todoAuditSnapshot(todo: TodoRow): Record<string, unknown> {
  return {
    status: todo.status,
    scheduled_at: todo.scheduledAt,
    due_at: todo.dueAt,
    todo_rule: todo.todoRule,
    todo_raw_time: todo.todoRawTime,
    todo_occurrence: todo.todoOccurrence,
    updated_at: todo.updatedAt,
  };
}

type ArchiveAttemptColumns = {
  id: string;
  raw_text: string;
  action: ClassificationAction;
  archive_state: string;
  bucket_id: string | null;
  entry_id: string | null;
  confidence: number;
  reason: string;
  question: string | null;
  suggested_bucket_type: BucketType | null;
  suggested_title: string | null;
  candidate_bucket_ids_json: string;
  focus_bucket_id: string | null;
  prompt_version: string;
  model_name: string;
  corrected: number;
  created_at: string;
  resolved_at: string | null;
};
