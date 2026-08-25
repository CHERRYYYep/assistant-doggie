import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = dirname(
  fileURLToPath(new URL("../package.json", import.meta.url)),
);

function cleanEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("OPENAI_") &&
        !key.startsWith("DOGGIE_") &&
        !key.startsWith("RUST_"),
    ),
  );
}

test("T10b npm start serves health and shuts down cleanly", async () => {
  const directory = mkdtempSync(join(tmpdir(), "doggie-main-smoke-"));
  const databasePath = join(directory, "doggie.db");
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmExecutable, ["start"], {
    cwd: repositoryRoot,
    env: {
      ...cleanEnvironment(),
      OPENAI_SITE: "official",
      OPENAI_BASE_URL: "",
      OPENAI_API_MODE: "responses",
      OPENAI_API_KEY: "process-smoke-placeholder",
      OPENAI_MODEL: "process-smoke-model",
      OPENAI_TIMEOUT_SECONDS: "30",
      DOGGIE_DATABASE_PATH: databasePath,
      DOGGIE_SERVER_ADDRESS: "127.0.0.1:0",
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: process.platform !== "win32",
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const url = await waitForUrl(() => stderr, child);
    const health = await fetch(new URL("health", url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "doggie-local-web",
    });

    terminateTree(child, "SIGTERM");
    const exit = await waitForExit(child);
    assert.equal(exit.code === 0 || exit.signal === "SIGTERM", true, stderr);
    assert.match(stderr, /stopped after SIGTERM/u);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      terminateTree(child, "SIGKILL");
      await waitForExit(child).catch(() => undefined);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForUrl(
  output: () => string,
  child: ReturnType<typeof spawn>,
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /listening on (http:\/\/[^\s]+)/u.exec(output());
    if (match?.[1] !== undefined) return match[1];
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Doggie exited before listening: ${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for Doggie startup: ${output()}`);
}

function terminateTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for Doggie shutdown")),
      10_000,
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
