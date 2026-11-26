/** Isolated upstream core worker. No credentials, .env loader or remote transport. */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { L1_CASES } from "./l1-fixtures.ts";
import {
  parentMessageSchema,
  extractionSchema,
  recordSchema,
} from "./l1-protocol.ts";

const coreDir = process.env["D3_CORE_DIR"];
const tempRoot = process.env["D3_TEMP_ROOT"];
if (
  coreDir === undefined ||
  tempRoot === undefined ||
  process.send === undefined
)
  throw new Error("D3 worker requires isolated parent");
const root = resolve(tempRoot);
async function loadExport(path: string, name: string): Promise<Function> {
  const value: unknown = await import(
    pathToFileURL(join(coreDir ?? "", path)).href
  );
  if (typeof value !== "object" || value === null || !(name in value))
    throw new Error("upstream_contract");
  const member: unknown = Reflect.get(value, name);
  if (typeof member !== "function") throw new Error("upstream_contract");
  return member;
}
function invoke(
  target: unknown,
  name: string,
  ...args: readonly unknown[]
): unknown {
  if (typeof target !== "object" || target === null)
    throw new Error("upstream_contract");
  const member: unknown = Reflect.get(target, name);
  if (typeof member !== "function") throw new Error("upstream_contract");
  const result: unknown = Reflect.apply(member, target, args);
  return result;
}
let stopping = false;
function send(message: unknown): void {
  if (stopping || !process.connected) return;
  process.send?.(message, (error: Error | null) => {
    if (error !== null) stopping = true;
  });
}
let nextCall = 0;
let pending:
  | { id: number; resolve: (text: string) => void; reject: () => void }
  | undefined;
const llmRunner = {
  run: async (params: {
    readonly systemPrompt?: string;
    readonly prompt: string;
    readonly taskId: string;
  }): Promise<string> => {
    if (
      params.taskId !== "l1-extraction" ||
      pending !== undefined ||
      params.systemPrompt === undefined
    )
      throw new Error("upstream_contract");
    const callId = ++nextCall;
    return new Promise<string>((resolveCall, reject) => {
      pending = {
        id: callId,
        resolve: resolveCall,
        reject: () => reject(new Error("model_unavailable")),
      };
      send({
        kind: "model",
        callId,
        systemPrompt: params.systemPrompt,
        prompt: params.prompt,
      });
    });
  },
};
const extract = await loadExport(
  "src/core/record/l1-extractor.ts",
  "extractL1Memories",
);
const Store = await loadExport(
  "src/core/store/sqlite/memory-store.ts",
  "VectorStore",
);
const createStore = (path: string): unknown => {
  const store: unknown = Reflect.construct(Store, [path, 0]);
  invoke(store, "init");
  if (invoke(store, "isDegraded") !== false)
    throw new Error("upstream_contract");
  return store;
};
let busy = false;
process.on("message", (raw: unknown) => {
  const message = parentMessageSchema.safeParse(raw);
  if (!message.success) {
    send({ kind: "error", code: "upstream_contract" });
    return;
  }
  const job = message.data;
  if (job.kind === "model_result" || job.kind === "model_error") {
    const call = pending;
    if (call === undefined || call.id !== job.callId) {
      send({ kind: "error", code: "upstream_contract" });
      return;
    }
    pending = undefined;
    if (job.kind === "model_result") call.resolve(job.text);
    else call.reject();
    return;
  }
  if (busy) {
    send({ kind: "error", code: "upstream_contract" });
    return;
  }
  busy = true;
  void (async () => {
    const item = L1_CASES.find((c) => c.id === job.caseId);
    if (item === undefined) throw new Error("upstream_contract");
    const sessionId = `${item.id}-${job.iteration}`;
    const baseDir = join(root, sessionId);
    mkdirSync(baseDir, { mode: 0o700 });
    const databasePath = join(baseDir, "memory.sqlite");
    const store = createStore(databasePath);
    const scope = {
      teamId: "d3-l1-team",
      userId: "d3-l1-user",
      agentId: "d3-l1-agent",
      sessionId,
    };
    try {
      const accepted = item.sources.filter((s) => s.state === "active");
      const messages = accepted.map((s, index) => ({
        id: s.id,
        role: "user",
        content: s.text,
        timestamp: Date.parse("2026-11-15T02:00:00Z") + index * 1000,
      }));
      for (const m of messages) {
        if (
          invoke(
            store,
            "upsertL0",
            {
              ...scope,
              id: m.id,
              sessionKey: sessionId,
              role: m.role,
              messageText: m.content,
              timestamp: m.timestamp,
              recordedAt: new Date(m.timestamp).toISOString(),
            },
            undefined,
          ) !== true
        )
          throw new Error("upstream_contract");
      }
      const rawResult: unknown = await Reflect.apply(extract, undefined, [
        {
          messages,
          sessionKey: sessionId,
          ...scope,
          baseDir,
          config: {},
          options: {
            maxMessagesPerExtraction: 10,
            maxBackgroundMessages: 0,
            maxMemoriesPerSession: 10,
            enableDedup: false,
            promptMode: "chat",
            model: process.env["D3_MODEL_NAME"],
            vectorStore: store,
            llmRunner,
          },
        },
      ]);
      const extraction = extractionSchema.parse(rawResult);
      const files = existsSync(join(baseDir, "records"))
        ? readdirSync(join(baseDir, "records"), { withFileTypes: true })
        : [];
      const persisted = files
        .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
        .flatMap((f) => {
          const bytes = readFileSync(join(baseDir, "records", f.name));
          if (bytes.byteLength > 262144) throw new Error("upstream_contract");
          return bytes
            .toString("utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => recordSchema.parse(JSON.parse(line)));
        });
      const persistedSourceIdsMatch = extraction.records.every((r) =>
        persisted.some(
          (p) =>
            p.id === r.id &&
            p.content === r.content &&
            JSON.stringify(p.source_message_ids) ===
              JSON.stringify(r.source_message_ids),
        ),
      );
      const sqliteL1Count = invoke(store, "countL1", scope);
      const foreignUserL1Count = invoke(store, "countL1", {
        ...scope,
        userId: "d3-l1-other-user",
      });
      let deletedL0Count = 0;
      for (const message of messages)
        if (invoke(store, "deleteL0", message.id, scope) === true)
          deletedL0Count++;
      const l1CountAfterL0Deletion = invoke(store, "countL1", scope);
      invoke(store, "close");
      const reopened = createStore(databasePath);
      let reopenedL1Count: unknown;
      try {
        reopenedL1Count = invoke(reopened, "countL1", scope);
      } finally {
        invoke(reopened, "close");
      }
      send({
        kind: "result",
        caseId: job.caseId,
        iteration: job.iteration,
        extraction,
        persistedRecordCount: persisted.length,
        persistedSourceIdsMatch,
        sqliteL1Count,
        foreignUserL1Count,
        deletedL0Count,
        l1CountAfterL0Deletion,
        reopenedL1Count,
      });
    } finally {
      invoke(store, "close");
    }
  })()
    .catch(() => send({ kind: "error", code: "worker_failed" }))
    .finally(() => {
      busy = false;
    });
});
process.on("disconnect", () => {
  stopping = true;
  pending?.reject();
  process.exitCode = 0;
});
send({ kind: "ready" });
