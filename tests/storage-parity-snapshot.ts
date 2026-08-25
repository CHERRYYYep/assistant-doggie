/**
 * Normalize a storage database into stable, semantic JSON.
 *
 * UUIDs and timestamps intentionally disappear: the parity contract is the
 * graph and its values, not which implementation generated an identifier or
 * how its timestamp was formatted. Deleted Bucket ids are assigned stable
 * symbolic names so correction snapshots remain comparable after cascade.
 */

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

function rows<T extends object>(database: DatabaseSync, sql: string): T[] {
  return database.prepare(sql).all() as T[];
}

/**
 * Order two records deterministically by their serialized form.
 *
 * Code-point comparison, deliberately **not** `localeCompare`: that consults
 * the runtime's collation, so the same two CJK records sort one way under a
 * `zh-CN` default locale and the other way under `C`/`en-US`. A snapshot
 * comparison sorted that way passes on the author's machine and fails in CI
 * for reasons that have nothing to do with the storage layer.
 */
function compareJson(left: unknown, right: unknown): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function snapshotStorage(database: DatabaseSync): object {
  const buckets = rows<{
    id: string;
    title: string;
    kind: string;
    lifecycle: string;
    summary: string;
  }>(database, "SELECT id, title, kind, lifecycle, summary FROM buckets");
  const entries = rows<{
    id: string;
    bucket_id: string;
    raw_text: string;
    summary: string | null;
    content_type: string;
    classification_confidence: number | null;
    classification_reason: string | null;
    moved_from_bucket_id: string | null;
    archive_state: string;
  }>(
    database,
    `SELECT id, bucket_id, raw_text, summary, content_type,
            classification_confidence, classification_reason,
            moved_from_bucket_id, archive_state
     FROM entries`,
  );

  const bucketNames = new Map(
    buckets.map((bucket) => [bucket.id, `bucket:${bucket.title}`]),
  );
  const entryNames = new Map(
    entries.map((entry) => [entry.id, `entry:${entry.raw_text}`]),
  );
  const deletedBucketNames = new Map<string, string>();
  const bucketName = (id: string | null): string | null => {
    if (id === null) return null;
    const current = bucketNames.get(id);
    if (current !== undefined) return current;
    let deleted = deletedBucketNames.get(id);
    if (deleted === undefined) {
      deleted = `deleted-bucket:${deletedBucketNames.size + 1}`;
      deletedBucketNames.set(id, deleted);
    }
    return deleted;
  };
  const entryName = (id: string | null): string | null => {
    if (id === null) return null;
    const name = entryNames.get(id);
    if (name === undefined)
      throw new Error(`unknown Entry id in snapshot: ${id}`);
    return name;
  };

  // Discover deleted Bucket ids in deterministic Entry order before any JSON
  // snapshot references them. Code-point order, not collation — see
  // `compareJson`.
  for (const entry of [...entries].sort((a, b) =>
    a.raw_text < b.raw_text ? -1 : a.raw_text > b.raw_text ? 1 : 0,
  )) {
    bucketName(entry.moved_from_bucket_id);
  }

  const tags = rows<{ bucket_id: string; tag: string; position: number }>(
    database,
    "SELECT bucket_id, tag, position FROM bucket_tags",
  );
  const memories = rows<{
    bucket_id: string;
    entry_id: string | null;
    kind: string;
    text: string;
    status: string | null;
    due_at: string | null;
    occurred_at: string | null;
    source: string | null;
    reason: string | null;
  }>(
    database,
    `SELECT bucket_id, entry_id, kind, text, status, due_at, occurred_at,
            source, reason
     FROM memory_items`,
  );
  const attempts = rows<{
    raw_text: string;
    action: string;
    archive_state: string;
    bucket_id: string | null;
    entry_id: string | null;
    confidence: number;
    reason: string;
    question: string | null;
    candidate_bucket_ids_json: string;
    focus_bucket_id: string | null;
    prompt_version: string;
    model_name: string;
    corrected: number;
    resolved_at: string | null;
  }>(
    database,
    `SELECT raw_text, action, archive_state, bucket_id, entry_id, confidence,
            reason, question, candidate_bucket_ids_json, focus_bucket_id,
            prompt_version, model_name, corrected, resolved_at
     FROM archive_attempts`,
  );
  const corrections = rows<{
    command_text: string;
    action: string;
    target_type: string;
    target_id: string;
    before_json: string | null;
    after_json: string | null;
  }>(
    database,
    `SELECT command_text, action, target_type, target_id, before_json, after_json
     FROM corrections`,
  );
  const messages = rows<{
    sequence: number;
    role: string;
    content: string;
    tool_name: string | null;
    tool_call_id: string | null;
    details_json: string | null;
  }>(
    database,
    `SELECT sequence, role, content, tool_name, tool_call_id, details_json
     FROM conversation_messages`,
  );

  const normalizeCorrectionJson = (value: string | null): object | null => {
    if (value === null) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed["bucket_id"] === "string") {
      parsed["bucket_id"] = bucketName(parsed["bucket_id"]);
    }
    return parsed;
  };

  return {
    buckets: buckets
      .map((bucket) => ({
        name: bucketName(bucket.id),
        title: bucket.title,
        kind: bucket.kind,
        lifecycle: bucket.lifecycle,
        summary: bucket.summary,
        tags: tags
          .filter((tag) => tag.bucket_id === bucket.id)
          .sort((a, b) => a.position - b.position)
          .map((tag) => tag.tag),
      }))
      .sort(compareJson),
    entries: entries
      .map((entry) => ({
        name: entryName(entry.id),
        bucket: bucketName(entry.bucket_id),
        rawText: entry.raw_text,
        summary: entry.summary,
        contentType: entry.content_type,
        confidence: entry.classification_confidence,
        reason: entry.classification_reason,
        movedFromBucket: bucketName(entry.moved_from_bucket_id),
        archiveState: entry.archive_state,
      }))
      .sort(compareJson),
    memories: memories
      .map((memory) => ({
        bucket: bucketName(memory.bucket_id),
        entry: entryName(memory.entry_id),
        kind: memory.kind,
        text: memory.text,
        status: memory.status,
        dueAt: memory.due_at,
        occurredAt: memory.occurred_at,
        source: memory.source,
        reason: memory.reason,
      }))
      .sort(compareJson),
    archiveAttempts: attempts
      .map((attempt) => ({
        rawText: attempt.raw_text,
        action: attempt.action,
        archiveState: attempt.archive_state,
        bucket: bucketName(attempt.bucket_id),
        entry: entryName(attempt.entry_id),
        confidence: attempt.confidence,
        reason: attempt.reason,
        question: attempt.question,
        candidateBuckets: (
          JSON.parse(attempt.candidate_bucket_ids_json) as string[]
        ).map(bucketName),
        focusBucket: bucketName(attempt.focus_bucket_id),
        promptVersion: attempt.prompt_version,
        modelName: attempt.model_name,
        corrected: attempt.corrected === 1,
        resolved: attempt.resolved_at !== null,
      }))
      .sort(compareJson),
    corrections: corrections
      .map((correction) => ({
        commandText: correction.command_text,
        action: correction.action,
        targetType: correction.target_type,
        target: entryName(correction.target_id),
        before: normalizeCorrectionJson(correction.before_json),
        after: normalizeCorrectionJson(correction.after_json),
      }))
      .sort(compareJson),
    conversationMessages: messages
      .map((message) => ({
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        toolName: message.tool_name,
        toolCallId: message.tool_call_id,
        details:
          message.details_json === null
            ? null
            : (JSON.parse(message.details_json) as unknown),
      }))
      .sort(compareJson),
  };
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === ownPath) {
  const databasePath = process.argv[2];
  if (databasePath === undefined) {
    throw new Error("usage: node tests/storage-parity-snapshot.ts DATABASE");
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    process.stdout.write(
      `${JSON.stringify(snapshotStorage(database), null, 2)}\n`,
    );
  } finally {
    database.close();
  }
}
