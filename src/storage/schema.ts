/**
 * Canonical SQLite schema.
 *
 * The physical layout is a cleaned-up version of the Rust canonical schema —
 * the `rust_` table-name prefix is gone, since it was a legacy-compatibility
 * artifact that means nothing here. Compatibility with the old database was
 * dropped deliberately (see `docs/PLAN.md` Q3), so this is free to be a
 * straightforward design.
 *
 * What did **not** change is the transaction semantics: see
 * `docs/INVARIANTS.md` §4, all fifteen of which this layer must uphold.
 *
 * Three properties are load-bearing for the promised export/import (T17) and
 * must survive future migrations:
 *
 *   1. every row has a stable business id — nothing depends on `rowid`;
 *   2. there is no hidden state: the tables below are the whole database;
 *   3. every derived value (bucket summary, memory items) can be rebuilt from
 *      `entries.raw_text`, which is the one irreplaceable column.
 */

export const SCHEMA_VERSION = 1;
export const SCHEMA_KIND = "doggie-work-memory";

/**
 * Migrations, applied in order. Each runs inside the same transaction that
 * records it, so a failed migration leaves no trace.
 *
 * Adding a migration means appending here and bumping `SCHEMA_VERSION`; the
 * mechanism exists from the start because the agent tables (T13) are already
 * known to be coming, and inventing a migration path once there is real data
 * in the file is far more expensive.
 */
export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const CREATE_V1 = `
CREATE TABLE schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
);

CREATE TABLE buckets (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    kind           TEXT NOT NULL,
    lifecycle      TEXT NOT NULL,
    summary        TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    archived_at    TEXT,
    metadata_json  TEXT NOT NULL DEFAULT '{}'
);

-- raw_text is the evidence of record: structured extraction may be wrong, the
-- user's original words may not be lost.
CREATE TABLE entries (
    id                        TEXT PRIMARY KEY,
    bucket_id                 TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    raw_text                  TEXT NOT NULL,
    summary                   TEXT,
    content_type              TEXT NOT NULL DEFAULT 'note',
    classification_confidence REAL,
    classification_reason     TEXT,
    created_at                TEXT NOT NULL,
    moved_from_bucket_id      TEXT,
    archive_state             TEXT NOT NULL DEFAULT 'archived',
    archived_at               TEXT NOT NULL,
    metadata_json             TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE bucket_tags (
    bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (bucket_id, tag),
    UNIQUE (bucket_id, position)
);

-- One table for every structured memory kind: summary, todo, evidence,
-- timeline, decision, hypothesis, entity, tag.
-- entry_id is SET NULL rather than CASCADE: deleting one Entry must not erase
-- memory that other Entries in the Bucket still support.
CREATE TABLE memory_items (
    id            TEXT PRIMARY KEY,
    bucket_id     TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
    entry_id      TEXT REFERENCES entries(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL,
    text          TEXT NOT NULL,
    status        TEXT,
    due_at        TEXT,
    occurred_at   TEXT,
    source        TEXT,
    reason        TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
);

-- Every archive decision, including the ones that wrote nothing. A pending row
-- is what a confirmation binds to, so a client cannot forge an approval.
CREATE TABLE archive_attempts (
    id                        TEXT PRIMARY KEY,
    raw_text                  TEXT NOT NULL,
    action                    TEXT NOT NULL,
    archive_state             TEXT NOT NULL,
    bucket_id                 TEXT REFERENCES buckets(id) ON DELETE SET NULL,
    entry_id                  TEXT REFERENCES entries(id) ON DELETE SET NULL,
    confidence                REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reason                    TEXT NOT NULL,
    question                  TEXT,
    candidate_bucket_ids_json TEXT NOT NULL DEFAULT '[]',
    focus_bucket_id           TEXT,
    prompt_version            TEXT NOT NULL,
    model_name                TEXT NOT NULL,
    corrected                 INTEGER NOT NULL DEFAULT 0 CHECK (corrected IN (0, 1)),
    created_at                TEXT NOT NULL,
    resolved_at               TEXT
);

CREATE TABLE corrections (
    id           TEXT PRIMARY KEY,
    command_text TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_type  TEXT NOT NULL,
    target_id    TEXT NOT NULL,
    before_json  TEXT,
    after_json   TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE conversation_messages (
    id           TEXT PRIMARY KEY,
    sequence     INTEGER NOT NULL UNIQUE,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    tool_name    TEXT,
    tool_call_id TEXT,
    details_json TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX ix_buckets_lifecycle_activity
    ON buckets(lifecycle, last_active_at DESC, updated_at DESC);
CREATE INDEX ix_buckets_kind ON buckets(kind);
CREATE INDEX ix_entries_bucket_created ON entries(bucket_id, created_at ASC);
CREATE INDEX ix_entries_created ON entries(created_at ASC);
CREATE INDEX ix_memory_items_bucket_created ON memory_items(bucket_id, created_at ASC);
CREATE INDEX ix_memory_items_entry ON memory_items(entry_id);
CREATE INDEX ix_memory_items_kind ON memory_items(kind);
CREATE INDEX ix_archive_attempts_state_created
    ON archive_attempts(archive_state, created_at DESC);
CREATE INDEX ix_archive_attempts_bucket ON archive_attempts(bucket_id);
CREATE INDEX ix_archive_attempts_entry ON archive_attempts(entry_id);
CREATE INDEX ix_corrections_target ON corrections(target_type, target_id, created_at ASC);
CREATE INDEX ix_conversation_messages_created
    ON conversation_messages(created_at ASC, sequence ASC);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "create_memory_schema_v1", sql: CREATE_V1 },
];

/** Tables the schema owns. Used to detect a foreign database. */
export const OWNED_TABLES: readonly string[] = [
  "schema_meta",
  "schema_migrations",
  "buckets",
  "entries",
  "bucket_tags",
  "memory_items",
  "archive_attempts",
  "corrections",
  "conversation_messages",
];
