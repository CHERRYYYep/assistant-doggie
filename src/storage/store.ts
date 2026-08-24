/**
 * The transactional store.
 *
 * Every method that changes anything does so inside exactly one transaction,
 * so a failure anywhere leaves the database as it was. That is
 * `docs/INVARIANTS.md` §4.1–§4.2 and it is the reason this layer exists as a
 * boundary at all: callers get typed operations, never a SQL connection.
 */

import type { DatabaseSync } from "node:sqlite";

import type {
  BucketStatus,
  BucketType,
  ClassificationAction,
} from "../domain/types.ts";
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
  readonly occurredAt: string | null;
  readonly source: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: JsonValue;
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

export type DeleteBucketOutcome = {
  readonly bucketId: string;
  readonly deletedEntryIds: readonly string[];
  readonly deletedMemoryItemIds: readonly string[];
  readonly updatedArchiveAttemptIds: readonly string[];
  readonly correctionId: string;
};

export type ChatMessageRow = {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly content: string;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly details: unknown;
  readonly createdAt: string;
};

export class Store {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;

  constructor(database: DatabaseSync, clock: Clock = systemClock) {
    this.#database = database;
    this.#clock = clock;
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
  ): ArchiveOutcome {
    const text = requiredField(rawText, "raw_text");
    const promptVersion = requiredField(audit.promptVersion, "prompt_version");
    const modelName = requiredField(audit.modelName, "model_name");

    return withTransaction(this.#database, () => {
      const timestamp = this.#now();
      const attemptId = newId();
      const confirmationAttemptId = audit.confirmationAttemptId;
      if (confirmationAttemptId !== undefined) {
        this.#requirePendingAttempt(confirmationAttemptId, text);
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
        return {
          attemptId,
          archiveState: "needs_confirmation" as const,
          bucketId: undefined,
          entryId: undefined,
        };
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
          : this.#requireBucket(
              decision.bucketId,
              timestamp,
              confirmationAttemptId !== undefined,
            );

      const entryId = this.#insertEntry(
        bucketId,
        text,
        decision,
        extraction,
        timestamp,
      );
      this.#insertMemories(bucketId, entryId, extraction, timestamp);
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
      }

      return {
        attemptId,
        archiveState: "archived" as const,
        bucketId,
        entryId,
      };
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

  #requireBucket(
    bucketId: string | undefined,
    timestamp: string,
    requireActive = false,
  ): string {
    if (bucketId === undefined) {
      throw StorageError.invalidWrite("append_existing", "requires bucket_id");
    }
    const bucket = this.#database
      .prepare("SELECT lifecycle FROM buckets WHERE id = ?")
      .get(bucketId) as { lifecycle: string } | undefined;
    if (bucket === undefined)
      throw StorageError.missingRecord("buckets", bucketId);
    if (requireActive && bucket.lifecycle !== "active") {
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
  ): string[] {
    const seen = dedupeExisting
      ? this.#existingMemoryKeys(bucketId)
      : new Set<string>();
    const insert = this.#database.prepare(
      `INSERT INTO memory_items
         (id, bucket_id, entry_id, kind, text, status, occurred_at, source,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertedIds: string[] = [];
    for (const row of extractionToMemoryRows(extraction)) {
      const key = this.#memoryKey(row);
      if (seen.has(key)) continue;
      const id = newId();
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
      insertedIds.push(id);
      seen.add(key);
    }
    return insertedIds;
  }

  #existingMemoryKeys(bucketId: string): Set<string> {
    const rows = this.#database
      .prepare(
        "SELECT kind, text, occurred_at FROM memory_items WHERE bucket_id = ?",
      )
      .all(bucketId) as {
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
  }

  #requirePendingAttempt(
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
      this.#requirePendingAttempt(id, text);
      const updated = this.#database
        .prepare(
          `UPDATE archive_attempts
           SET archive_state = 'discarded', resolved_at = ?
           WHERE id = ? AND archive_state = 'needs_confirmation'
             AND resolved_at IS NULL AND corrected = 0`,
        )
        .run(this.#now(), id);
      if (updated.changes !== 1) {
        throw StorageError.archiveAttemptNotPending(id);
      }
    });
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
        .prepare("SELECT bucket_id FROM entries WHERE id = ?")
        .get(entryId) as { bucket_id: string } | undefined;
      if (source === undefined)
        throw StorageError.missingRecord("entries", entryId);

      const targetExists = this.#database
        .prepare("SELECT 1 FROM buckets WHERE id = ?")
        .get(targetBucketId);
      if (targetExists === undefined)
        throw StorageError.missingRecord("buckets", targetBucketId);

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
        `SELECT summary FROM entries WHERE bucket_id = ?
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
             (id, command_text, action, target_type, target_id, before_json, created_at)
           VALUES (?, ?, 'delete_bucket', 'bucket', ?, ?, ?)`,
        )
        .run(
          correctionId,
          command,
          bucketId,
          JSON.stringify({ bucket_id: bucketId }),
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

  /** Delete one Entry, leaving its Bucket and the other Entries intact. */
  deleteEntry(entryId: string, commandText: string): void {
    const command = requiredField(commandText, "command_text");
    withTransaction(this.#database, () => {
      const entry = this.#database
        .prepare("SELECT bucket_id FROM entries WHERE id = ?")
        .get(entryId) as { bucket_id: string } | undefined;
      if (entry === undefined)
        throw StorageError.missingRecord("entries", entryId);

      const timestamp = this.#now();
      this.#database.prepare("DELETE FROM entries WHERE id = ?").run(entryId);
      this.#rebuildSummary(entry.bucket_id, timestamp);
      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, created_at)
           VALUES (?, ?, 'delete_entry', 'entry', ?, ?, ?)`,
        )
        .run(
          newId(),
          command,
          entryId,
          JSON.stringify({ bucket_id: entry.bucket_id }),
          timestamp,
        );
    });
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

  // ── conversation ─────────────────────────────────────────────────────────

  /** Append one chat message. `sequence` is assigned inside the transaction. */
  appendChatMessage(message: {
    role: "user" | "assistant" | "tool";
    content: string;
    toolName?: string | undefined;
    toolCallId?: string | undefined;
    details?: unknown;
  }): ChatMessageRow {
    const content = requiredField(message.content, "content");
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS max FROM conversation_messages",
        )
        .get() as { max: number };
      const id = newId();
      const createdAt = this.#now();
      const toolName = optionalField(message.toolName);
      const toolCallId = optionalField(message.toolCallId);
      this.#database
        .prepare(
          `INSERT INTO conversation_messages
             (id, sequence, role, content, tool_name, tool_call_id, details_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          row.max + 1,
          message.role,
          content,
          toolName,
          toolCallId,
          message.details === undefined
            ? null
            : JSON.stringify(message.details),
          createdAt,
        );
      return {
        id,
        sequence: row.max + 1,
        role: message.role,
        content,
        toolName,
        toolCallId,
        details: message.details,
        createdAt,
      };
    });
  }

  /** Most recent `limit` messages, returned oldest-first for rendering. */
  listChatMessages(limit: number): ChatMessageRow[] {
    const rows = this.#database
      .prepare(
        `SELECT id, sequence, role, content, tool_name, tool_call_id, details_json, created_at
         FROM conversation_messages ORDER BY sequence DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      sequence: number;
      role: string;
      content: string;
      tool_name: string | null;
      tool_call_id: string | null;
      details_json: string | null;
      created_at: string;
    }[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      toolName: row.tool_name,
      toolCallId: row.tool_call_id,
      details:
        row.details_json === null ? undefined : JSON.parse(row.details_json),
      createdAt: row.created_at,
    }));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  listBuckets(): BucketRow[] {
    const rows = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                last_active_at, archived_at
         FROM buckets ORDER BY created_at ASC, id ASC`,
      )
      .all() as BucketColumns[];
    return rows.map((row) => this.#toBucketRow(row));
  }

  getBucket(bucketId: string): BucketRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                last_active_at, archived_at
         FROM buckets WHERE id = ?`,
      )
      .get(bucketId) as BucketColumns | undefined;
    return row === undefined ? undefined : this.#toBucketRow(row);
  }

  getEntry(entryId: string): EntryRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state, archived_at
         FROM entries WHERE id = ?`,
      )
      .get(entryId) as EntryColumns | undefined;
    return row === undefined ? undefined : toEntryRow(row);
  }

  getLatestEntry(): EntryRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state, archived_at
         FROM entries ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get() as EntryColumns | undefined;
    return row === undefined ? undefined : toEntryRow(row);
  }

  /** Active Buckets, most recently active first (§4.15). */
  listActiveBuckets(limit: number): BucketRow[] {
    const rows = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
                last_active_at, archived_at
         FROM buckets WHERE lifecycle = 'active'
         ORDER BY last_active_at DESC, updated_at DESC, id ASC LIMIT ?`,
      )
      .all(limit) as BucketColumns[];
    return rows.map((row) => this.#toBucketRow(row));
  }

  /** Legacy Bucket-level search kept separate from Entry query planning. */
  searchBuckets(query: string, limit: number): BucketSearchHit[] {
    const cleaned = requiredField(query, "query");
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw StorageError.invalidWrite("limit", "must be a positive integer");
    }
    const needle = cleaned.toLowerCase();
    const hits: BucketSearchHit[] = [];
    for (const bucket of this.listBuckets()) {
      const detail = this.getBucketDetail(bucket.id);
      if (detail === undefined) continue;
      const bucketText = `${bucket.title} ${bucket.summary} ${bucket.tags.join(" ")}`.toLowerCase();
      let score = tokenScore(needle, bucketText);
      let matchedEntryCount = 0;
      for (const entry of detail.entries) {
        const entryText = `${entry.rawText} ${entry.summary ?? ""}`.toLowerCase();
        const entryScore = tokenScore(needle, entryText);
        if (entryScore > 0) {
          matchedEntryCount += 1;
          score += entryScore + 1;
        }
      }
      if (score > 0) hits.push({ bucket, matchedEntryCount, score });
    }
    hits.sort(
      (left, right) =>
        right.score - left.score ||
        right.bucket.lastActiveAt.localeCompare(left.bucket.lastActiveAt) ||
        left.bucket.id.localeCompare(right.bucket.id),
    );
    hits.splice(limit);
    return hits;
  }

  /**
   * Active Buckets ranked by volume of Entries and memory items (§2.2).
   *
   * "Popular" is a proxy for "the contexts this person actually works in",
   * which recency alone misses for a Bucket touched steadily but not lately.
   */
  listPopularActiveBuckets(limit: number): BucketRow[] {
    const rows = this.#database
      .prepare(
        `SELECT b.id, b.title, b.kind, b.lifecycle, b.summary,
                b.created_at, b.updated_at, b.last_active_at, b.archived_at,
                  (SELECT COUNT(*) FROM entries e WHERE e.bucket_id = b.id)
                + (SELECT COUNT(*) FROM memory_items m WHERE m.bucket_id = b.id) AS volume
         FROM buckets b WHERE b.lifecycle = 'active'
         ORDER BY volume DESC, b.last_active_at DESC, b.id ASC LIMIT ?`,
      )
      .all(limit) as BucketColumns[];
    return rows.map((row) => this.#toBucketRow(row));
  }

  /**
   * Return Entry-level query candidates without mutating activity timestamps.
   *
   * SQLite narrows ordinary literal matches, while the folded in-memory pass
   * preserves the repository's Unicode identity rule (for example Straße /
   * STRASSE). LIKE metacharacters and the slash escape character are always
   * escaped before binding; user text is never interpolated into SQL.
   */
  searchEntryCandidates(terms: readonly string[]): QueryEntryCandidate[] {
    const normalizedTerms = [
      ...new Set(
        terms.map((term) => term.trim()).filter((term) => term !== ""),
      ),
    ];
    const sqlMatchedIds = new Set<string>();

    if (normalizedTerms.length > 0) {
      const clauses = normalizedTerms.map(
        () => `(
          b.title LIKE ? ESCAPE '/' OR b.summary LIKE ? ESCAPE '/'
          OR e.raw_text LIKE ? ESCAPE '/' OR COALESCE(e.summary, '') LIKE ? ESCAPE '/'
          OR e.content_type LIKE ? ESCAPE '/'
          OR EXISTS (
            SELECT 1 FROM bucket_tags bt
            WHERE bt.bucket_id = b.id AND bt.tag LIKE ? ESCAPE '/'
          )
          OR EXISTS (
            SELECT 1 FROM memory_items mi
            WHERE mi.entry_id = e.id AND (
              mi.text LIKE ? ESCAPE '/' OR mi.kind LIKE ? ESCAPE '/'
              OR COALESCE(mi.status, '') LIKE ? ESCAPE '/'
              OR COALESCE(mi.source, '') LIKE ? ESCAPE '/'
              OR mi.metadata_json LIKE ? ESCAPE '/'
            )
          )
        )`,
      );
      const parameters = normalizedTerms.flatMap((term) => {
        const pattern = `%${escapeLikeLiteral(term)}%`;
        return Array.from({ length: 11 }, () => pattern);
      });
      const rows = this.#database
        .prepare(
          `SELECT e.id
           FROM entries e JOIN buckets b ON b.id = e.bucket_id
           WHERE ${clauses.join(" OR ")}
           ORDER BY e.created_at ASC, e.id ASC`,
        )
        .all(...parameters) as { id: string }[];
      for (const row of rows) sqlMatchedIds.add(row.id);
    }

    const foldedTerms = normalizedTerms.map(unicodeCaseFold);
    const candidates: QueryEntryCandidate[] = [];
    for (const bucket of this.listBuckets()) {
      const detail = this.getBucketDetail(bucket.id);
      if (detail === undefined) continue;
      for (const entry of detail.entries) {
        const memories = detail.memories.filter(
          (memory) => memory.entryId === entry.id,
        );
        const corpus = unicodeCaseFold(
          [
            bucket.title,
            bucket.summary,
            ...bucket.tags,
            entry.rawText,
            entry.summary ?? "",
            entry.contentType,
            ...memories.flatMap((memory) => [
              memory.kind,
              memory.text,
              memory.status ?? "",
              memory.source ?? "",
              JSON.stringify(memory.metadata),
            ]),
          ].join(" "),
        );
        if (
          foldedTerms.length === 0 ||
          sqlMatchedIds.has(entry.id) ||
          foldedTerms.some((term) => corpus.includes(term))
        ) {
          candidates.push({ bucket, entry, memories });
        }
      }
    }
    return candidates;
  }

  getBucketDetail(bucketId: string): BucketDetail | undefined {
    const bucket = this.getBucket(bucketId);
    if (bucket === undefined) return undefined;

    const entries = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state, archived_at
         FROM entries WHERE bucket_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(bucketId) as EntryColumns[];

    const memories = this.#database
      .prepare(
        `SELECT id, bucket_id, entry_id, kind, text, status, due_at, occurred_at,
                source, reason, created_at, updated_at, metadata_json
         FROM memory_items WHERE bucket_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(bucketId) as MemoryColumns[];

    return {
      bucket,
      entries: entries.map(toEntryRow),
      memories: memories.map((row) => ({
        id: row.id,
        bucketId: row.bucket_id,
        entryId: row.entry_id,
        kind: row.kind,
        text: row.text,
        status: row.status,
        dueAt: row.due_at,
        occurredAt: row.occurred_at,
        source: row.source,
        reason: row.reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadata: parseMetadata(row.metadata_json),
      })),
    };
  }

  #toBucketRow(row: BucketColumns): BucketRow {
    const tags = this.#database
      .prepare(
        "SELECT tag FROM bucket_tags WHERE bucket_id = ? ORDER BY position ASC",
      )
      .all(row.id) as { tag: string }[];
    return {
      id: row.id,
      title: row.title,
      kind: row.kind as BucketType,
      lifecycle: row.lifecycle as BucketStatus,
      summary: row.summary,
      tags: tags.map((tag) => tag.tag),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastActiveAt: row.last_active_at,
      archivedAt: row.archived_at,
    };
  }
}

type BucketColumns = {
  id: string;
  title: string;
  kind: string;
  lifecycle: string;
  summary: string;
  created_at: string;
  updated_at: string;
  last_active_at: string;
  archived_at: string | null;
};

type EntryColumns = {
  id: string;
  bucket_id: string;
  raw_text: string;
  summary: string | null;
  content_type: string;
  classification_confidence: number | null;
  classification_reason: string | null;
  created_at: string;
  moved_from_bucket_id: string | null;
  archive_state: string;
  archived_at: string;
};

type MemoryColumns = {
  id: string;
  bucket_id: string;
  entry_id: string | null;
  kind: string;
  text: string;
  status: string | null;
  due_at: string | null;
  occurred_at: string | null;
  source: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

function escapeLikeLiteral(value: string): string {
  return value
    .replaceAll("/", "//")
    .replaceAll("%", "/%")
    .replaceAll("_", "/_");
}

function parseMetadata(value: string): JsonValue {
  return JSON.parse(value) as JsonValue;
}

function toEntryRow(row: EntryColumns): EntryRow {
  return {
    id: row.id,
    bucketId: row.bucket_id,
    rawText: row.raw_text,
    summary: row.summary,
    contentType: row.content_type,
    classificationConfidence: row.classification_confidence,
    classificationReason: row.classification_reason,
    createdAt: row.created_at,
    movedFromBucketId: row.moved_from_bucket_id,
    archiveState: row.archive_state,
    archivedAt: row.archived_at,
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

function tokenScore(needle: string, haystack: string): number {
  let score = haystack.includes(needle) ? 3 : 0;
  for (const token of needle.split(/\s+/u)) {
    if (Buffer.byteLength(token, "utf8") > 1 && haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}
