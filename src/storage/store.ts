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
import { mergeTags, normalizedKey } from "../domain/text.ts";
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
};

export type MemoryRow = {
  readonly id: string;
  readonly bucketId: string;
  readonly entryId: string | null;
  readonly kind: string;
  readonly text: string;
  readonly status: string | null;
  readonly occurredAt: string | null;
  readonly createdAt: string;
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

export type SaveExtractionInput = {
  readonly bucketId: string;
  readonly entryId: string;
  readonly extraction: ExtractionResult;
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
          : this.#requireBucket(decision.bucketId, timestamp);

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

  #requireBucket(bucketId: string | undefined, timestamp: string): string {
    if (bucketId === undefined) {
      throw StorageError.invalidWrite("append_existing", "requires bucket_id");
    }
    const exists = this.#database
      .prepare("SELECT 1 FROM buckets WHERE id = ?")
      .get(bucketId);
    if (exists === undefined)
      throw StorageError.missingRecord("buckets", bucketId);
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
            reason, question, candidate_bucket_ids_json, focus_bucket_id,
            prompt_version, model_name, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(candidateBucketIds),
        optionalField(audit.focusBucketId),
        context.promptVersion,
        context.modelName,
        context.timestamp,
        context.archiveState === "archived" ? context.timestamp : null,
      );
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
  ): EntryRow {
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

      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, after_json, created_at)
           VALUES (?, ?, 'move_entry', 'entry', ?, ?, ?, ?)`,
        )
        .run(
          newId(),
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
      return moved;
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
  deleteBucket(bucketId: string, commandText: string): void {
    const command = requiredField(commandText, "command_text");
    withTransaction(this.#database, () => {
      const exists = this.#database
        .prepare("SELECT 1 FROM buckets WHERE id = ?")
        .get(bucketId);
      if (exists === undefined)
        throw StorageError.missingRecord("buckets", bucketId);

      // Entries, tags and memory go by ON DELETE CASCADE; archive attempts
      // keep their audit row with the link cleared by ON DELETE SET NULL.
      this.#database.prepare("DELETE FROM buckets WHERE id = ?").run(bucketId);
      this.#database
        .prepare(
          `INSERT INTO corrections
             (id, command_text, action, target_type, target_id, before_json, created_at)
           VALUES (?, ?, 'delete_bucket', 'bucket', ?, ?, ?)`,
        )
        .run(
          newId(),
          command,
          bucketId,
          JSON.stringify({ bucket_id: bucketId }),
          this.#now(),
        );
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

  // ── conversation ─────────────────────────────────────────────────────────

  /** Append one chat message. `sequence` is assigned inside the transaction. */
  appendChatMessage(message: {
    role: "user" | "assistant" | "tool";
    content: string;
    toolName?: string | undefined;
    toolCallId?: string | undefined;
    details?: unknown;
  }): string {
    const content = requiredField(message.content, "content");
    return withTransaction(this.#database, () => {
      const row = this.#database
        .prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS max FROM conversation_messages",
        )
        .get() as { max: number };
      const id = newId();
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
          optionalField(message.toolName),
          optionalField(message.toolCallId),
          message.details === undefined
            ? null
            : JSON.stringify(message.details),
          this.#now(),
        );
      return id;
    });
  }

  /** Most recent `limit` messages, returned oldest-first for rendering. */
  listChatMessages(limit: number): {
    id: string;
    sequence: number;
    role: string;
    content: string;
    toolName: string | null;
    details: unknown;
    createdAt: string;
  }[] {
    const rows = this.#database
      .prepare(
        `SELECT id, sequence, role, content, tool_name, details_json, created_at
         FROM conversation_messages ORDER BY sequence DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      sequence: number;
      role: string;
      content: string;
      tool_name: string | null;
      details_json: string | null;
      created_at: string;
    }[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sequence: row.sequence,
      role: row.role,
      content: row.content,
      toolName: row.tool_name,
      details:
        row.details_json === null ? undefined : JSON.parse(row.details_json),
      createdAt: row.created_at,
    }));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  getBucket(bucketId: string): BucketRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at, last_active_at
         FROM buckets WHERE id = ?`,
      )
      .get(bucketId) as BucketColumns | undefined;
    return row === undefined ? undefined : this.#toBucketRow(row);
  }

  getEntry(entryId: string): EntryRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state
         FROM entries WHERE id = ?`,
      )
      .get(entryId) as EntryColumns | undefined;
    return row === undefined ? undefined : toEntryRow(row);
  }

  /** Active Buckets, most recently active first (§4.15). */
  listActiveBuckets(limit: number): BucketRow[] {
    const rows = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at, last_active_at
         FROM buckets WHERE lifecycle = 'active'
         ORDER BY last_active_at DESC, updated_at DESC, id ASC LIMIT ?`,
      )
      .all(limit) as BucketColumns[];
    return rows.map((row) => this.#toBucketRow(row));
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
                b.created_at, b.updated_at, b.last_active_at,
                  (SELECT COUNT(*) FROM entries e WHERE e.bucket_id = b.id)
                + (SELECT COUNT(*) FROM memory_items m WHERE m.bucket_id = b.id) AS volume
         FROM buckets b WHERE b.lifecycle = 'active'
         ORDER BY volume DESC, b.last_active_at DESC, b.id ASC LIMIT ?`,
      )
      .all(limit) as BucketColumns[];
    return rows.map((row) => this.#toBucketRow(row));
  }

  getBucketDetail(bucketId: string): BucketDetail | undefined {
    const bucket = this.getBucket(bucketId);
    if (bucket === undefined) return undefined;

    const entries = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state
         FROM entries WHERE bucket_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(bucketId) as EntryColumns[];

    const memories = this.#database
      .prepare(
        `SELECT id, bucket_id, entry_id, kind, text, status, occurred_at, created_at
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
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
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
};

type MemoryColumns = {
  id: string;
  bucket_id: string;
  entry_id: string | null;
  kind: string;
  text: string;
  status: string | null;
  occurred_at: string | null;
  created_at: string;
};

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
  };
}
