/** Doggie MCP stdio process entry point. Never writes protocol noise to stdout. */

import { fileURLToPath } from "node:url";

import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";

import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { createDoggieMcpServer } from "./server.ts";

export const MAX_MCP_STDIO_MESSAGE_BYTES = 64 * 1024;

const defaultDatabasePath = fileURLToPath(
  new URL("../../doggie.db", import.meta.url),
);
const databasePath =
  process.env["DOGGIE_DATABASE_PATH"]?.trim() ||
  process.env["RUST_DATABASE_PATH"]?.trim() ||
  defaultDatabasePath;
const store = new Store(openDatabase(databasePath));
const transport = new StdioServerTransport(process.stdin, process.stdout, {
  maxBufferSize: MAX_MCP_STDIO_MESSAGE_BYTES,
});

serveStdio(
  () =>
    createDoggieMcpServer(
      store,
      undefined,
      process.env["DOGGIE_MCP_READ_ONLY"] === "1",
    ),
  {
    transport,
    onerror(error) {
      console.error(`doggie-mcp error: ${error.message}`);
    },
  },
);
