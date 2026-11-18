/** Read side for canonical memory. No mutation or model dependencies. */
import type { DatabaseSync } from "node:sqlite";
import { unicodeCaseFold } from "../domain/text.ts";
import type { BucketStatus, BucketType } from "../domain/types.ts";
import { requiredField, StorageError } from "./database.ts";
import {
  parseMetadata,
  parseTodoRawTime,
  parseTodoRule,
} from "./memory-rows.ts";
import type {
  BucketRow,
  BucketDetail,
  BucketSearchHit,
  EntryRow,
  QueryEntryCandidate,
} from "./store.ts";

export class MemoryReadStore {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

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
         FROM entries WHERE id = ? AND revoked_at IS NULL`,
      )
      .get(entryId) as EntryColumns | undefined;
    return row === undefined ? undefined : toEntryRow(row);
  }

  getLatestEntry(): EntryRow | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, bucket_id, raw_text, summary, content_type, classification_confidence,
                classification_reason, created_at, moved_from_bucket_id, archive_state, archived_at
         FROM entries WHERE revoked_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
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
      const bucketText =
        `${bucket.title} ${bucket.summary} ${bucket.tags.join(" ")}`.toLowerCase();
      let score = tokenScore(needle, bucketText);
      let matchedEntryCount = 0;
      for (const entry of detail.entries) {
        const entryText =
          `${entry.rawText} ${entry.summary ?? ""}`.toLowerCase();
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
        compareStableStrings(
          right.bucket.lastActiveAt,
          left.bucket.lastActiveAt,
        ) ||
        compareStableStrings(left.bucket.id, right.bucket.id),
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
                  (SELECT COUNT(*) FROM entries e WHERE e.bucket_id = b.id AND e.revoked_at IS NULL)
                + (SELECT COUNT(*) FROM memory_items m WHERE m.bucket_id = b.id
                   AND (m.entry_id IS NULL OR EXISTS (
                     SELECT 1 FROM entries source WHERE source.id = m.entry_id AND source.revoked_at IS NULL
                   ))) AS volume
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
           WHERE e.revoked_at IS NULL AND (${clauses.join(" OR ")})
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
         FROM entries WHERE bucket_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC`,
      )
      .all(bucketId) as EntryColumns[];

    const memories = this.#database
      .prepare(
        `SELECT id, bucket_id, entry_id, kind, text, status, due_at, scheduled_at,
                todo_rule_json, todo_raw_time_json, todo_occurrence, occurred_at,
                source, reason, created_at, updated_at, metadata_json
         FROM memory_items WHERE bucket_id = ?
           AND (entry_id IS NULL OR EXISTS (
             SELECT 1 FROM entries source WHERE source.id = memory_items.entry_id AND source.revoked_at IS NULL
           )) ORDER BY created_at ASC, id ASC`,
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

export type MemoryColumns = {
  id: string;
  bucket_id: string;
  entry_id: string | null;
  kind: string;
  text: string;
  status: string | null;
  due_at: string | null;
  scheduled_at: string | null;
  todo_rule_json: string | null;
  todo_raw_time_json: string | null;
  todo_occurrence: number | null;
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

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenScore(needle: string, haystack: string): number {
  let score = haystack.includes(needle) ? 3 : 0;
  for (const token of needle.split(/\s+/u)) {
    if (Buffer.byteLength(token, "utf8") > 1 && haystack.includes(token)) {
      score += 1;
    }
  }
  return score;
}
