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
import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import type { DoggieRuntimeConfig } from "./config.ts";

export type LocalWebDependencies = {
  readonly model?: MemoryModel | undefined;
  readonly fetchImplementation?: typeof fetch | undefined;
  readonly assets?: readonly StaticAsset[] | undefined;
};

export class DoggieLocalWeb {
  readonly server: Server;
  readonly database: DatabaseSync;
  readonly store: Store;
  readonly tasks: TaskQueue;
  readonly url: string;
  readonly #shutdownController: AbortController;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly server: Server;
    readonly database: DatabaseSync;
    readonly store: Store;
    readonly tasks: TaskQueue;
    readonly url: string;
    readonly shutdownController: AbortController;
  }) {
    this.server = input.server;
    this.database = input.database;
    this.store = input.store;
    this.tasks = input.tasks;
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
  try {
    const store = new Store(database);
    const model =
      dependencies.model ??
      createProductionModel(config, dependencies, shutdownController.signal);
    const runtime = new ArchiveRuntime(store, model);
    const api = new ConcreteDoggieHttpApi(store, runtime);
    tasks = new TaskQueue(new TaskStore(database), async (payload, signal) =>
      api.chat(payload, signal),
    );
    server = createDoggieNodeServer(api, {
      tasks,
      signal: shutdownController.signal,
      ...(dependencies.assets === undefined
        ? {}
        : { assets: dependencies.assets }),
    });
    server.listen(config.server.port, config.server.host);
    await once(server, "listening");
    return new DoggieLocalWeb({
      server,
      database,
      store,
      tasks,
      url: serverUrl(server),
      shutdownController,
    });
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
