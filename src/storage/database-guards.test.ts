import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openDatabase, StorageError } from "./database.ts";

function temporaryDatabase(): {
  readonly directory: string;
  readonly path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "doggie-db-guard-"));
  return { directory, path: join(directory, "database.db") };
}

function rejectsAs(kind: StorageError["kind"]): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof StorageError && error.kind === kind;
}

test("foreign databases are rejected without changing persistent journal mode", () => {
  const fixture = temporaryDatabase();
  try {
    const foreign = new DatabaseSync(fixture.path);
    foreign.exec("PRAGMA journal_mode = DELETE");
    foreign.exec(
      "CREATE TABLE external_records(id TEXT PRIMARY KEY, value TEXT)",
    );
    foreign
      .prepare("INSERT INTO external_records VALUES (?, ?)")
      .run("1", "kept");
    foreign.close();

    assert.throws(
      () => openDatabase(fixture.path),
      rejectsAs("foreign_database"),
    );

    const reopened = new DatabaseSync(fixture.path);
    try {
      const journal = reopened.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      assert.equal(journal.journal_mode, "delete");
      assert.deepEqual(
        { ...reopened.prepare("SELECT * FROM external_records").get() },
        { id: "1", value: "kept" },
      );
      assert.equal(
        reopened
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'",
          )
          .get(),
        undefined,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("schema identity and required shape are verified on every reopen", () => {
  for (const tamper of [
    (database: DatabaseSync) =>
      database
        .prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_kind'")
        .run("not-doggie"),
    (database: DatabaseSync) =>
      database.exec("ALTER TABLE archive_attempts DROP COLUMN suggested_title"),
  ]) {
    const fixture = temporaryDatabase();
    try {
      const database = openDatabase(fixture.path);
      tamper(database);
      database.close();
      assert.throws(
        () => openDatabase(fixture.path),
        (error: unknown) =>
          error instanceof StorageError &&
          (error.kind === "foreign_database" ||
            error.kind === "unsupported_schema_version"),
      );
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("partial owned table names without Doggie metadata are rejected", () => {
  const fixture = temporaryDatabase();
  try {
    const partial = new DatabaseSync(fixture.path);
    partial.exec("CREATE TABLE buckets(id TEXT PRIMARY KEY)");
    partial.close();
    assert.throws(
      () => openDatabase(fixture.path),
      rejectsAs("foreign_database"),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
