import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { openDatabase, readSchemaVersion } from "./database.ts";
import { MIGRATIONS, SCHEMA_KIND, SCHEMA_VERSION } from "./schema.ts";

const databaseModuleUrl = pathToFileURL(
  join(import.meta.dirname, "database.ts"),
).href;

const childScript = `
import { openDatabase, readSchemaVersion } from ${JSON.stringify(databaseModuleUrl)};
const path = process.argv[1];
process.send?.("ready");
process.once("message", (message) => {
  if (message !== "go") process.exit(3);
  const database = openDatabase(path);
  if (readSchemaVersion(database) !== ${SCHEMA_VERSION}) process.exitCode = 2;
  database.close();
});
`;

test("simultaneous first Web/MCP opens serialize migration discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-first-open-"));
  const databasePath = join(directory, "doggie.db");
  try {
    const children = Array.from({ length: 4 }, () => startChild(databasePath));
    await Promise.all(children.map(({ ready }) => ready));
    for (const child of children) child.go();
    const results = await Promise.all(children.map(({ result }) => result));
    assert.deepEqual(
      results.map(({ code }) => code),
      [0, 0, 0, 0],
      results.map(({ stderr }) => stderr).join("\n"),
    );

    const database = openDatabase(databasePath);
    try {
      assert.equal(readSchemaVersion(database), SCHEMA_VERSION);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
      const kind = database
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_kind'")
        .get() as { value: string };
      assert.equal(kind.value, SCHEMA_KIND);
      assert.deepEqual(
        database
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all()
          .map((row) => ({ ...row })),
        MIGRATIONS.map(({ version, name }) => ({ version, name })),
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function startChild(databasePath: string): {
  readonly ready: Promise<void>;
  readonly go: () => void;
  readonly result: Promise<{
    readonly code: number | null;
    readonly stderr: string;
  }>;
} {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", childScript, databasePath],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("child ready timeout")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("message", (message) => {
      clearTimeout(timeout);
      if (message === "ready") resolve();
      else reject(new Error(`unexpected child message: ${String(message)}`));
    });
  });
  const result = new Promise<{
    readonly code: number | null;
    readonly stderr: string;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child migration timeout: ${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
  return { ready, go: () => child.send("go"), result };
}
