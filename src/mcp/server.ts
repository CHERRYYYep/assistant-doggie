/** Official-SDK MCP server exposing Doggie's bounded memory tools. */

import { McpServer } from "@modelcontextprotocol/server";

import { stableError } from "../http/contracts.ts";
import type { JsonValue, Store } from "../storage/store.ts";
import {
  boundedToolResult,
  DoggieMcpTools,
  GET_BUCKET_DETAIL_TOOL,
  getBucketDetailInputSchema,
  LIST_ACTIVE_BUCKETS_TOOL,
  listActiveBucketsInputSchema,
  PROPOSE_ENTRY_TOOL,
  proposeEntryInputSchema,
  SEARCH_MEMORY_TOOL,
  searchMemoryInputSchema,
} from "./tools.ts";

export const DOGGIE_MCP_SERVER_NAME = "doggie-memory";
export const DOGGIE_MCP_SERVER_VERSION = "0.1.0";

export function createDoggieMcpServer(
  store: Store,
  clock: () => Date = () => new Date(),
): McpServer {
  const tools = new DoggieMcpTools(store, clock);
  const server = new McpServer(
    { name: DOGGIE_MCP_SERVER_NAME, version: DOGGIE_MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    LIST_ACTIVE_BUCKETS_TOOL,
    {
      title: "List active Doggie buckets",
      description:
        "列出最近活跃的 Doggie Bucket。只读；用户提到历史工作但没有关键词时使用。",
      inputSchema: listActiveBucketsInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => toolResponse(() => tools.listActiveBuckets()),
  );

  server.registerTool(
    SEARCH_MEMORY_TOOL,
    {
      title: "Search Doggie memory",
      description:
        "用自然语言搜索 Doggie 的 Entry、Bucket 和结构化 evidence。只读。",
      inputSchema: searchMemoryInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ query }) => toolResponse(() => tools.searchMemory(query)),
  );

  server.registerTool(
    GET_BUCKET_DETAIL_TOOL,
    {
      title: "Get Doggie bucket detail",
      description: "读取一个真实 Bucket 的 Entry 和 memory 详情。只读。",
      inputSchema: getBucketDetailInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ bucket_id }) =>
      toolResponse(() => tools.getBucketDetail(bucket_id)),
  );

  server.registerTool(
    PROPOSE_ENTRY_TOOL,
    {
      title: "Propose a Doggie memory entry",
      description:
        "提交一条待确认的工作记忆。只创建 needs_confirmation attempt；不会直接创建 Bucket、Entry 或 memory。",
      inputSchema: proposeEntryInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ text, bucket_id }) =>
      toolResponse(() => tools.proposeEntry(text, bucket_id)),
  );

  return server;
}

function toolResponse(action: () => JsonValue) {
  try {
    const value = boundedToolResult(action());
    const isError = isJsonObject(value) && value["ok"] === false;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value as Record<string, unknown>,
      ...(isError ? { isError: true } : {}),
    };
  } catch (error: unknown) {
    const value = stableError(error).body;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
      structuredContent: value,
      isError: true,
    };
  }
}

function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
