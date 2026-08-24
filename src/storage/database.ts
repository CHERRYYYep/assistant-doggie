/**
 * Database connection, pragmas, migrations and the transaction helper.
 *
 * `node:sqlite` is synchronous, which matches how this codebase already
 * worked and keeps transaction boundaries obvious: there is no `await` inside
 * a transaction that could interleave another one.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

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
  | "archive_attempt_not_found"
  | "archive_attempt_text_mismatch"
  | "archive_attempt_not_pending"
  | "pragma_not_applied";

export class StorageError extends Error {
  readonly kind: StorageErrorKind;

  constructor(kind: StorageErrorKind, message: string) {
    super(message);
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

export type OpenOptions = {
  /** Fail instead of creating the schema when the file is new. */
  readonly readOnlyIfMissing?: boolean;
};

/**
 * Open (creating if needed) a Doggie database at `path`.
 *
 * Use `":memory:"` in tests. WAL is skipped for in-memory databases because
 * SQLite does not support it there.
 */
export function openDatabase(
  path: string,
  options: OpenOptions = {},
): DatabaseSync {
  const database = new DatabaseSync(path);
  configurePragmas(database, path);
  assertNotAForeignDatabase(database);
  migrate(database);
  return database;
}

function configurePragmas(database: DatabaseSync, path: string): void {
  // Per-connection, and SQLite silently ignores a change inside a transaction,
  // so this must happen before any write and be verified rather than assumed.
  database.exec("PRAGMA foreign_keys = ON");
  const enforced = database.prepare("PRAGMA foreign_keys").get() as
    { foreign_keys?: number } | undefined;
  if (enforced?.foreign_keys !== 1) {
    throw new StorageError(
      "pragma_not_applied",
      "foreign_keys could not be enabled",
    );
  }

  // Without a busy timeout a concurrent writer fails instantly rather than
  // waiting. The background executor (T12) makes that a real scenario.
  database.exec("PRAGMA busy_timeout = 5000");

  if (path !== ":memory:") {
    // WAL lets readers proceed during a write, which matters once the HTTP
    // server stops being single-threaded.
    database.exec("PRAGMA journal_mode = WAL");
  }
  database.exec("PRAGMA synchronous = NORMAL");
}

/** Refuse to touch a database that holds someone else's tables. */
function assertNotAForeignDatabase(database: DatabaseSync): void {
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
}

function migrate(database: DatabaseSync): void {
  const hasMigrations = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();

  const applied = hasMigrations
    ? new Set(
        (
          database.prepare("SELECT version FROM schema_migrations").all() as {
            version: number;
          }[]
        ).map((row) => row.version),
      )
    : new Set<number>();

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
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
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const version = readSchemaVersion(database);
  if (version !== SCHEMA_VERSION) {
    throw new StorageError(
      "unsupported_schema_version",
      `database is at schema version ${version}, this build supports ${SCHEMA_VERSION}`,
    );
  }
}

export function readSchemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row === undefined ? 0 : Number(row.value);
}

/**
 * Run `body` inside one `BEGIN IMMEDIATE` transaction.
 *
 * Any throw rolls the whole thing back — this is the mechanism behind
 * `docs/INVARIANTS.md` §4.2, "any failure leaves no partial write". IMMEDIATE
 * rather than DEFERRED so a write conflict surfaces at the start instead of at
 * commit, when part of the work has already been done.
 */
export function withTransaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  let result: T;
  try {
    result = body();
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  database.exec("COMMIT");
  return result;
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
