/**
 * Canonical SQLite schema.
 *
 * TypeScript owns this schema; pre-TS databases are not imported.
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

export const SCHEMA_VERSION = 7;
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
-- Legacy physical deletion leaves entry_id NULL. Current Entry revocation
-- preserves this link, and effective reads exclude a revoked source.
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

const ADD_PENDING_SUGGESTIONS_V2 = `
ALTER TABLE archive_attempts ADD COLUMN suggested_bucket_type TEXT;
ALTER TABLE archive_attempts ADD COLUMN suggested_title TEXT;
`;

const ADD_PENDING_ACTIONS_V3 = `
CREATE TABLE pending_actions (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('archive', 'agent_task', 'scheduled_run', 'bulk_mutation')),
    proposed_by   TEXT NOT NULL CHECK (proposed_by IN ('model', 'schedule', 'user')),
    binding_text  TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
    approval_json TEXT,
    result_json   TEXT,
    failure_code  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX ix_pending_actions_status_created ON pending_actions(status, created_at, id);

-- Preserve existing confirmation IDs and raw input; history cards need no rewrite.
-- Archive attempts remain the historical audit projection, not approval authority.
INSERT INTO pending_actions
    (id, kind, proposed_by, binding_text, payload_json, status, result_json, created_at, updated_at)
SELECT id, 'archive', 'model', raw_text,
    json_object('rawText', raw_text, 'candidateBucketIds', json(candidate_bucket_ids_json),
      'focusBucketId', focus_bucket_id, 'suggestedBucketType', suggested_bucket_type,
      'suggestedTitle', suggested_title),
    CASE WHEN archive_state = 'needs_confirmation' AND resolved_at IS NULL AND corrected = 0 THEN 'pending'
         WHEN archive_state = 'archived' THEN 'executed' ELSE 'rejected' END,
    CASE WHEN archive_state = 'archived' THEN json_object('referenceId', id) ELSE NULL END,
    created_at, COALESCE(resolved_at, created_at)
FROM archive_attempts WHERE action = 'ask_user';

CREATE TRIGGER pending_action_proposal_immutable
BEFORE UPDATE OF id, kind, proposed_by, binding_text, payload_json, created_at ON pending_actions
BEGIN
  SELECT RAISE(ABORT, 'pending action proposal is immutable');
END;
`;

const ADD_BACKGROUND_TASKS_V4 = `
CREATE TABLE background_tasks (
    id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    revision INTEGER NOT NULL CHECK (revision > 0),
    error_code TEXT CHECK (error_code IN ('execution_failed','interrupted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX ix_background_tasks_status_created ON background_tasks(status, sequence);
CREATE TRIGGER background_task_payload_immutable
BEFORE UPDATE OF id, sequence, payload_json, created_at ON background_tasks
BEGIN SELECT RAISE(ABORT, 'task payload is immutable'); END;
-- A local process owner prevents a second Web runtime recovering live work.
CREATE TABLE background_task_executor (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    owner_id TEXT NOT NULL,
    process_id INTEGER NOT NULL CHECK (process_id > 0)
);
`;

const ADD_AGENT_CONTROL_V5 = `
CREATE TABLE agent_workspaces (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, base_commit TEXT NOT NULL,
 git_status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(path,base_commit,git_status)
);
ALTER TABLE buckets ADD COLUMN workspace_id TEXT REFERENCES agent_workspaces(id) ON DELETE SET NULL;
CREATE TABLE agent_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES agent_workspaces(id),
 backend TEXT NOT NULL CHECK (backend IN ('claude','codex')), remote_id TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE agent_tasks (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id),
 workspace_id TEXT REFERENCES agent_workspaces(id), backend TEXT NOT NULL CHECK (backend IN ('claude','codex')),
 instruction TEXT NOT NULL, pending_action_id TEXT NOT NULL UNIQUE REFERENCES pending_actions(id),
 queue_id TEXT UNIQUE REFERENCES background_tasks(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK (status IN ('pending','queued','running','succeeded','failed','cancelled','rejected')),
 output TEXT NOT NULL DEFAULT '', failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ix_agent_workspace_busy ON agent_tasks(workspace_id) WHERE status IN ('queued','running') AND workspace_id IS NOT NULL;
CREATE UNIQUE INDEX ix_agent_session_busy ON agent_tasks(session_id) WHERE status IN ('queued','running');
CREATE INDEX ix_agent_task_created ON agent_tasks(created_at, id);
CREATE TRIGGER agent_workspace_immutable BEFORE UPDATE ON agent_workspaces
BEGIN SELECT RAISE(ABORT, 'workspace baseline is immutable'); END;
CREATE TRIGGER agent_session_binding_immutable BEFORE UPDATE OF id,workspace_id,backend,created_at ON agent_sessions
BEGIN SELECT RAISE(ABORT, 'session binding is immutable'); END;
CREATE TRIGGER agent_task_binding_immutable BEFORE UPDATE OF id,session_id,workspace_id,backend,instruction,pending_action_id,created_at ON agent_tasks
BEGIN SELECT RAISE(ABORT, 'task binding is immutable'); END;
`;

const ADD_ENTRY_REVOCATION_V6 = `
ALTER TABLE entries ADD COLUMN revoked_at TEXT;
CREATE INDEX ix_entries_effective_bucket_created
    ON entries(bucket_id, created_at, id) WHERE revoked_at IS NULL;
ALTER TABLE agent_sessions ADD COLUMN memory_revision INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER agent_session_binding_immutable;
CREATE TRIGGER agent_session_binding_immutable
BEFORE UPDATE OF id,workspace_id,backend,created_at,memory_revision ON agent_sessions
BEGIN SELECT RAISE(ABORT, 'session binding is immutable'); END;
`;

const ADD_TODO_PLAN_V7 = `
ALTER TABLE memory_items ADD COLUMN scheduled_at TEXT;
ALTER TABLE memory_items ADD COLUMN todo_rule_json TEXT;
ALTER TABLE memory_items ADD COLUMN todo_raw_time_json TEXT;
ALTER TABLE memory_items ADD COLUMN todo_occurrence INTEGER;

-- Existing extracted TODOs are the first occurrence and remain open. Other
-- memory kinds deliberately keep the new TODO columns NULL.
UPDATE memory_items SET status = 'open' WHERE kind = 'todo' AND status IS NULL;
UPDATE memory_items SET todo_occurrence = 1 WHERE kind = 'todo';

CREATE INDEX ix_memory_items_todo_agenda
    ON memory_items(kind, status, due_at, scheduled_at, updated_at, id)
    WHERE kind = 'todo';
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "create_memory_schema_v1", sql: CREATE_V1 },
  {
    version: 2,
    name: "add_pending_archive_suggestions_v2",
    sql: ADD_PENDING_SUGGESTIONS_V2,
  },
  { version: 3, name: "add_pending_actions_v3", sql: ADD_PENDING_ACTIONS_V3 },
  { version: 4, name: "add_background_tasks_v4", sql: ADD_BACKGROUND_TASKS_V4 },
  { version: 5, name: "add_agent_control_v5", sql: ADD_AGENT_CONTROL_V5 },
  { version: 6, name: "add_entry_revocation_v6", sql: ADD_ENTRY_REVOCATION_V6 },
  { version: 7, name: "add_todo_plan_v7", sql: ADD_TODO_PLAN_V7 },
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
  "pending_actions",
  "background_tasks",
  "background_task_executor",
  "agent_workspaces",
  "agent_sessions",
  "agent_tasks",
  "corrections",
  "conversation_messages",
];
