/** Explicitly authorized experiment, never imported into production or npm test. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { format } from "prettier";
import { z } from "zod";
import { loadRuntimeConfig } from "../../src/runtime/config.ts";
import { StructuredOutputAdapter } from "../../src/llm/structured-output.ts";
import {
  StructuredMemoryModel,
  EXTRACTION_SYSTEM_PROMPT,
} from "../../src/application/archive-runtime.ts";
import { parseWireResponse } from "../../src/llm/wire-response.ts";
import type { StructuredOutputTransport } from "../../src/llm/transport.ts";
import { UPSTREAM_COMMIT } from "./client.ts";
import { L1_CASES, L1_FIXTURE_VERSION } from "./l1-fixtures.ts";
import {
  evaluateL1,
  matchesTerms,
  parentMessageSchema,
  workerMessageSchema,
} from "./l1-protocol.ts";
import { ModelBudget, boundedModelFetch, digest } from "./model-budget.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fake = process.argv.includes("--fake-model");
const upstream = process.env["D3_UPSTREAM_DIR"];
if (upstream === undefined || !isAbsolute(upstream))
  throw new Error("D3_UPSTREAM_DIR required");
function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.status !== 0) throw new Error("D3 Git verification failed");
  return result.stdout.trim();
}
if (
  git(upstream, ["rev-parse", "HEAD"]) !== UPSTREAM_COMMIT ||
  git(upstream, ["status", "--porcelain", "--untracked-files=no"]) !== ""
)
  throw new Error("D3 requires fixed, clean upstream checkout");
const limit = z.coerce
  .number()
  .int()
  .min(1)
  .max(50)
  .parse(process.env["D3_MODEL_REQUEST_LIMIT"] ?? "0");
const iterations = z.coerce
  .number()
  .int()
  .min(1)
  .max(3)
  .parse(process.env["D3_L1_ITERATIONS"] ?? "3");
// Do not load dotenv until the explicit entrypoint has a valid request cap.
const envPath = join(repoRoot, ".env");
const envHashBefore = fake ? null : digest(readFileSync(envPath, "utf8"));
const runtime = fake
  ? undefined
  : loadRuntimeConfig({ cwd: repoRoot, environment: {} });
const modelName = runtime?.model ?? "d3-fake-model";
const endpoint = runtime?.endpoint ?? {
  baseUrl: "http://127.0.0.1:1/v1",
  requestUrl: "http://127.0.0.1:1/v1/responses",
  apiMode: "responses" as const,
  site: "d3-fake",
  isOfficial: false,
};
let fakeCalls = 0;
const fakeTransport: StructuredOutputTransport = {
  send: async (request) => {
    fakeCalls++;
    const text = JSON.stringify(request.body);
    const item = L1_CASES.find((c) =>
      c.sources.some((s) => s.state === "active" && text.includes(s.text)),
    );
    if (item === undefined) throw new Error("fake fixture not found");
    const active = item.sources.filter((s) => s.state === "active");
    const isDoggie = text.includes("ExtractionResult");
    const content = isDoggie
      ? JSON.stringify({
          summary: active.map((s) => s.text).join("\n"),
          todos: [],
          evidences: [],
          timeline_events: [],
          decisions: [],
          hypotheses: [],
          entities: [],
          tags: [],
        })
      : JSON.stringify([
          {
            scene_name: item.id,
            message_ids: active.map((s) => s.id),
            memories: active.map((s) => ({
              content: s.text,
              type: "episodic",
              priority: 80,
              source_message_ids: [s.id],
              metadata: {},
            })),
          },
        ]);
    return {
      body: {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: content }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 100 },
      },
    };
  },
};
const budget = new ModelBudget(
  runtime?.createTransport(boundedModelFetch()) ?? fakeTransport,
  endpoint.requestUrl,
  modelName,
  limit,
);
const baseline = new StructuredMemoryModel(
  new StructuredOutputAdapter(endpoint, budget),
  modelName,
  0,
);
const tempRoot = mkdtempSync(join(tmpdir(), "doggie-d3-l1-"));
mkdirSync(join(tempRoot, "home"), { mode: 0o700 });
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const coreDir = join(upstream, "MemoryCore");
const report: {
  phase: string;
  fixtureVersion: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  authorization: unknown;
  environment: unknown;
  tencent: unknown[];
  doggie: unknown[];
  calls: unknown;
  errorCode?: string;
  cleanup?: unknown;
  summary?: unknown;
} = {
  phase:
    "L1 extractor core experiment; not integrated Core HTTP or full D3 acceptance",
  fixtureVersion: L1_FIXTURE_VERSION,
  startedAt: new Date().toISOString(),
  status: "running",
  authorization: {
    existingDotenvAuthorized: !fake,
    modelRequestLimit: limit,
    outputTokensPerRequest: 4096,
    automaticRetries: 0,
    iterations,
    scope: "30 synthetic sources only; active accepted subset",
  },
  environment: {
    doggieBaseCommit: git(repoRoot, ["rev-parse", "HEAD"]),
    upstreamCommit: UPSTREAM_COMMIT,
    upstreamLockSha256: digest(
      readFileSync(join(coreDir, "package-lock.json"), "utf8"),
    ),
    harnessSha256: Object.fromEntries(
      [
        "live-l1.ts",
        "l1-worker.ts",
        "l1-fixtures.ts",
        "l1-protocol.ts",
        "model-budget.ts",
      ].map((file) => [
        file,
        digest(readFileSync(join(repoRoot, "scripts/d3", file), "utf8")),
      ]),
    ),
    fixtureSha256: digest(JSON.stringify(L1_CASES)),
    model: modelName,
    apiMode: endpoint.apiMode,
    endpointIdentifier: fake
      ? "synthetic-disabled"
      : digest(endpoint.requestUrl),
    node: process.version,
    os: { platform: platform(), arch: arch() },
    promptMode: "chat",
    promptCustomization: "none",
    doggiePromptSha256: digest(EXTRACTION_SYSTEM_PROMPT),
    tencentPromptSha256: digest(
      readFileSync(join(coreDir, "src/core/prompts/l1-extraction.ts"), "utf8"),
    ),
    sourceMapping:
      "one synthetic Entry per L0 message; batches <=3; one session per case/iteration",
    runner:
      "upstream LLMRunner injection -> parent Doggie transport; native standalone Chat runner not used",
    generationCap: 4096,
    sampling: "provider defaults; no temperature/seed override",
    dedup: false,
    embedding: false,
    l2l3: false,
    networkIsolation:
      "child receives no model credential; parent fixed endpoint; no OS egress sandbox",
    cost: "unknown; request count cap is not a currency cap",
    qualityRun: !fake,
  },
  tencent: [],
  doggie: [],
  calls: [],
};
let child: ChildProcess | undefined;
let closed: Promise<void> | undefined;
let childDone = false;
type WorkerMessage = z.infer<typeof workerMessageSchema>;
type ParentMessage = z.infer<typeof parentMessageSchema>;
let expected: { caseId: string; iteration: number } | undefined;
let awaited:
  { resolve: (message: WorkerMessage) => void; reject: () => void } | undefined;
let modelInFlight = false;
let modelTask: Promise<void> | undefined;
let stopping = false;
let modelBridgeError: string | undefined;
function sendWorker(worker: ChildProcess, message: ParentMessage): void {
  if (stopping || !worker.connected) {
    awaited?.reject();
    return;
  }
  try {
    worker.send(message, (error) => {
      if (error !== null) awaited?.reject();
    });
  } catch {
    awaited?.reject();
  }
}
function waitMessage(timeoutMs: number): Promise<WorkerMessage> {
  if (awaited !== undefined) throw new Error("worker_protocol");
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => {
      awaited = undefined;
      reject(new Error("worker_timeout"));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      awaited = undefined;
      reject(new Error("interrupted"));
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    awaited = {
      resolve: (message) => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        awaited = undefined;
        resolveMessage(message);
      },
      reject: () => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        awaited = undefined;
        reject(new Error("worker_failed"));
      },
    };
  });
}
const results: ReturnType<typeof evaluateL1>[] = [];
let infrastructurePassed = true;
try {
  const fd = openSync(join(tempRoot, "worker.log"), "wx", 0o600);
  const ready = waitMessage(30000);
  try {
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(coreDir, "node_modules/tsx/dist/loader.mjs")).href,
        join(repoRoot, "scripts/d3/l1-worker.ts"),
      ],
      {
        cwd: tempRoot,
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: join(tempRoot, "home"),
          TMPDIR: tempRoot,
          TZ: "UTC",
          D3_CORE_DIR: coreDir,
          D3_TEMP_ROOT: tempRoot,
          D3_MODEL_NAME: modelName,
        },
        stdio: ["ignore", fd, fd, "ipc"],
        serialization: "json",
      },
    );
  } finally {
    closeSync(fd);
  }
  const worker = child;
  closed = new Promise<void>((done) => {
    worker.on("error", () => {
      awaited?.reject();
    });
    worker.once("close", () => {
      childDone = true;
      awaited?.reject();
      done();
    });
  });
  worker.on("message", (raw: unknown) => {
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      awaited?.reject();
      return;
    }
    const message = parsed.data;
    if (message.kind !== "model") {
      awaited?.resolve(message);
      return;
    }
    if (expected === undefined || modelInFlight) {
      awaited?.reject();
      return;
    }
    modelInFlight = true;
    modelTask = (async () => {
      budget.setLabel(`tencent-${expected.caseId}-${expected.iteration}`);
      const body =
        endpoint.apiMode === "responses"
          ? {
              model: modelName,
              store: false,
              instructions: message.systemPrompt,
              input: [{ role: "user", content: message.prompt }],
            }
          : {
              model: modelName,
              messages: [
                { role: "system", content: message.systemPrompt },
                { role: "user", content: message.prompt },
              ],
            };
      const response = await budget.send({
        url: endpoint.requestUrl,
        body,
        signal: controller.signal,
      });
      const result = parseWireResponse(endpoint.apiMode, response.body);
      if (
        result.kind !== "final_text" ||
        Buffer.byteLength(result.text) > 65536
      )
        throw new Error("model_protocol");
      sendWorker(worker, {
        kind: "model_result",
        callId: message.callId,
        text: result.text,
      });
    })()
      .catch((error: unknown) => {
        budget.close();
        modelBridgeError =
          error instanceof Error &&
          "kind" in error &&
          typeof error.kind === "string"
            ? error.kind
            : "budget_or_model_protocol";
        sendWorker(worker, { kind: "model_error", callId: message.callId });
      })
      .finally(() => {
        modelInFlight = false;
      });
  });
  if ((await ready).kind !== "ready") throw new Error("worker_startup");
  for (let iteration = 0; iteration < iterations; iteration++)
    for (const item of L1_CASES) {
      controller.signal.throwIfAborted();
      expected = { caseId: item.id, iteration };
      const completion = waitMessage(180000);
      sendWorker(worker, { kind: "job", ...expected });
      const result = await completion;
      if (
        result.kind !== "result" ||
        result.caseId !== item.id ||
        result.iteration !== iteration
      )
        throw new Error("worker_protocol");
      const evaluation = evaluateL1(
        item,
        result.extraction.records,
        `${item.id}-${iteration}`,
      );
      results.push(evaluation);
      const activeCount = item.sources.filter(
        (s) => s.state === "active",
      ).length;
      const storagePassed =
        result.extraction.storedCount === result.extraction.records.length &&
        result.persistedRecordCount === result.extraction.records.length &&
        result.persistedSourceIdsMatch &&
        result.sqliteL1Count === result.extraction.records.length &&
        result.foreignUserL1Count === 0 &&
        result.deletedL0Count === activeCount &&
        result.reopenedL1Count === result.sqliteL1Count;
      infrastructurePassed &&= storagePassed;
      report.tencent.push({
        ...result,
        evaluation,
        storagePassed,
        nativeL0DeletionCascadedToL1:
          result.sqliteL1Count > 0 ? result.l1CountAfterL0Deletion === 0 : null,
      });
      process.stdout.write(
        `D3 ${fake ? "fake " : ""}Tencent ${item.id} round ${iteration + 1}: ${evaluation.contentChecksPassed}/${evaluation.totalChecks} literal checks, ${evaluation.sourceValidRecordCount}/${evaluation.recordCount} source-valid records; model requests ${budget.calls.length}/${limit}\n`,
      );
      if (!result.extraction.success) throw new Error("extraction_failed");
      if (!storagePassed || evaluation.rejectedRecordCount > 0)
        throw new Error("source_or_storage_failed");
    }
  expected = undefined;
  for (const item of L1_CASES) {
    controller.signal.throwIfAborted();
    budget.setLabel(`doggie-${item.id}-0`);
    const text = item.sources
      .filter((s) => s.state === "active")
      .map((s) => s.text)
      .join("\n");
    const extraction = await baseline.extract(text, controller.signal);
    const content = [
      extraction.summary,
      ...extraction.todos,
      ...extraction.evidences,
      ...extraction.decisions,
      ...extraction.hypotheses,
      ...extraction.entities,
      ...extraction.tags,
      ...extraction.timelineEvents.map((e) => e.text),
    ].join("\n");
    report.doggie.push({
      caseId: item.id,
      extraction,
      checks: item.checks.map((check) => ({
        id: check.id,
        contentMatched: matchesTerms(content, check),
      })),
      sourceMapping:
        "local batch input binding only; native Doggie output has no per-fact source_message_ids",
    });
    process.stdout.write(
      `D3 ${fake ? "fake " : ""}Doggie ${item.id}: model requests ${budget.calls.length}/${limit}\n`,
    );
  }
  report.status = "completed_scoped_experiment";
} catch {
  report.status = "stopped";
  report.errorCode = controller.signal.aborted
    ? "interrupted"
    : "experiment_stopped";
  process.exitCode = 1;
} finally {
  stopping = true;
  budget.close();
  controller.abort();
  awaited?.reject();
  if (child !== undefined && !childDone) {
    child.kill("SIGTERM");
    const timeout = new AbortController();
    try {
      await Promise.race([
        closed,
        delay(2000, undefined, { signal: timeout.signal }).catch(
          () => undefined,
        ),
      ]);
    } finally {
      timeout.abort();
    }
    if (!childDone) child.kill("SIGKILL");
    await closed;
  }
  await modelTask;
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  report.calls = budget.calls;
  if (modelBridgeError !== undefined) report.errorCode = modelBridgeError;
  report.finishedAt = new Date().toISOString();
  const cleanup = {
    childStopped: child === undefined || childDone,
    dotenvUnchanged: fake
      ? null
      : envHashBefore === digest(readFileSync(envPath, "utf8")),
    temporaryDataRemoved: false,
  };
  rmSync(tempRoot, { recursive: true, force: true });
  report.cleanup = { ...cleanup, temporaryDataRemoved: true };
  const count = results.reduce((sum, r) => sum + r.totalChecks, 0);
  report.summary = {
    qualityRun: !fake,
    tencentCases: results.length,
    doggieCases: report.doggie.length,
    contentChecks: {
      passed: results.reduce((s, r) => s + r.contentChecksPassed, 0),
      total: count,
    },
    sourceAndContentChecks: {
      passed: results.reduce((s, r) => s + r.sourceChecksPassed, 0),
      total: count,
    },
    sourceValidity: {
      valid: results.reduce((s, r) => s + r.sourceValidRecordCount, 0),
      total: results.reduce((s, r) => s + r.recordCount, 0),
    },
    infrastructurePassed,
    modelHttpRequests: fake ? 0 : budget.calls.length,
    fakeTransportRequests: fake ? fakeCalls : 0,
    inputTokens: budget.calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
    outputTokens: budget.calls.reduce(
      (sum, c) => sum + (c.outputTokens ?? 0),
      0,
    ),
    usageComplete: budget.calls.every(
      (c) => c.inputTokens !== null && c.outputTokens !== null,
    ),
    fullD3Acceptance: false,
    decision:
      "No production adoption decision; integrated retrieval/dedup/revocation matrix still pending",
  };
  if (!fake) {
    const target = join(repoRoot, "docs/D3_L1_CORE_REPORT.json");
    writeFileSync(
      target,
      await format(JSON.stringify(report), { parser: "json" }),
      { mode: 0o600 },
    );
    process.stdout.write("D3 report saved to docs/D3_L1_CORE_REPORT.json\n");
  }
  process.stdout.write(
    JSON.stringify(
      {
        status: report.status,
        summary: report.summary,
        cleanup: report.cleanup,
      },
      null,
      2,
    ) + "\n",
  );
}
