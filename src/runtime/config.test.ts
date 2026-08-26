import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspect } from "node:util";

import {
  DoggieRuntimeConfig,
  RuntimeConfigurationError,
  loadRuntimeConfig,
  parseServerBinding,
  resolveRuntimeConfig,
} from "./config.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "doggie-runtime-config-"));
}

function errorKind(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error: unknown) {
    return error instanceof RuntimeConfigurationError ? error.kind : undefined;
  }
}

test("runtime config loads .env without mutating process env and process values win", async () => {
  const cwd = temporaryDirectory();
  try {
    writeFileSync(
      join(cwd, ".env"),
      [
        "OPENAI_SITE=relay",
        "OPENAI_BASE_URL=https://relay.example/v1",
        "OPENAI_API_MODE=chat_completions",
        "OPENAI_API_KEY=file-secret",
        "OPENAI_MODEL=file-model",
        "OPENAI_TIMEOUT_SECONDS=17",
        "DOGGIE_DATABASE_PATH=data/doggie.db",
        "DOGGIE_SERVER_ADDRESS=127.0.0.1:0",
      ].join("\n"),
    );
    const environment: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "process-secret",
      OPENAI_MODEL: "process-model",
    };
    const config = loadRuntimeConfig({ cwd, environment });

    assert.equal(config.databasePath, join(cwd, "data/doggie.db"));
    assert.deepEqual(config.server, { host: "127.0.0.1", port: 0 });
    assert.equal(
      config.endpoint.requestUrl,
      "https://relay.example/v1/chat/completions",
    );
    assert.equal(config.model, "process-model");
    assert.equal(config.timeoutMs, 17_000);
    assert.equal(environment["DOGGIE_DATABASE_PATH"], undefined);

    const captured: RequestInit[] = [];
    const transport = config.createTransport((async (_input, init) => {
      captured.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch);
    await transport.send({ url: config.endpoint.requestUrl, body: {} });
    assert.deepEqual(captured[0]?.headers, {
      authorization: "Bearer process-secret",
      "content-type": "application/json",
    });
    assert.doesNotMatch(inspect(config), /process-secret|file-secret/u);
    assert.match(inspect(config), /apiKey: '<redacted>'/u);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime config defaults to official Responses and absolute local paths", () => {
  const cwd = temporaryDirectory();
  try {
    const config = resolveRuntimeConfig(
      { OPENAI_API_KEY: "fixture-key", OPENAI_MODEL: "fixture-model" },
      {},
      cwd,
    );
    assert.equal(config.databasePath, join(cwd, "doggie.db"));
    assert.deepEqual(config.server, { host: "127.0.0.1", port: 8787 });
    assert.equal(
      config.endpoint.requestUrl,
      "https://api.openai.com/v1/responses",
    );
    assert.equal(config.timeoutMs, 30_000);
    assert.equal(config instanceof DoggieRuntimeConfig, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runtime config rejects missing secrets, invalid bounds and non-loopback listeners", () => {
  const cwd = "/tmp/doggie-config-fixture";
  assert.equal(
    errorKind(() => resolveRuntimeConfig({}, {}, cwd)),
    "missing_api_key",
  );
  assert.equal(
    errorKind(() => resolveRuntimeConfig({ OPENAI_API_KEY: "key" }, {}, cwd)),
    "missing_model",
  );

  for (const [key, value, expected] of [
    ["OPENAI_TIMEOUT_SECONDS", "0", "invalid_timeout"],
    ["OPENAI_TIMEOUT_SECONDS", "1.5", "invalid_timeout"],
    ["OPENAI_TIMEOUT_SECONDS", "301", "invalid_timeout"],
    ["DOGGIE_SERVER_ADDRESS", "0.0.0.0:8787", "invalid_server_address"],
    ["DOGGIE_SERVER_ADDRESS", "127.0.0.1", "invalid_server_address"],
    ["DOGGIE_SERVER_ADDRESS", "example.com:8787", "invalid_server_address"],
    ["DOGGIE_SERVER_ADDRESS", "localhost:8787", "invalid_server_address"],
    ["DOGGIE_DATABASE_PATH", "bad\npath", "invalid_database_path"],
  ] as const) {
    assert.equal(
      errorKind(() =>
        resolveRuntimeConfig(
          {
            OPENAI_API_KEY: "fixture-key",
            OPENAI_MODEL: "fixture-model",
            [key]: value,
          },
          {},
          cwd,
        ),
      ),
      expected,
      `${key}=${JSON.stringify(value)}`,
    );
  }

  assert.deepEqual(parseServerBinding("127.0.0.1:9000"), {
    host: "127.0.0.1",
    port: 9000,
  });
  assert.deepEqual(parseServerBinding("[::1]:8787"), {
    host: "::1",
    port: 8787,
  });
});

test("official endpoint rejects a configured custom base URL", () => {
  assert.equal(
    errorKind(() =>
      resolveRuntimeConfig(
        {
          OPENAI_SITE: "official",
          OPENAI_BASE_URL: "https://relay.example/v1",
          OPENAI_API_KEY: "fixture-key",
          OPENAI_MODEL: "fixture-model",
        },
        {},
        "/tmp/doggie-config-fixture",
      ),
    ),
    "conflicting_endpoint",
  );
});

test("dotenv parse failures are sanitized and never echo file contents", () => {
  const cwd = temporaryDirectory();
  const secret = "should-never-appear";
  try {
    writeFileSync(join(cwd, ".env"), `OPENAI_API_KEY=${secret}\nBROKEN`);
    assert.throws(
      () => loadRuntimeConfig({ cwd, environment: {} }),
      (error: unknown) =>
        error instanceof RuntimeConfigurationError &&
        error.kind === "invalid_dotenv" &&
        !error.message.includes(secret),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
