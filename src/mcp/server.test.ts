import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { openDatabase } from "../storage/database.ts";
import { Store } from "../storage/store.ts";
import { createDoggieMcpServer } from "./server.ts";
import { DOGGIE_MCP_TOOL_NAMES } from "./tools.ts";

test("T10 official MCP server lists bounded tools and propose_entry never auto-archives", async () => {
  const store = new Store(openDatabase(":memory:"));
  const server = createDoggieMcpServer(store);
  const client = new Client({ name: "doggie-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      DOGGIE_MCP_TOOL_NAMES,
    );
    assert.equal(
      listed.tools.every(
        ({ inputSchema }) => inputSchema["additionalProperties"] === false,
      ),
      true,
    );

    const called = await client.callTool({
      name: "propose_entry",
      arguments: { text: "MCP 提交的事实 100%" },
    });
    assert.equal(called.isError, undefined);
    const structured = called.structuredContent as Record<string, unknown>;
    assert.equal(structured["archive_state"], "needs_confirmation");
    assert.equal(structured["entry_id"], null);
    assert.equal(structured["submitted_for_confirmation"], true);
    assert.equal(store.listBuckets().length, 0);
    assert.equal(store.listChatMessages(10).length, 1);
    await assert.rejects(
      client.callTool({ name: "archive_memory", arguments: { text: "事实" } }),
    );
    assert.equal(store.listBuckets().length, 0);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test("T10 official MCP validation rejects unknown fields before tool execution", async () => {
  const store = new Store(openDatabase(":memory:"));
  const server = createDoggieMcpServer(store);
  const client = new Client({ name: "doggie-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const result = await client.callTool({
      name: "propose_entry",
      arguments: { text: "事实", unexpected: true },
    });
    assert.equal(result.isError, true);
    const attempts = store.database
      .prepare("SELECT COUNT(*) AS count FROM archive_attempts")
      .get() as { count: number };
    assert.equal(attempts.count, 0);
    assert.equal(store.listChatMessages(10).length, 0);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
