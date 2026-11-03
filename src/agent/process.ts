/** Headless CLI boundary: fixed executables/argv, bounded JSONL, no shell. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AgentError,
  type AgentBackend,
  type AgentSession,
  type AgentTask,
} from "../domain/agent.ts";
import { throwIfAborted } from "../llm/cancellation.ts";
import { READ_ONLY_TOOL_NAMES } from "./harness.ts";
export const MAX_AGENT_STREAM_BYTES = 1024 * 1024;
export const MAX_AGENT_LINE_BYTES = 128 * 1024;
export type AgentProcessRequest = {
  readonly task: AgentTask;
  readonly session: AgentSession;
  readonly cwd: string;
  readonly databasePath: string;
  readonly signal: AbortSignal;
};
export type AgentProcessResult = {
  readonly output: string;
  readonly remoteId: string;
};
export type AgentProcessRunner = {
  readonly run: (request: AgentProcessRequest) => Promise<AgentProcessResult>;
};
export type AgentLaunchSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input: string;
};
const mcpMain = new URL("../mcp/main.ts", import.meta.url);
// Never inherit NODE_OPTIONS, arbitrary proxy helpers, shell startup config or
// Doggie's OPENAI_API_KEY. CLI auth is separate from the Web model credential.
export function agentEnvironment(databasePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    DOGGIE_DATABASE_PATH: databasePath,
    DOGGIE_MCP_READ_ONLY: "1",
  };
  for (const name of [
    "PATH",
    "HOME",
    "LANG",
    "TERM",
    "CODEX_HOME",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
export function buildAgentLaunch(
  request: AgentProcessRequest,
  executable: string,
): AgentLaunchSpec {
  if (
    !isAbsolute(executable) ||
    !isAbsolute(request.cwd) ||
    !isAbsolute(request.databasePath)
  )
    throw new AgentError("unavailable");
  const node = process.execPath;
  const mcp = {
    command: node,
    args: [fileURLToPath(mcpMain)],
    env: {
      DOGGIE_DATABASE_PATH: request.databasePath,
      DOGGIE_MCP_READ_ONLY: "1",
    },
  };
  let args: string[];
  if (request.task.backend === "claude") {
    const native =
      request.task.workspaceId === null
        ? ["WebSearch"]
        : ["Read", "Grep", "Glob", "WebSearch"];
    const allowed = [
      ...native,
      ...READ_ONLY_TOOL_NAMES.map((name) => `mcp__doggie__${name}`),
    ];
    args = [
      "--print",
      "--bare",
      "--restricted",
      "--verbose",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { doggie: mcp } }),
      "--tools",
      native.join(","),
      "--allowedTools",
      allowed.join(","),
      "--permission-mode",
      "dontAsk",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        permissions: {
          deny: [
            "Bash",
            "Write",
            "Edit",
            "Agent",
            "Task",
            "NotebookEdit",
            "mcp__doggie__propose_entry",
          ],
        },
      }),
    ];
    args.push(
      request.session.remoteId === null ? "--session-id" : "--resume",
      request.session.remoteId ?? request.session.id,
    );
  } else {
    args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--config",
      'sandbox_mode="read-only"',
      "--config",
      'approval_policy="never"',
      "--config",
      "agents.enabled=false",
      "--config",
      "project_doc_max_bytes=0",
      "--config",
      'web_search="cached"',
    ];
    for (const feature of [
      "hooks",
      "plugins",
      "apps",
      "multi_agent",
      "js_repl",
      "browser_use",
      "computer_use",
      "view_image",
      "skill_search",
      "skill_mcp_dependency_install",
    ])
      args.push("--disable", feature);
    if (request.task.workspaceId === null) args.push("--disable", "shell_tool");
    // Replace the entire MCP table; only retrieval tools are exposed. The
    // spawned Doggie server also removes propose_entry, as a second boundary.
    const table = `{ doggie = { command = ${JSON.stringify(node)}, args = [${JSON.stringify(fileURLToPath(mcpMain))}], env = { DOGGIE_DATABASE_PATH = ${JSON.stringify(request.databasePath)}, DOGGIE_MCP_READ_ONLY = "1" }, enabled_tools = [${READ_ONLY_TOOL_NAMES.map((n) => JSON.stringify(n)).join(",")}], required = true } }`;
    args.push("--config", `mcp_servers=${table}`);
    if (request.session.remoteId !== null)
      args.push("resume", request.session.remoteId, "-");
    else args.push("--skip-git-repo-check", "-");
  }
  return {
    command: executable,
    args,
    cwd: request.cwd,
    env: agentEnvironment(request.databasePath),
    input: request.task.instruction,
  };
}

/** Parse only final result/session identity, never persist raw events or stderr. */
export class AgentEventParser {
  readonly #backend: AgentBackend;
  #buffer = "";
  #total = 0;
  #output = "";
  #remote: string | undefined;
  #finished = false;
  #events = 0;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(backend: AgentBackend) {
    this.#backend = backend;
  }
  push(chunk: Uint8Array): void {
    this.#total += chunk.byteLength;
    if (this.#total > MAX_AGENT_STREAM_BYTES)
      throw new AgentError("output_limit");
    try {
      this.#buffer += this.#decoder.decode(chunk, { stream: true });
    } catch {
      throw new AgentError("invalid_event");
    }
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      this.#line(line);
    }
    if (Buffer.byteLength(this.#buffer) > MAX_AGENT_LINE_BYTES)
      throw new AgentError("output_limit");
  }
  finish(): AgentProcessResult {
    try {
      this.#buffer += this.#decoder.decode();
    } catch {
      throw new AgentError("invalid_event");
    }
    if (this.#buffer.trim()) this.#line(this.#buffer);
    if (!this.#finished || this.#remote === undefined)
      throw new AgentError("invalid_event");
    return { output: this.#output, remoteId: this.#remote };
  }
  #line(line: string): void {
    if (!line.trim()) return;
    if (++this.#events > 8192 || Buffer.byteLength(line) > MAX_AGENT_LINE_BYTES)
      throw new AgentError("output_limit");
    let event: Record<string, unknown>;
    try {
      event = z.record(z.string(), z.unknown()).parse(JSON.parse(line));
    } catch {
      throw new AgentError("invalid_event");
    }
    if (this.#finished) throw new AgentError("invalid_event");
    if (this.#backend === "codex") {
      if (event["type"] === "thread.started")
        this.#identity(event["thread_id"]);
      if (event["type"] === "item.completed") {
        const parsed = z
          .record(z.string(), z.unknown())
          .safeParse(event["item"]);
        if (!parsed.success) throw new AgentError("invalid_event");
        const item = parsed.data;
        if (item["type"] === "agent_message") {
          if (typeof item["text"] !== "string")
            throw new AgentError("invalid_event");
          this.#output = item["text"];
        }
      }
      if (event["type"] === "turn.failed" || event["type"] === "error")
        throw new AgentError("process_failed");
      if (event["type"] === "turn.completed") this.#finished = true;
    } else {
      if (event["type"] === "system" && event["subtype"] === "init")
        this.#identity(event["session_id"]);
      if (event["type"] === "result") {
        if (
          event["subtype"] !== "success" ||
          event["is_error"] === true ||
          typeof event["result"] !== "string"
        )
          throw new AgentError("process_failed");
        this.#identity(event["session_id"]);
        this.#output = event["result"];
        this.#finished = true;
      }
    }
    if (Buffer.byteLength(this.#output) > 64 * 1024)
      throw new AgentError("output_limit");
  }
  #identity(value: unknown): void {
    const id = z.string().uuid().safeParse(value);
    if (!id.success || (this.#remote !== undefined && id.data !== this.#remote))
      throw new AgentError("invalid_event");
    this.#remote = id.data;
  }
}

export class CliAgentRunner implements AgentProcessRunner {
  readonly #executables: Readonly<Partial<Record<AgentBackend, string>>>;
  readonly #validated = new Map<AgentBackend, Promise<void>>();
  constructor(executables: Readonly<Partial<Record<AgentBackend, string>>>) {
    this.#executables = executables;
  }
  async run(request: AgentProcessRequest): Promise<AgentProcessResult> {
    throwIfAborted(request.signal);
    const command = this.#executables[request.task.backend];
    if (command === undefined) throw new AgentError("disabled");
    if (!this.#validated.has(request.task.backend))
      this.#validated.set(
        request.task.backend,
        this.#preflight(request.task.backend, command),
      );
    await this.#validated.get(request.task.backend);
    throwIfAborted(request.signal);
    return runAgentProcess(
      buildAgentLaunch(request, command),
      request.task.backend,
      request.signal,
    );
  }
  async #preflight(backend: AgentBackend, command: string): Promise<void> {
    try {
      const { stdout } = await promisify(execFile)(
        command,
        backend === "codex" ? ["exec", "--help"] : ["--help"],
        { timeout: 5000, maxBuffer: 128 * 1024, env: agentEnvironment("") },
      );
      const required =
        backend === "codex"
          ? ["--ignore-user-config", "--ignore-rules", "--json", "--disable"]
          : [
              "--bare",
              "--restricted",
              "--strict-mcp-config",
              "--permission-mode",
            ];
      if (required.some((flag) => !stdout.includes(flag))) throw new Error();
    } catch {
      throw new AgentError("unavailable");
    }
  }
}
export async function runAgentProcess(
  spec: AgentLaunchSpec,
  backend: AgentBackend,
  signal: AbortSignal,
): Promise<AgentProcessResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const parser = new AgentEventParser(backend);
    let failure: AgentError | undefined;
    let stderrBytes = 0;
    let force: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
    });
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already exited */
      }
    };
    const stop = () => {
      kill("SIGTERM");
      force ??= setTimeout(() => kill("SIGKILL"), 500);
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure !== undefined) return;
      try {
        parser.push(chunk);
      } catch (error) {
        failure =
          error instanceof AgentError ? error : new AgentError("invalid_event");
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        failure = new AgentError("output_limit");
        stop();
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(spec.input);
    child.on("error", () => {
      failure = new AgentError("unavailable");
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (force !== undefined) clearTimeout(force);
      kill("SIGKILL");
      try {
        throwIfAborted(signal);
        if (failure !== undefined) throw failure;
        if (code !== 0) throw new AgentError("process_failed");
        const result = parser.finish();
        let output = result.output;
        for (const [key, value] of Object.entries(spec.env)) {
          if (/KEY|TOKEN|SECRET/u.test(key) && value)
            output = output.split(value).join("[redacted]");
        }
        resolve({ ...result, output });
      } catch (error) {
        reject(error);
      }
    });
  });
}
/** Stable empty cwd for non-coding sessions; never use the server's repository cwd. */
export async function withAgentCwd<T>(
  workspacePath: string | null,
  databasePath: string,
  sessionId: string,
  operation: (cwd: string) => Promise<T>,
): Promise<T> {
  if (workspacePath !== null) return operation(workspacePath);
  if (!z.string().uuid().safeParse(sessionId).success)
    throw new AgentError("binding_mismatch");
  const parent = await realpath(dirname(databasePath));
  const root = join(parent, ".doggie-agent-sessions");
  const cwd = join(root, sessionId);
  for (const directory of [root, cwd]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw new AgentError("invalid_workspace");
    });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()) ||
      (await realpath(directory)) !== directory
    )
      throw new AgentError("invalid_workspace");
  }
  return operation(cwd);
}
