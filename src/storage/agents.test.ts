import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIGRATIONS, SCHEMA_KIND } from "./schema.ts";
import { openDatabase } from "./database.ts";
import { AgentStore } from "./agents.ts";
import { Store } from "./store.ts";
import { TaskStore } from "./tasks.ts";

test("T13 genuine v4 migrates through v5 to the current schema preserving conversation, pending and queued work", () => {
  const root = mkdtempSync(join(tmpdir(), "doggie-v5-test-"));
  const path = join(root, "test.db");
  let db = new DatabaseSync(path);
  try {
    for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    db.prepare(
      "INSERT INTO schema_meta VALUES ('schema_kind',?),('schema_version','4')",
    ).run(SCHEMA_KIND);
    const oldStore = new Store(db);
    oldStore.appendChatMessage({
      role: "user",
      content: "preserve exact evidence",
    });
    const pending = oldStore.proposePendingAction(
      {
        kind: "agent_task",
        payload: { instruction: "pending only", workspaceId: null },
      },
      "pending only",
      "user",
    );
    const queued = new TaskStore(db).enqueue({ message: "queued evidence" });
    db.close();
    db = openDatabase(path);
    assert.equal(
      db
        .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get()?.["value"],
      "6",
    );
    assert.equal(
      new Store(db).listChatMessages(10)[0]?.content,
      "preserve exact evidence",
    );
    assert.equal(new Store(db).getPendingAction(pending.id)?.status, "pending");
    assert.equal(new TaskStore(db).get(queued.id).status, "queued");
    assert.deepEqual(new AgentStore(db).tasks(), []);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
