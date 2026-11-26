/** Doggie MCP tool contracts and bounded application service. */

import { z } from "zod";

import { ArchiveService, type ArchiveResult } from "../application/archive.ts";
import {
  MemoryTools,
  DEFAULT_MEMORY_RESULT_LIMIT,
  MAX_MEMORY_QUERY_CHARS,
  MAX_BUCKET_REFERENCE_CHARS,
} from "../application/memory-tools.ts";
export {
  listActiveBucketsInputSchema,
  searchMemoryInputSchema,
  getBucketDetailInputSchema,
} from "../application/memory-tools.ts";
import { askUser, buildBucketCandidates } from "../domain/classification.ts";
import { requiredText } from "../domain/errors.ts";
import { BucketStatus, type BucketView } from "../domain/types.ts";
import { toBucketView } from "../application/archive-runtime.ts";
import { StorageError } from "../storage/database.ts";
import type { JsonValue, Store } from "../storage/store.ts";
import {
  projectBucketDetail,
  projectMemoryQuery,
} from "../application/memory-view.ts";
import { projectArchive, projectBucket } from "../application/archive-view.ts";

export const LIST_ACTIVE_BUCKETS_TOOL = "list_active_buckets";
export const SEARCH_MEMORY_TOOL = "search_memory";
export const GET_BUCKET_DETAIL_TOOL = "get_bucket_detail";
export const PROPOSE_ENTRY_TOOL = "propose_entry";

export const MAX_MCP_QUERY_CHARS = MAX_MEMORY_QUERY_CHARS;
export const MAX_MCP_BUCKET_ID_CHARS = MAX_BUCKET_REFERENCE_CHARS;
export const MAX_MCP_ENTRY_TEXT_CHARS = 16_000;
export const MAX_MCP_TOOL_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_MCP_RESULT_LIMIT = DEFAULT_MEMORY_RESULT_LIMIT;

export const proposeEntryInputSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_MCP_ENTRY_TEXT_CHARS),
    bucket_id: z.string().trim().min(1).max(MAX_MCP_BUCKET_ID_CHARS).optional(),
  })
  .strict();

export const DOGGIE_MCP_TOOL_NAMES = [
  LIST_ACTIVE_BUCKETS_TOOL,
  SEARCH_MEMORY_TOOL,
  GET_BUCKET_DETAIL_TOOL,
  PROPOSE_ENTRY_TOOL,
] as const;
export type DoggieMcpToolName = (typeof DOGGIE_MCP_TOOL_NAMES)[number];

export type DoggieToolResult = {
  readonly ok: boolean;
  readonly value: JsonValue;
};

/**
 * MCP-facing memory service.
 *
 * The three retrieval tools are read-only. `propose_entry` writes only a
 * durable `needs_confirmation` attempt: it never creates a Bucket, Entry, or
 * memory item, so an MCP client cannot bypass Doggie's approval UI.
 */
export class DoggieMcpTools {
  readonly #store: Store;
  readonly #memory: MemoryTools;
  readonly #archive: ArchiveService;

  constructor(store: Store, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#memory = new MemoryTools(store.memory, clock);
    this.#archive = new ArchiveService(store);
  }

  listActiveBuckets(): JsonValue {
    return {
      ok: true,
      buckets: this.#memory.listActiveBuckets().map(projectBucket),
    };
  }

  searchMemory(query: string): JsonValue {
    return projectMemoryQuery(this.#memory.searchMemory(query));
  }

  getBucketDetail(bucketId: string): JsonValue {
    return {
      ok: true,
      ...projectBucketDetail(this.#memory.getBucketDetail(bucketId)),
    };
  }

  proposeEntry(text: string, preferredBucketId?: string): JsonValue {
    const rawText = requiredText(text, "text");
    const candidates = this.#candidateBuckets(preferredBucketId);
    const preferred =
      preferredBucketId === undefined
        ? undefined
        : candidates.find(({ id }) => id === preferredBucketId);
    const classification = askUser(
      preferred?.bucketType,
      undefined,
      preferred === undefined ? 0 : 1,
      preferred === undefined
        ? "MCP 客户端提交了一条待归档记录，必须由用户确认目标 Bucket。"
        : "MCP 客户端建议保存到指定 Bucket，必须由用户确认后才能写入。",
      "请在 Doggie UI 中确认保存到哪个 Bucket，或选择不保存。",
      candidates.map(({ id }) => id),
    );
    const result = this.#archive.archiveClassifiedInput(
      rawText,
      classification,
      undefined,
      {
        candidateBucketIds: candidates.map(({ id }) => id),
        focusBucketId: preferred?.id,
        promptVersion: "doggie-mcp-v1",
        proposedBy: "model",
        modelName: "mcp-client",
      },
      (result) => ({
        role: "assistant",
        content: "MCP 客户端提交了一条待归档记录，请在确认卡片中决定是否保存。",
        details: {
          kind: "archive_result",
          source_text: rawText,
          archive: projectProposal(result, candidates),
          pending_confirmation: true,
          proposed_by: "mcp",
        },
      }),
    );
    return projectProposal(result, candidates) as JsonValue;
  }

  #candidateBuckets(preferredBucketId?: string): BucketView[] {
    const rows = [
      ...this.#store.listActiveBuckets(DEFAULT_MCP_RESULT_LIMIT),
      ...this.#store.listPopularActiveBuckets(DEFAULT_MCP_RESULT_LIMIT),
    ];
    let candidates = buildBucketCandidates(
      rows.map(toBucketView),
      undefined,
      DEFAULT_MCP_RESULT_LIMIT,
    );
    if (preferredBucketId === undefined) return candidates;

    const preferred = this.#store.getBucket(
      requiredText(preferredBucketId, "bucket_id"),
    );
    if (preferred === undefined) {
      throw StorageError.missingRecord("buckets", preferredBucketId);
    }
    if (preferred.lifecycle !== BucketStatus.Active) {
      throw StorageError.inactiveBucket(preferred.id);
    }
    const preferredView = toBucketView(preferred);
    candidates = [
      preferredView,
      ...candidates.filter(({ id }) => id !== preferred.id),
    ];
    return candidates.slice(0, DEFAULT_MCP_RESULT_LIMIT);
  }
}

function projectProposal(
  result: ArchiveResult,
  candidates: readonly BucketView[],
) {
  return {
    ...projectArchive(result, { candidates }),
    available_actions: [
      "append_recommended",
      "append_alternative",
      "create_new",
      "discard",
    ],
    confirmation_options: {
      recommended: "append_recommended",
      alternative: "append_alternative",
      create: "create_new",
      discard: "discard",
    },
    submitted_for_confirmation: true,
  } as const;
}

export function boundedToolResult(value: JsonValue): JsonValue {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes <= MAX_MCP_TOOL_OUTPUT_BYTES) return value;
  return {
    ok: false,
    error: `tool output exceeds ${MAX_MCP_TOOL_OUTPUT_BYTES} bytes`,
  };
}
