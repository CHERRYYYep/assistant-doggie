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
import { ConcreteDoggieHttpApi } from "../http/api.ts";
import type { StaticAsset } from "../http/app.ts";
import { createDoggieNodeServer } from "../http/server.ts";
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
  readonly url: string;
  readonly #shutdownController: AbortController;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly server: Server;
    readonly database: DatabaseSync;
    readonly store: Store;
    readonly url: string;
    readonly shutdownController: AbortController;
  }) {
    this.server = input.server;
    this.database = input.database;
    this.store = input.store;
    this.url = input.url;
    this.#shutdownController = input.shutdownController;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#shutdownController.abort();
    try {
      this.server.closeIdleConnections();
      if (this.server.listening) {
        this.server.close();
        await once(this.server, "close");
      }
    } finally {
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
  try {
    const store = new Store(database);
    const model =
      dependencies.model ??
      createProductionModel(config, dependencies, shutdownController.signal);
    const runtime = new ArchiveRuntime(store, model);
    const api = new ConcreteDoggieHttpApi(store, runtime);
    server = createDoggieNodeServer(api, {
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
      url: serverUrl(server),
      shutdownController,
    });
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections();
      server.close();
      await once(server, "close").catch(() => undefined);
    }
    database.close();
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
