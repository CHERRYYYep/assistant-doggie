/** Explicit L0-only runner; production never imports this file. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, platform, release, arch } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "prettier";
import { CoreClient, UPSTREAM_COMMIT, healthSchema } from "./client.ts";
import { smokeReportSchema } from "./report.ts";
import { runMatrixProbe } from "./matrix-probe.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const upstreamDir = process.env["D3_UPSTREAM_DIR"];
if (upstreamDir === undefined || !isAbsolute(upstreamDir))
  throw new Error(
    "Set D3_UPSTREAM_DIR to an absolute fixed-commit MemoryCore checkout.",
  );
const checkout = resolve(upstreamDir);
function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status !== 0)
    throw new Error("Cannot verify experiment Git state.");
  return result.stdout.trim();
}
if (git(checkout, ["rev-parse", "HEAD"]) !== UPSTREAM_COMMIT)
  throw new Error("D3 upstream checkout must be exactly " + UPSTREAM_COMMIT);
if (git(checkout, ["status", "--porcelain", "--untracked-files=no"]) !== "")
  throw new Error("D3 upstream tracked files must be clean.");
const coreDir = join(checkout, "MemoryCore");
if (
  !existsSync(join(coreDir, "src/gateway/server.ts")) ||
  !existsSync(join(coreDir, "node_modules/tsx/package.json"))
)
  throw new Error(
    "Install the pinned MemoryCore checkout dependencies before running D3.",
  );

// Each child gets an allow-listed environment and only private log file descriptors.
// Capture error/close immediately so failed spawns cannot become unhandled events.
type ManagedChild = {
  readonly process: ChildProcess;
  readonly closed: Promise<number | null>;
  done: boolean;
};
const children: ManagedChild[] = [];
const tempRoot = mkdtempSync(join(tmpdir(), "doggie-d3-isolated-"));
const normalizedTempRoot = resolve(tempRoot);
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
function start(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logName: string,
): ManagedChild {
  const fd = openSync(join(tempRoot, logName), "wx", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  const tracked: ManagedChild = {
    process: child,
    done: false,
    closed: new Promise<number | null>((resolveClose) => {
      child.once("error", () => {
        /* close follows error; log details stay private. */
      });
      child.once("close", (code) => {
        tracked.done = true;
        resolveClose(code);
      });
    }),
  };
  children.push(tracked);
  return tracked;
}
async function stop(child: ManagedChild): Promise<void> {
  if (child.done) return;
  child.process.kill("SIGTERM");
  const waitAbort = new AbortController();
  try {
    await Promise.race([
      child.closed,
      delay(2000, undefined, { signal: waitAbort.signal }).catch(
        () => undefined,
      ),
    ]);
  } finally {
    waitAbort.abort();
  }
  if (!child.done) child.process.kill("SIGKILL");
  // Wait for actual process closure before removing its SQLite files.
  await child.closed;
}
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  if (!normalizedTempRoot.startsWith(resolve(tmpdir()) + "/"))
    throw new Error("Refusing an unsafe experiment temporary path.");
  mkdirSync(join(tempRoot, "home"), { mode: 0o700 });
  mkdirSync(join(tempRoot, "logs"), { mode: 0o700 });
  const portServer = createServer();
  let port: number;
  try {
    port = await new Promise<number>((resolvePort, reject) => {
      portServer.once("error", reject);
      portServer.listen(0, "127.0.0.1", () => {
        const address = portServer.address();
        if (address === null || typeof address === "string")
          reject(new Error("Could not reserve loopback port."));
        else resolvePort(address.port);
      });
    });
  } finally {
    if (portServer.listening)
      await new Promise<void>((done) => portServer.close(() => done()));
  }
  const gatewayKey = "d3-synthetic-" + randomUUID();
  const instanceId = "d3-experiment-" + randomUUID().slice(0, 8);
  const configPath = join(tempRoot, "gateway.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      deployMode: "standalone",
      stateBackend: "local",
      server: { port, host: "127.0.0.1", apiKey: gatewayKey },
      data: { baseDir: join(tempRoot, "core-data") },
      metadata: { store: { sqliteBaseDir: join(tempRoot, "metadata") } },
      llm: {
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "d3-synthetic-disabled",
        model: "d3-disabled",
        timeoutMs: 500,
      },
      memory: {
        storeBackend: "sqlite",
        capture: { enabled: true },
        extraction: { enabled: false },
        embedding: { provider: "none" },
        pipeline: {
          everyNConversations: 999999,
          enableWarmup: false,
          l1IdleTimeoutSeconds: 86400,
        },
        recall: { enabled: true, strategy: "bm25" },
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: join(tempRoot, "home"),
    TMPDIR: tempRoot,
    LOG_PATH: join(tempRoot, "logs") + "/",
    TDAI_GATEWAY_CONFIG: configPath,
    TDAI_METADATA_SQLITE_BASE_DIR: join(tempRoot, "metadata"),
    V3_STRICT_ISOLATION: "1",
    TZ: "UTC",
  };
  abort.signal.throwIfAborted();
  const core = start(
    ["--import", "tsx", "src/gateway/server.ts"],
    coreDir,
    childEnv,
    "core.log",
  );
  const endpoint = "http://127.0.0.1:" + port;
  const probe = new CoreClient(endpoint, gatewayKey, instanceId, 500, 32768);
  const deadline = performance.now() + 30000;
  let ready = false;
  while (performance.now() < deadline && !core.done) {
    abort.signal.throwIfAborted();
    try {
      const health = await probe.request("/health", healthSchema);
      if (health.status === "ok") {
        ready = true;
        break;
      }
    } catch {
      /* Retry only the local read-only startup probe. */
    }
    await delay(250, undefined, { signal: abort.signal });
  }
  if (!ready) throw new Error("MemoryCore startup failed.");
  abort.signal.throwIfAborted();
  if (process.argv.includes("--matrix-probe")) {
    const report = await runMatrixProbe(
      endpoint,
      gatewayKey,
      instanceId,
      tempRoot,
      abort.signal,
    );
    const artifact = {
      upstreamCommit: UPSTREAM_COMMIT,
      upstreamLockSha256: sha256(join(coreDir, "package-lock.json")),
      doggieBaseCommit: git(repoRoot, ["rev-parse", "HEAD"]),
      harnessSha256: Object.fromEntries(
        [
          "run.ts",
          "matrix-probe.ts",
          "matrix-journal.ts",
          "matrix-harness.ts",
          "source-guard.ts",
          "client.ts",
        ].map((file) => [file, sha256(join(repoRoot, "scripts/d3", file))]),
      ),
      node: process.version,
      modelRequests: 0,
      mode: "real Core L0 with client-side receipt loss; no OS egress isolation",
      startedAt: report.startedAt,
      completed: report.completed,
      failedAt: report.failedAt,
    };
    const rendered = await format(JSON.stringify(artifact), { parser: "json" });
    writeFileSync(
      join(repoRoot, "docs/D3_L0_MATRIX_PROBE_REPORT.json"),
      rendered,
      { mode: 0o600 },
    );
    process.stdout.write(rendered);
    if (report.failedAt !== null) process.exitCode = 1;
  } else {
    await runSmoke(endpoint, gatewayKey, instanceId, childEnv, port);
  }
} catch {
  process.stderr.write(
    "D3 isolated L0 runner failed; temporary processes and data are being cleaned up.\n",
  );
  process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) await stop(child);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (normalizedTempRoot.startsWith(resolve(tmpdir()) + "/"))
    rmSync(normalizedTempRoot, { recursive: true, force: true });
}

async function runSmoke(
  endpoint: string,
  gatewayKey: string,
  instanceId: string,
  childEnv: NodeJS.ProcessEnv,
  port: number,
): Promise<void> {
  const reportPath = join(tempRoot, "report.json");
  const smoke = start(
    ["scripts/d3/live-smoke.ts"],
    repoRoot,
    {
      PATH: childEnv["PATH"],
      HOME: childEnv["HOME"],
      TMPDIR: tempRoot,
      TZ: "UTC",
      D3_CORE_URL: endpoint,
      D3_GATEWAY_KEY: gatewayKey,
      D3_INSTANCE_ID: instanceId,
      D3_ITERATIONS: process.env["D3_ITERATIONS"] ?? "3",
      D3_REPORT_PATH: reportPath,
    },
    "smoke.log",
  );
  const waitAbort = new AbortController();
  let status: number | null | "interrupted" | "timeout";
  const interrupted = new Promise<"interrupted">((done) =>
    abort.signal.addEventListener("abort", () => done("interrupted"), {
      once: true,
    }),
  );
  try {
    status = await Promise.race([
      smoke.closed,
      interrupted,
      delay(180000, "timeout" as const, { signal: waitAbort.signal }).catch(
        () => "timeout" as const,
      ),
    ]);
  } finally {
    waitAbort.abort();
  }
  if (status !== 0 || !existsSync(reportPath))
    throw new Error(
      "D3 smoke failed, timed out or was interrupted; private temporary state will be removed.",
    );
  if (readFileSync(reportPath).byteLength > 1048576)
    throw new Error("D3 report exceeded limit.");
  const report = smokeReportSchema.parse(
    JSON.parse(readFileSync(reportPath, "utf8")),
  );
  if (
    report.errorCode !== undefined ||
    report.summary === undefined ||
    report.runs.length === 0
  )
    throw new Error("D3 smoke did not produce a complete L0 report.");
  const sorted = [...report.transport.latenciesMs].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  const artifact = {
    environment: {
      doggieBaseCommit: git(repoRoot, ["rev-parse", "HEAD"]),
      // Implementation was pending a stage commit at experiment time.
      doggieTrackedDirty:
        git(repoRoot, ["status", "--porcelain", "--untracked-files=no"]) !== "",
      harnessSha256: Object.fromEntries(
        [
          "run.ts",
          "live-smoke.ts",
          "client.ts",
          "fixtures.ts",
          "source-guard.ts",
          "report.ts",
        ].map((file) => [file, sha256(join(repoRoot, "scripts/d3", file))]),
      ),
      os: { platform: platform(), release: release(), arch: arch() },
      upstreamTrackedDirty: false,
      upstreamLockSha256: sha256(join(coreDir, "package-lock.json")),
      doggieLockSha256: sha256(join(repoRoot, "package-lock.json")),
      sdk: "direct HTTP; no SDK",
      index: "BM25/SQLite FTS5",
      model: "disabled",
      apiMode: "not used",
      promptVersion: "not used",
      embedding: "none",
      loopbackPort: port,
      networkIsolation:
        "loopback endpoints and allow-listed environment; no OS firewall sandbox",
      latencyMs: { median: percentile(0.5), p95: percentile(0.95) },
    },
    ...report,
  };
  const rendered = await format(JSON.stringify(artifact), { parser: "json" });
  const reportTarget = join(repoRoot, "docs/D3_L0_SMOKE_REPORT.json");
  writeFileSync(reportTarget, rendered, { mode: 0o600 });
  process.stdout.write(
    JSON.stringify(
      {
        reportPath: reportTarget,
        reportSha256: sha256(reportTarget),
        baseline: report.baselineSummary,
        summary: report.summary,
        latencyMs: artifact.environment.latencyMs,
      },
      null,
      2,
    ) + "\n",
  );
}
