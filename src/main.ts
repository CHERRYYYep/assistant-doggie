/** Production entry point for the TypeScript local Web application. */

import { pathToFileURL } from "node:url";

import { loadRuntimeConfig } from "./runtime/config.ts";
import {
  startDoggieLocalWeb,
  type DoggieLocalWeb,
} from "./runtime/local-web.ts";

export const SHUTDOWN_GRACE_MS = 5_000;

export async function runDoggieLocalWeb(): Promise<DoggieLocalWeb> {
  const config = loadRuntimeConfig();
  const application = await startDoggieLocalWeb(config);
  console.error(`doggie-local-web listening on ${application.url}`);
  installShutdownHandlers(application);
  return application;
}

function installShutdownHandlers(application: DoggieLocalWeb): void {
  let shutdownPromise: Promise<void> | undefined;
  const forceExit = () => {
    console.error(
      "doggie-local-web received a second signal; forcing process exit",
    );
    process.exit(1);
  };
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownPromise !== undefined) {
      forceExit();
      return;
    }
    const forceTimer = setTimeout(() => {
      console.error(
        "doggie-local-web shutdown timed out after cancelling model calls; forcing process exit",
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();
    shutdownPromise = application
      .close()
      .then(() => {
        clearTimeout(forceTimer);
        removeHandlers();
        console.error(`doggie-local-web stopped after ${signal}`);
      })
      .catch(() => {
        clearTimeout(forceTimer);
        removeHandlers();
        process.exitCode = 1;
      });
  };
  const removeHandlers = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  runDoggieLocalWeb().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "startup failed";
    console.error(`doggie-local-web failed: ${message}`);
    process.exitCode = 1;
  });
}
