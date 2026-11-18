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
  JsonValue,
  MemoryRow,
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
    const tags = groupRows(
      this.#database
        .prepare(
          "SELECT bucket_id, tag FROM bucket_tags ORDER BY bucket_id, position ASC",
        )
        .all() as { bucket_id: string; tag: string }[],
      (row) => row.bucket_id,
    );
    const buckets = this.#database
      .prepare(
        `SELECT id, title, kind, lifecycle, summary, created_at, updated_at,
              last_active_at, archived_at FROM buckets`,
      )
      .all() as BucketColumns[];
    const contexts = new Map(
      buckets.map((row) => {
        const bucket = toBucketRow(
          row,
          (tags.get(row.id) ?? []).map(({ tag }) => tag),
        );
        return [
          row.id,
          {
            bucket,
            foldedPrefix:
              foldedTerms.length === 0
                ? ""
                : unicodeCaseFold(
                    [bucket.title, bucket.summary, ...bucket.tags].join(" ") +
                      " ",
                  ),
          },
        ];
      }),
    );
    const entries = this.#database
      .prepare(
        `SELECT e.id, e.bucket_id, e.raw_text, e.summary, e.content_type, e.classification_confidence,
              e.classification_reason, e.created_at, e.moved_from_bucket_id, e.archive_state, e.archived_at
       FROM entries e JOIN buckets b ON b.id = e.bucket_id
       WHERE e.revoked_at IS NULL
       ORDER BY b.created_at ASC, b.id ASC, e.created_at ASC, e.id ASC`,
      )
      .all() as EntryColumns[];
    const memoryRows = this.#database
      .prepare(
        `SELECT m.id, m.bucket_id, m.entry_id, m.kind, m.text, m.status, m.due_at, m.scheduled_at,
              m.todo_rule_json, m.todo_raw_time_json, m.todo_occurrence, m.occurred_at,
              m.source, m.reason, m.created_at, m.updated_at, m.metadata_json
       FROM memory_items m JOIN entries e ON e.id = m.entry_id AND e.bucket_id = m.bucket_id
       WHERE e.revoked_at IS NULL ORDER BY m.created_at ASC, m.id ASC`,
      )
      .all() as (MemoryColumns & { entry_id: string })[];
    const byEntry = groupRows(memoryRows, (row) => row.entry_id);

    const candidates: QueryEntryCandidate[] = [];
    for (const entry of entries) {
      const context = contexts.get(entry.bucket_id);
      // The joined Entry query excludes missing buckets. The lookup also avoids
      // emitting a candidate if the separately read Bucket has disappeared.
      if (context === undefined) continue;
      const memories = byEntry.get(entry.id) ?? [];
      const metadata = memories.map((memory) =>
        parseMetadata(memory.metadata_json),
      );
      if (foldedTerms.length > 0 && !sqlMatchedIds.has(entry.id)) {
        const corpus =
          context.foldedPrefix +
          unicodeCaseFold(
            [
              entry.raw_text,
              entry.summary ?? "",
              entry.content_type,
              ...memories.flatMap((memory, index) => [
                memory.kind,
                memory.text,
                memory.status ?? "",
                memory.source ?? "",
                JSON.stringify(metadata[index]),
              ]),
            ].join(" "),
          );
        if (!foldedTerms.some((term) => corpus.includes(term))) continue;
      }
      candidates.push({
        bucket: context.bucket,
        entry: toEntryRow(entry),
        memories: memories.map((row, index) =>
          toMemoryRow(row, metadata[index]),
        ),
      });
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
      memories: memories.map((row) => toMemoryRow(row)),
    };
  }

  #toBucketRow(row: BucketColumns): BucketRow {
    const tags = this.#database
      .prepare(
        "SELECT tag FROM bucket_tags WHERE bucket_id = ? ORDER BY position ASC",
      )
      .all(row.id) as { tag: string }[];
    return toBucketRow(
      row,
      tags.map((tag) => tag.tag),
    );
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

function groupRows<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [row]);
    else group.push(row);
  }
  return groups;
}

function toBucketRow(row: BucketColumns, tags: readonly string[]): BucketRow {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as BucketType,
    lifecycle: row.lifecycle as BucketStatus,
    summary: row.summary,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at,
  };
}

function toMemoryRow(
  row: MemoryColumns,
  metadata: JsonValue = parseMetadata(row.metadata_json),
): MemoryRow {
  return {
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
    metadata,
  };
}

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
