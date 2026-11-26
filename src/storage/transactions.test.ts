import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { StorageError, withTransaction } from "./database.ts";

test("failed COMMIT rolls back deferred constraints and the connection remains usable", () => {
  using database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
  `);
  assert.throws(
    () =>
      withTransaction(database, () =>
        database.exec("INSERT INTO child VALUES (1)"),
      ),
    /FOREIGN KEY constraint failed/u,
  );
  assert.equal(database.isTransaction, false);
  assert.deepEqual(database.prepare("SELECT id FROM child").all(), []);
  withTransaction(database, () =>
    database.exec("INSERT INTO parent VALUES (1)"),
  );
  assert.equal(database.prepare("SELECT id FROM parent").get()?.["id"], 1);
});

test("failed nested BEGIN does not roll back the outer scope; auto-rollback keeps the original error", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE rows (id INTEGER PRIMARY KEY)");
  withTransaction(database, () => {
    database.exec("INSERT INTO rows VALUES (1)");
    assert.throws(() => withTransaction(database, () => undefined));
    assert.equal(database.isTransaction, true);
  });
  assert.throws(
    () =>
      withTransaction(database, () =>
        database.exec("INSERT OR ROLLBACK INTO rows VALUES (1)"),
      ),
    /UNIQUE constraint failed/u,
  );
  assert.equal(database.isTransaction, false);
  assert.equal(database.prepare("SELECT id FROM rows").get()?.["id"], 1);
});

test("transaction helper rejects asynchronous bodies and thenables without committing", () => {
  using database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE rows (id INTEGER)");
  let invoked = false;
  const asynchronous: () => unknown = async () => {
    invoked = true;
  };
  assert.throws(() => withTransaction(database, asynchronous), /synchronous/u);
  assert.equal(invoked, false);

  const unexpected: () => unknown = () => {
    database.exec("INSERT INTO rows VALUES (1)");
    return {
      then() {
        assert.fail("thenable must not run");
      },
    };
  };
  assert.throws(() => withTransaction(database, unexpected), /synchronous/u);
  assert.deepEqual(database.prepare("SELECT id FROM rows").all(), []);
});

test("rollback failure preserves both errors and rejects subsequent transactions", (t) => {
  using database = new DatabaseSync(":memory:");
  const execute = database.exec.bind(database);
  const original = new Error("original write failure");
  const rollback = new Error("rollback failure");
  t.mock.method(database, "exec", (sql: string) => {
    if (sql === "ROLLBACK") throw rollback;
    execute(sql);
  });
  let fault: StorageError | undefined;
  assert.throws(
    () =>
      withTransaction(database, () => {
        throw original;
      }),
    (error) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.kind, "storage_unavailable");
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [original, rollback]);
      fault = error;
      return true;
    },
  );
  assert.throws(
    () =>
      withTransaction(database, () => assert.fail("quarantined connection")),
    (error) => error === fault,
  );
});
