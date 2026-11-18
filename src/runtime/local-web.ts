import { WorkItemService } from "../application/work-items.ts";
import { WorkItemStore } from "../storage/work-items.ts";
import {
  AgentHarness,
  createMemoryHarnessTools,
  createHarnessChatResponder,
} from "../agent/harness.ts";
import { AgentService } from "../agent/service.ts";
import { WorkspacePolicy } from "../agent/workspace.ts";
import { CliAgentRunner, type AgentProcessRunner } from "../agent/process.ts";
import { AgentStore } from "../storage/agents.ts";
import type { ChatResponder } from "../application/chat-types.ts";
import { ChatService } from "../application/chat.ts";
/** Composition root for the local TypeScript Web application. */

import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import {
  ArchiveRuntime,
  StructuredMemoryModel,
  type MemoryModel,
} from "../application/archive-runtime.ts";
import { TaskQueue } from "../application/task-queue.ts";
import { TaskStore } from "../storage/tasks.ts";
import { ConcreteDoggieHttpApi } from "../http/api.ts";
import type { StaticAsset } from "../http/app.ts";
import {
  createDoggieNodeServer,
  drainDoggieNodeServer,
} from "../http/server.ts";
import { StructuredOutputAdapter } from "../llm/structured-output.ts";
import {
  assertDatabaseAvailable,
  onDatabaseFault,
  openDatabase,
} from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import type { DoggieRuntimeConfig } from "./config.ts";

export type LocalWebDependencies = {
  readonly model?: MemoryModel | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly assets?: readonly StaticAsset[] | undefined;
  readonly agentRunner?: AgentProcessRunner;
  readonly chatResponder?: ChatResponder;
};

export class DoggieLocalWeb {
  readonly server: Server;
  readonly database: DatabaseSync;
  readonly store: Store;
  readonly tasks: TaskQueue;
  readonly agents: AgentService;
  readonly url: string;
  readonly #shutdownController: AbortController;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly server: Server;
    readonly database: DatabaseSync;
    readonly store: Store;
    readonly tasks: TaskQueue;
    readonly agents: AgentService;
    readonly url: string;
    readonly shutdownController: AbortController;
  }) {
    this.server = input.server;
    this.database = input.database;
    this.store = input.store;
    this.tasks = input.tasks;
    this.agents = input.agents;
    this.url = input.url;
    this.#shutdownController = input.shutdownController;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#shutdownController.abort();
    const workerClose = this.tasks.close();
    const serverClose = this.server.listening
      ? once(this.server, "close")
      : Promise.resolve();
    this.server.close();
    this.server.closeAllConnections();
    try {
      await Promise.all([
        workerClose,
        serverClose,
        drainDoggieNodeServer(this.server),
      ]);
    } finally {
      // All settled is required even when one drain fails: no worker may retain
      // access to SQLite after close.
      await Promise.allSettled([
        workerClose,
        serverClose,
        drainDoggieNodeServer(this.server),
      ]);
      this.database.close();
    }
  }
}

export async function startDoggieLocalWeb(
  config: DoggieRuntimeConfig,
  dependencies: LocalWebDependencies = {},
): Promise<DoggieLocalWeb> {
  const database = openDatabase(config.databasePath);
  const shutdownController = new AbortController();
  let server: Server | undefined;
  let tasks: TaskQueue | undefined;
  let application: DoggieLocalWeb | undefined;
  onDatabaseFault(database, () => {
    if (application === undefined) return; // Startup checks the fault before publishing.
    console.error("doggie-local-web storage unavailable; stopping");
    void application.close().catch(() => {
      // A quarantined connection cannot release the persistent worker claim.
      // The next process recovers the abandoned claim after this PID exits.
    });
  });
  try {
    const store = new Store(database);
    const model =
      dependencies.model ??
      createProductionModel(config, dependencies, shutdownController.signal);
    const runtime = new ArchiveRuntime(store, model);
    const chatResponder =
      dependencies.chatResponder ??
      (dependencies.model === undefined
        ? createHarnessChatResponder(
            new AgentHarness(
              config.endpoint,
              config.createTransport(
                dependencies.fetchImplementation,
                shutdownController.signal,
              ),
              config.model,
              createMemoryHarnessTools(store),
            ),
          )
        : undefined);
    const chatService = new ChatService(store, runtime, chatResponder);
    const api = new ConcreteDoggieHttpApi(store, runtime, { chatService });
    const agents = new AgentService({
      store: new AgentStore(database),
      policy: new WorkspacePolicy(config.agent.workspaceRoots),
      runner: dependencies.agentRunner ?? new CliAgentRunner(config.agent),
      databasePath: config.databasePath,
      enabled: [
        ...(config.agent.claude === undefined ? [] : ["claude" as const]),
        ...(config.agent.codex === undefined ? [] : ["codex" as const]),
      ],
    });
    tasks = new TaskQueue(new TaskStore(database), async (payload, signal) =>
      "agent_task_id" in payload
        ? agents.execute(payload.agent_task_id, signal)
        : chatService.chat(
            { text: payload.message, focusBucketId: payload.focus_bucket_id },
            signal,
          ),
    );
    agents.attachQueue(tasks);
    server = createDoggieNodeServer(api, {
      tasks,
      agents,
      workItems: new WorkItemService(new WorkItemStore(database), agents),
      signal: shutdownController.signal,
      ...(dependencies.assets === undefined
        ? {}
        : { assets: dependencies.assets }),
    });
    server.listen(config.server.port, config.server.host);
    await once(server, "listening");
    assertDatabaseAvailable(database);
    application = new DoggieLocalWeb({
      server,
      database,
      store,
      tasks,
      agents,
      url: serverUrl(server),
      shutdownController,
    });
    return application;
  } catch (error) {
    shutdownController.abort();
    const workerClose = tasks?.close();
    const serverClose = server?.listening
      ? once(server, "close").catch(() => undefined)
      : Promise.resolve();
    server?.close();
    server?.closeAllConnections();
    try {
      await Promise.allSettled([
        workerClose,
        serverClose,
        server === undefined ? undefined : drainDoggieNodeServer(server),
      ]);
    } finally {
      database.close();
    }
    // Preserve the original startup failure. Cleanup faults must not skip
    // remaining resources or replace the user's actionable bind/config error.
    throw error;
  }
}

function createProductionModel(
  config: DoggieRuntimeConfig,
  dependencies: LocalWebDependencies,
  shutdownSignal: AbortSignal,
): StructuredMemoryModel {
  const transport = config.createTransport(
    dependencies.fetchImplementation,
    shutdownSignal,
  );
  const adapter = new StructuredOutputAdapter(config.endpoint, transport);
  return new StructuredMemoryModel(adapter, config.model);
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Doggie HTTP server is not bound to an IP socket");
  }
  return urlForAddress(address);
}

function urlForAddress(address: AddressInfo): string {
  if (!isLoopbackAddress(address.address)) {
    throw new Error("Doggie HTTP server resolved outside loopback");
  }
  const host =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}/`;
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  const octets = address.split(".");
  return octets.length === 4 && octets[0] === "127";
}
