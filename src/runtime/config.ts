import { z } from "zod";
/** Production configuration for the local TypeScript Web process. */

import { existsSync, readFileSync } from "node:fs";
import { inspect, parseEnv } from "node:util";
import { isAbsolute, resolve } from "node:path";

import { resolveLlmEndpoint, type LlmEndpointConfig } from "../llm/config.ts";
import { FetchStructuredOutputTransport } from "../llm/transport.ts";

export const DEFAULT_DOGGIE_DATABASE_PATH = "doggie.db";
export const DEFAULT_DOGGIE_SERVER_ADDRESS = "127.0.0.1:8787";
export const DEFAULT_OPENAI_TIMEOUT_SECONDS = 30;
export const MAX_MODEL_NAME_BYTES = 200;
export const MAX_RUNTIME_LLM_TIMEOUT_SECONDS = 300;

export type RuntimeConfigurationErrorKind =
  | "invalid_agent_config"
  | "invalid_dotenv"
  | "missing_api_key"
  | "missing_model"
  | "invalid_model"
  | "invalid_timeout"
  | "conflicting_endpoint"
  | "invalid_database_path"
  | "invalid_server_address";

export class RuntimeConfigurationError extends Error {
  readonly kind: RuntimeConfigurationErrorKind;

  constructor(kind: RuntimeConfigurationErrorKind, message: string) {
    super(message);
    this.name = "RuntimeConfigurationError";
    this.kind = kind;
  }
}

export type DoggieServerBinding = {
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
};

/**
 * Validated runtime configuration. The API key remains in a private field and
 * can only be transferred directly into the redacting HTTP transport.
 */
export class DoggieRuntimeConfig {
  readonly databasePath: string;
  readonly server: DoggieServerBinding;
  readonly endpoint: LlmEndpointConfig;
  readonly model: string;
  readonly timeoutMs: number;
  readonly agent: AgentRuntimeConfig;
  readonly #apiKey: string;

  constructor(input: {
    readonly databasePath: string;
    readonly server: DoggieServerBinding;
    readonly endpoint: LlmEndpointConfig;
    readonly model: string;
    readonly timeoutMs: number;
    readonly apiKey: string;
    readonly agent?: AgentRuntimeConfig;
  }) {
    this.databasePath = parseDatabasePath(input.databasePath, process.cwd());
    this.server = parseServerBinding(formatServerBinding(input.server));
    this.endpoint = resolveLlmEndpoint({
      site: input.endpoint.site,
      baseUrl: input.endpoint.baseUrl,
      apiMode: input.endpoint.apiMode,
    });
    this.model = validateModel(input.model);
    this.timeoutMs = validateTimeoutMs(input.timeoutMs);
    this.#apiKey = validateApiKey(input.apiKey);
    this.agent = parseAgentConfig(input.agent ?? { workspaceRoots: [] });
  }

  createTransport(
    fetchImplementation: typeof fetch = fetch,
    signal?: AbortSignal,
  ): FetchStructuredOutputTransport {
    return new FetchStructuredOutputTransport(
      this.#apiKey,
      {
        timeoutMs: this.timeoutMs,
        ...(signal === undefined ? {} : { signal }),
      },
      fetchImplementation,
    );
  }

  [inspect.custom](): string {
    return (
      "DoggieRuntimeConfig { " +
      `databasePath: ${inspect(this.databasePath)}, ` +
      `server: ${inspect(this.server)}, ` +
      `endpoint: ${inspect(this.endpoint)}, ` +
      `model: ${inspect(this.model)}, ` +
      `timeoutMs: ${this.timeoutMs}, apiKey: '<redacted>' }`
    );
  }
}

export type LoadRuntimeConfigOptions = {
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly dotenvPath?: string | undefined;
};

/** Load `.env` without mutating `process.env`; process values take precedence. */
export function loadRuntimeConfig(
  options: LoadRuntimeConfigOptions = {},
): DoggieRuntimeConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const dotenvPath = resolve(cwd, options.dotenvPath ?? ".env");
  const dotenv = loadDotenv(dotenvPath);
  return resolveRuntimeConfig(environment, dotenv, cwd);
}

export function resolveRuntimeConfig(
  environment: NodeJS.ProcessEnv,
  dotenv: Readonly<Record<string, string | undefined>>,
  cwd: string,
): DoggieRuntimeConfig {
  const value = (key: string): string | undefined => {
    const raw = Object.hasOwn(environment, key)
      ? environment[key]
      : dotenv[key];
    const cleaned = raw?.trim();
    return cleaned === undefined || cleaned === "" ? undefined : cleaned;
  };

  const apiKey = validateApiKey(value("OPENAI_API_KEY"));
  const model = validateModel(value("OPENAI_MODEL"));

  const site = value("OPENAI_SITE");
  const baseUrl = value("OPENAI_BASE_URL");
  if (site?.toLowerCase() === "official" && baseUrl !== undefined) {
    throw new RuntimeConfigurationError(
      "conflicting_endpoint",
      "OPENAI_BASE_URL must be empty when OPENAI_SITE=official; use a custom site name for a relay",
    );
  }
  const endpoint = resolveLlmEndpoint({
    site,
    baseUrl,
    apiMode: value("OPENAI_API_MODE"),
  });
  const timeoutMs = parseTimeoutMs(value("OPENAI_TIMEOUT_SECONDS"));
  const databasePath = parseDatabasePath(
    value("DOGGIE_DATABASE_PATH") ??
      value("RUST_DATABASE_PATH") ??
      DEFAULT_DOGGIE_DATABASE_PATH,
    cwd,
  );
  const server = parseServerBinding(
    value("DOGGIE_SERVER_ADDRESS") ??
      value("RUST_SERVER_ADDRESS") ??
      DEFAULT_DOGGIE_SERVER_ADDRESS,
  );

  return new DoggieRuntimeConfig({
    databasePath,
    server,
    endpoint,
    model,
    timeoutMs,
    apiKey,
    agent: parseAgentConfig({
      workspaceRoots: parseAgentRoots(value("DOGGIE_AGENT_WORKSPACE_ROOTS")),
      ...(value("DOGGIE_AGENT_CLAUDE_COMMAND") === undefined
        ? {}
        : { claude: value("DOGGIE_AGENT_CLAUDE_COMMAND") }),
      ...(value("DOGGIE_AGENT_CODEX_COMMAND") === undefined
        ? {}
        : { codex: value("DOGGIE_AGENT_CODEX_COMMAND") }),
    }),
  });
}

function validateApiKey(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new RuntimeConfigurationError(
      "missing_api_key",
      "OPENAI_API_KEY is not configured; set it in the environment or .env",
    );
  }
  const cleaned = value.trim();
  if (cleaned.includes("\r") || cleaned.includes("\n")) {
    throw new RuntimeConfigurationError(
      "missing_api_key",
      "OPENAI_API_KEY must be a single-line value",
    );
  }
  return cleaned;
}

function validateModel(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new RuntimeConfigurationError(
      "missing_model",
      "OPENAI_MODEL is not configured; set it in the environment or .env",
    );
  }
  const cleaned = value.trim();
  if (
    Buffer.byteLength(cleaned, "utf8") > MAX_MODEL_NAME_BYTES ||
    cleaned.includes("\r") ||
    cleaned.includes("\n")
  ) {
    throw new RuntimeConfigurationError(
      "invalid_model",
      `OPENAI_MODEL must be a single-line value of at most ${MAX_MODEL_NAME_BYTES} UTF-8 bytes`,
    );
  }
  return cleaned;
}

function validateTimeoutMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_RUNTIME_LLM_TIMEOUT_SECONDS * 1_000
  ) {
    throw new RuntimeConfigurationError(
      "invalid_timeout",
      `LLM timeout must be an integer between 1 and ${MAX_RUNTIME_LLM_TIMEOUT_SECONDS * 1_000} milliseconds`,
    );
  }
  return value;
}

function formatServerBinding(binding: DoggieServerBinding): string {
  const host = binding.host === "::1" ? "[::1]" : binding.host;
  return `${host}:${binding.port}`;
}

function loadDotenv(
  path: string,
): Readonly<Record<string, string | undefined>> {
  if (!existsSync(path)) return Object.freeze({});
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new RuntimeConfigurationError(
      "invalid_dotenv",
      `.env could not be read from ${path}`,
    );
  }
  try {
    validateDotenvLines(contents);
    return Object.freeze(parseEnv(contents));
  } catch {
    throw new RuntimeConfigurationError(
      "invalid_dotenv",
      `.env at ${path} must contain valid KEY=VALUE entries`,
    );
  }
}

function validateDotenvLines(contents: string): void {
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator <= 0) throw new Error("invalid dotenv assignment");
    const key = assignment.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error("invalid dotenv key");
    }
  }
}

function parseTimeoutMs(value: string | undefined): number {
  const raw = value ?? String(DEFAULT_OPENAI_TIMEOUT_SECONDS);
  if (!/^[0-9]+$/u.test(raw)) {
    throw invalidTimeout();
  }
  const seconds = Number(raw);
  const maximumSeconds = MAX_RUNTIME_LLM_TIMEOUT_SECONDS;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > maximumSeconds
  ) {
    throw invalidTimeout();
  }
  return seconds * 1_000;
}

function invalidTimeout(): RuntimeConfigurationError {
  return new RuntimeConfigurationError(
    "invalid_timeout",
    `OPENAI_TIMEOUT_SECONDS must be an integer between 1 and ${MAX_RUNTIME_LLM_TIMEOUT_SECONDS}`,
  );
}

function parseDatabasePath(value: string, cwd: string): string {
  if (
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new RuntimeConfigurationError(
      "invalid_database_path",
      "DOGGIE_DATABASE_PATH must be a valid single-line local path",
    );
  }
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function parseServerBinding(value: string): DoggieServerBinding {
  const ipv6 = /^\[::1\]:([0-9]{1,5})$/u.exec(value);
  const ipv4 = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(value);
  const host =
    ipv6 === null ? (ipv4 === null ? undefined : "127.0.0.1") : "::1";
  const rawPort = ipv6?.[1] ?? ipv4?.[1];
  if (host === undefined || rawPort === undefined) {
    throw invalidServerAddress();
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw invalidServerAddress();
  }
  return Object.freeze({ host, port });
}

function invalidServerAddress(): RuntimeConfigurationError {
  return new RuntimeConfigurationError(
    "invalid_server_address",
    "DOGGIE_SERVER_ADDRESS must use the literal loopback 127.0.0.1 or [::1], for example 127.0.0.1:8787",
  );
}

export type AgentRuntimeConfig = {
  readonly workspaceRoots: readonly string[];
  readonly claude?: string;
  readonly codex?: string;
};
function parseAgentConfig(value: unknown): AgentRuntimeConfig {
  const path = z
    .string()
    .max(4096)
    .refine((value) => isAbsolute(value) && !value.includes("\0"));
  const config = z
    .object({
      workspaceRoots: z.array(path).max(100),
      claude: path.optional(),
      codex: path.optional(),
    })
    .strict()
    .safeParse(value);
  if (!config.success)
    throw new RuntimeConfigurationError(
      "invalid_agent_config",
      "Agent roots and executables must use absolute local paths",
    );
  const parsed = config.data;
  return Object.freeze({
    workspaceRoots: Object.freeze(parsed.workspaceRoots),
    ...(parsed.claude === undefined ? {} : { claude: parsed.claude }),
    ...(parsed.codex === undefined ? {} : { codex: parsed.codex }),
  });
}

function parseAgentRoots(raw: string | undefined): unknown {
  try {
    return JSON.parse(raw ?? "[]");
  } catch {
    throw new RuntimeConfigurationError(
      "invalid_agent_config",
      "DOGGIE_AGENT_WORKSPACE_ROOTS must be a JSON array of absolute paths",
    );
  }
}
