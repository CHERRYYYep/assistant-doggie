/**
 * Database connection, pragmas, migrations and the transaction helper.
 *
 * `node:sqlite` is synchronous, which matches how this codebase already
 * worked and keeps transaction boundaries obvious: there is no `await` inside
 * a transaction that could interleave another one.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { types } from "node:util";

import {
  MIGRATIONS,
  OWNED_TABLES,
  SCHEMA_KIND,
  SCHEMA_VERSION,
} from "./schema.ts";

export type StorageErrorKind =
  | "foreign_database"
  | "unsupported_schema_version"
  | "missing_record"
  | "invalid_write"
  | "inactive_bucket"
  | "memory_context_changed"
  | "archive_attempt_not_found"
  | "archive_attempt_text_mismatch"
  | "archive_attempt_not_pending"
  | "stale_write"
  | "pragma_not_applied"
  | "storage_unavailable";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;

  constructor(kind: StorageErrorKind, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.kind = kind;
  }

  static missingRecord(table: string, id: string): StorageError {
    return new StorageError(
      "missing_record",
      `${table} has no record with id ${id}`,
    );
  }

  static invalidWrite(field: string, reason: string): StorageError {
    return new StorageError("invalid_write", `${field} ${reason}`);
  }

  static inactiveBucket(id: string): StorageError {
    return new StorageError("inactive_bucket", `bucket ${id} is not active`);
  }

  static archiveAttemptNotFound(id: string): StorageError {
    return new StorageError(
      "archive_attempt_not_found",
      `archive attempt ${id} was not found`,
    );
  }

  static archiveAttemptTextMismatch(id: string): StorageError {
    return new StorageError(
      "archive_attempt_text_mismatch",
      `archive attempt ${id} does not match the original text`,
    );
  }

  static archiveAttemptNotPending(id: string): StorageError {
    return new StorageError(
      "archive_attempt_not_pending",
      `archive attempt ${id} is not pending`,
    );
  }

  static staleWrite(table: string, id: string): StorageError {
    return new StorageError(
      "stale_write",
      `${table} ${id} was changed after the client read it`,
    );
  }
}

/** A clock, injectable so tests get deterministic timestamps. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * Timestamps are ISO-8601 with milliseconds, always UTC.
 *
 * Text rather than a numeric epoch because it sorts lexicographically, reads
 * without decoding, and survives export to any other tool unambiguously.
 */
export function formatTimestamp(at: Date): string {
  return at.toISOString();
}

/** UUID v4. `crypto.randomUUID` is built in; no dependency needed. */
export function newId(): string {
  return randomUUID();
}

/**
 * Open (creating if needed) a Doggie database at `path`.
 *
 * Use `":memory:"` in tests. WAL is skipped for in-memory databases because
 * SQLite does not support it there.
 */
export function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    configureConnectionPragmas(database);
    assertOwnedDatabase(database);
    configureOwnedDatabasePragmas(database, path);
    migrate(database);
    assertSchemaIdentity(database);
    assertSchemaShape(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureConnectionPragmas(database: DatabaseSync): void {
  // Connection-local and safe to apply before database ownership is known.
  database.exec("PRAGMA foreign_keys = ON");
  const enforced = database.prepare("PRAGMA foreign_keys").get() as
    { foreign_keys?: number } | undefined;
  if (enforced?.foreign_keys !== 1) {
    throw new StorageError(
      "pragma_not_applied",
      "foreign_keys could not be enabled",
    );
  }
  database.exec("PRAGMA busy_timeout = 5000");
}

function configureOwnedDatabasePragmas(
  database: DatabaseSync,
  path: string,
): void {
  // journal_mode is persistent, so never change it before ownership checks.
  if (path !== ":memory:") {
    retrySqliteBusy(() => database.exec("PRAGMA journal_mode = WAL"));
  }
  database.exec("PRAGMA synchronous = NORMAL");
}

function retrySqliteBusy(action: () => void): void {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      action();
      return;
    } catch (error: unknown) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    error.errcode === 5
  );
}

/** Refuse to touch a database that holds someone else's tables. */
function assertOwnedDatabase(database: DatabaseSync): void {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  if (rows.length === 0) return;

  const owned = new Set(OWNED_TABLES);
  const foreign = rows
    .map((row) => row.name)
    .filter((name) => !owned.has(name));
  if (foreign.length > 0) {
    throw new StorageError(
      "foreign_database",
      `refusing to use a database containing unknown tables: ${foreign.join(", ")}`,
    );
  }

  const hasSchemaMeta = rows.some(({ name }) => name === "schema_meta");
  if (!hasSchemaMeta) {
    throw new StorageError(
      "foreign_database",
      "refusing to use a non-empty database without Doggie schema metadata",
    );
  }
  assertSchemaIdentity(database);
}

function assertSchemaIdentity(database: DatabaseSync): void {
  try {
    const row = database
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_kind'")
      .get() as { value: string } | undefined;
    if (row?.value === SCHEMA_KIND) return;
  } catch {
    // A table named schema_meta with an incompatible shape is not ours.
  }
  throw new StorageError(
    "foreign_database",
    "refusing to use a database with an invalid Doggie schema identity",
  );
}

function assertSchemaShape(database: DatabaseSync): void {
  const tables = new Set(
    (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    ).map(({ name }) => name),
  );
  const missingTables = OWNED_TABLES.filter((name) => !tables.has(name));
  if (missingTables.length > 0) {
    throw new StorageError(
      "unsupported_schema_version",
      `Doggie schema is missing required tables: ${missingTables.join(", ")}`,
    );
  }

  const archiveColumns = new Set(
    (
      database.prepare("PRAGMA table_info(archive_attempts)").all() as {
        name: string;
      }[]
    ).map(({ name }) => name),
  );
  for (const column of ["suggested_bucket_type", "suggested_title"]) {
    if (!archiveColumns.has(column)) {
      throw new StorageError(
        "unsupported_schema_version",
        `Doggie schema version ${SCHEMA_VERSION} is missing archive_attempts.${column}`,
      );
    }
  }

  const pendingColumns = new Set(
    database
      .prepare("PRAGMA table_info(pending_actions)")
      .all()
      .map((row) => row["name"]),
  );
  for (const column of [
    "id",
    "kind",
    "proposed_by",
    "binding_text",
    "payload_json",
    "status",
    "approval_json",
    "result_json",
    "failure_code",
    "created_at",
    "updated_at",
  ]) {
    if (!pendingColumns.has(column)) {
      throw new StorageError(
        "unsupported_schema_version",
        `Doggie schema is missing pending_actions.${column}`,
      );
    }
  }

  for (const [table, required] of [
    [
      "background_tasks",
      [
        "id",
        "sequence",
        "payload_json",
        "status",
        "revision",
        "error_code",
        "created_at",
        "updated_at",
      ],
    ],
    ["background_task_executor", ["singleton", "owner_id", "process_id"]],
    [
      "agent_workspaces",
      ["id", "path", "base_commit", "git_status", "created_at"],
    ],
    [
      "agent_sessions",
      ["id", "workspace_id", "backend", "remote_id", "created_at"],
    ],
    [
      "agent_tasks",
      [
        "id",
        "session_id",
        "workspace_id",
        "backend",
        "instruction",
        "pending_action_id",
        "queue_id",
        "status",
        "output",
        "failure_code",
        "created_at",
        "updated_at",
      ],
    ],
    ["buckets", ["workspace_id"]],
    ["entries", ["revoked_at"]],
    ["agent_sessions", ["memory_revision"]],
    [
      "memory_items",
      [
        "scheduled_at",
        "todo_rule_json",
        "todo_raw_time_json",
        "todo_occurrence",
      ],
    ],
  ] as const) {
    const columns = new Set(
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row["name"]),
    );
    for (const column of required) {
      if (!columns.has(column))
        throw new StorageError(
          "unsupported_schema_version",
          `Doggie schema is missing ${table}.${column}`,
        );
    }
  }

  const applied = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
    .all() as { version: number; name: string }[];
  if (
    applied.length !== MIGRATIONS.length ||
    applied.some(
      (row, index) =>
        row.version !== MIGRATIONS[index]?.version ||
        row.name !== MIGRATIONS[index]?.name,
    )
  ) {
    throw new StorageError(
      "unsupported_schema_version",
      "Doggie migration ledger does not match this build",
    );
  }
}

function migrate(database: DatabaseSync): void {
  for (const migration of MIGRATIONS) {
    // Acquire the write lock before checking whether this migration was
    // applied. Two first-starting Web/MCP processes can otherwise both cache
    // an empty migration set and the second one will replay CREATE TABLE after
    // waiting for the first process to commit.
    withTransaction(database, () => {
      if (!isMigrationApplied(database, migration.version)) {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, formatTimestamp(new Date()));
        database
          .prepare(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?), (?, ?)",
          )
          .run(
            "schema_kind",
            SCHEMA_KIND,
            "schema_version",
            String(migration.version),
          );
      }
    });
  }

  const version = readSchemaVersion(database);
  if (version !== SCHEMA_VERSION) {
    throw new StorageError(
      "unsupported_schema_version",
      `database is at schema version ${version}, this build supports ${SCHEMA_VERSION}`,
    );
  }
}

function isMigrationApplied(database: DatabaseSync, version: number): boolean {
  const hasMigrations = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (hasMigrations === undefined) return false;
  return (
    database
      .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
      .get(version) !== undefined
  );
}

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row === undefined ? 0 : Number(row.value);
}

const databaseFaults = new WeakMap<DatabaseSync, StorageError>();
const faultHandlers = new WeakMap<
  DatabaseSync,
  (fault: StorageError) => void
>();

/** The owner of the connection drains its server and workers before closing. */
export function onDatabaseFault(
  database: DatabaseSync,
  handler: (fault: StorageError) => void,
): void {
  faultHandlers.set(database, handler);
}

export function assertDatabaseAvailable(database: DatabaseSync): void {
  const fault = databaseFaults.get(database);
  if (fault !== undefined) throw fault;
}

function isThenable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/**
 * Run `body` inside one `BEGIN IMMEDIATE` transaction.
 *
 * Any throw rolls the whole thing back — this is the mechanism behind
 * `docs/INVARIANTS.md` §4.2, "any failure leaves no partial write". IMMEDIATE
 * rather than DEFERRED so a write conflict surfaces at the start instead of at
 * commit, when part of the work has already been done.
 */
export function withTransaction<T>(
  database: DatabaseSync,
  body: () => T &
    (Extract<T, PromiseLike<unknown>> extends never ? unknown : never),
): T {
  assertDatabaseAvailable(database);
  if (types.isAsyncFunction(body))
    throw new TypeError("transaction body must be synchronous");
  // Keep BEGIN outside the protected scope so a nested or failed BEGIN
  // cannot roll back an unrelated transaction.
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    if (isThenable(result)) {
      if (types.isPromise(result)) void result.catch(() => undefined);
      throw new TypeError("transaction body must be synchronous");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (database.isTransaction) database.exec("ROLLBACK");
    } catch (rollbackError) {
      const fault = new StorageError(
        "storage_unavailable",
        "storage is unavailable",
        {
          cause: new AggregateError(
            [error, rollbackError],
            "transaction cleanup failed",
          ),
        },
      );
      databaseFaults.set(database, fault);
      const stop = faultHandlers.get(database);
      if (stop !== undefined) queueMicrotask(() => stop(fault));
      throw fault;
    }
    throw error;
  }
}

/** Trim, rejecting an all-whitespace value. */
export function requiredField(value: string, field: string): string {
  const cleaned = value.trim();
  if (cleaned === "")
    throw StorageError.invalidWrite(field, "must not be empty");
  return cleaned;
}

/** Trim, mapping an all-whitespace value to `null` for a nullable column. */
export function optionalField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
}
