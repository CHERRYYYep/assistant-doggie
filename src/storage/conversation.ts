import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const groundedCitation = z.strictObject({
  entryId: z.string(),
  bucketId: z.string(),
});
const groundedFence = z.strictObject({
  memoryRevision: z.number().int().nonnegative(),
  card: z
    .strictObject({ id: z.uuid(), revision: z.number().int().positive() })
    .nullable(),
  work: z
    .strictObject({
      id: z.uuid(),
      scopeRevision: z.number().int().positive(),
      status: z.string().optional(),
    })
    .nullable(),
});
export type GroundedFence = z.infer<typeof groundedFence>;
export const STALE_CONTEXT_MESSAGE = "目标或记忆已更新，这轮结果不再适用。";

import {
  StorageError,
  formatTimestamp,
  newId,
  optionalField,
  requiredField,
  systemClock,
  withTransaction,
  type Clock,
} from "./database.ts";

export type ChatMessageInput = {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolName?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly details?: unknown;
};

export type ChatMessageRow = {
  readonly id: string;
  readonly sequence: number;
  readonly role: string;
  readonly content: string;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly details: unknown;
  readonly createdAt: string;
};

export class ConversationStore {
  readonly #database: DatabaseSync;
  readonly #clock: Clock;

  constructor(database: DatabaseSync, clock: Clock = systemClock) {
    this.#database = database;
    this.#clock = clock;
  }

  /** Equality token for rejecting model results produced before a revocation. */
  getMemoryContextRevision(): number {
    return this.#memoryContextMaximum("context_revision");
  }

  #memoryContextMaximum(
    field: "context_revision" | "history_sequence",
  ): number {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(MAX(CASE WHEN json_valid(after_json)
           THEN CASE WHEN json_type(after_json, '$.${field}') = 'integer'
             THEN json_extract(after_json, '$.${field}') ELSE 0 END
           ELSE 0 END), 0) AS maximum
         FROM corrections WHERE action IN ('delete_entry', 'delete_bucket')`,
      )
      .get();
    const maximum = row?.["maximum"];
    if (
      typeof maximum !== "number" ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0
    ) {
      throw StorageError.invalidWrite(
        "memory_context",
        "has invalid stored revision",
      );
    }
    return maximum;
  }

  /** Append one chat message. `sequence` is assigned inside the transaction. */
  appendChatMessage(message: ChatMessageInput): ChatMessageRow {
    return withTransaction(this.#database, () => this.#append(message));
  }

  /** Attach replies to the accepted user row and publish them as one group. */
  appendChatTurnResults(
    sourceMessageId: string,
    build: () => readonly (Omit<ChatMessageInput, "role" | "details"> & {
      readonly role: "assistant" | "tool";
      readonly details: Readonly<Record<string, unknown>>;
    })[],
    publish?: (replies: readonly ChatMessageRow[]) => void,
  ): ChatMessageRow[] {
    return withTransaction(this.#database, () => {
      const source = this.#database
        .prepare(
          "SELECT 1 FROM conversation_messages WHERE id = ? AND role = 'user'",
        )
        .get(sourceMessageId);
      if (source === undefined)
        throw StorageError.missingRecord(
          "conversation_messages",
          sourceMessageId,
        );
      const replies = build().map((message) =>
        this.#append({
          ...message,
          details: { ...message.details, source_message_id: sourceMessageId },
        }),
      );
      publish?.(replies);
      return replies;
    });
  }

  /** Caller owns the transaction that also persists its goal/approval links. */
  appendChatMessageWithinTransaction(
    message: ChatMessageInput,
  ): ChatMessageRow {
    if (!this.#database.isTransaction)
      throw StorageError.invalidWrite("chat message", "requires a transaction");
    return this.#append(message);
  }

  #append(message: ChatMessageInput): ChatMessageRow {
    const content = requiredField(message.content, "content");
    const row = this.#database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS max FROM conversation_messages",
      )
      .get() as { max: number };
    const id = newId();
    const createdAt = formatTimestamp(this.#clock());
    const toolName = optionalField(message.toolName);
    const toolCallId = optionalField(message.toolCallId);
    this.#database
      .prepare(
        `INSERT INTO conversation_messages
           (id, sequence, role, content, tool_name, tool_call_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.max + 1,
        message.role,
        content,
        toolName,
        toolCallId,
        message.details === undefined ? null : JSON.stringify(message.details),
        createdAt,
      );
    return {
      id,
      sequence: row.max + 1,
      role: message.role,
      content,
      toolName,
      toolCallId,
      details: message.details,
      createdAt,
    };
  }

  /** Older history remains visible, but cannot silently restore revoked facts. */
  listModelChatMessages(
    limit: number,
    throughSequence?: number,
  ): ChatMessageRow[] {
    const fence = this.#memoryContextMaximum("history_sequence");
    const rows = this.#database
      .prepare(
        `SELECT id, sequence, role, content, tool_name, tool_call_id, created_at
         FROM conversation_messages
         WHERE sequence > ? AND sequence <= ?
           AND role IN ('user', 'assistant')
           AND json_type(details_json, '$.work_item_id') IS NULL
           AND COALESCE(json_extract(details_json, '$.kind') NOT IN ('task_clarification_input','task_clarification_result','task_clarification_reply','conversation_context_result','conversation_context_input'), 1)
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(fence, throughSequence ?? Number.MAX_SAFE_INTEGER, limit);
    return rows.reverse().map((row) => {
      const {
        id,
        sequence,
        role,
        content,
        tool_name,
        tool_call_id,
        created_at,
      } = row;
      if (
        typeof id !== "string" ||
        typeof sequence !== "number" ||
        typeof role !== "string" ||
        typeof content !== "string" ||
        (tool_name !== null && typeof tool_name !== "string") ||
        (tool_call_id !== null && typeof tool_call_id !== "string") ||
        typeof created_at !== "string"
      ) {
        throw StorageError.invalidWrite(
          "chat message",
          "has invalid stored fields",
        );
      }
      return {
        id,
        sequence,
        role,
        content,
        toolName: tool_name,
        toolCallId: tool_call_id,
        details: undefined,
        createdAt: created_at,
      };
    });
  }

  groundedResultCurrent(
    memoryRevision: number,
    card: { readonly id: string; readonly revision: number } | null,
    work: {
      readonly id: string;
      readonly scopeRevision: number;
      readonly status?: string | undefined;
    } | null,
  ): boolean {
    if (this.getMemoryContextRevision() !== memoryRevision) return false;
    if (
      card !== null &&
      this.#database
        .prepare(
          "SELECT 1 FROM conversation_clarifications WHERE id=? AND revision=? AND status='resolved' AND selected_id=? AND selected_scope_revision=?",
        )
        .get(
          card.id,
          card.revision,
          work?.id ?? null,
          work?.scopeRevision ?? null,
        ) === undefined
    )
      return false;
    return (
      work === null ||
      this.#database
        .prepare(
          "SELECT 1 FROM work_items WHERE id=? AND scope_revision=? AND cancel_requested=0 AND (? IS NULL OR status=?) AND (? = 0 OR status IN ('open','blocked','in_progress'))",
        )
        .get(
          work.id,
          work.scopeRevision,
          work.status ?? null,
          work.status ?? null,
          card === null ? 0 : 1,
        ) !== undefined
    );
  }
  /** Most recent `limit` messages, returned oldest-first for rendering. */
  listChatMessages(limit: number): ChatMessageRow[] {
    const rows = this.#database
      .prepare(
        `SELECT id, sequence, role, content, tool_name, tool_call_id, details_json, created_at
         FROM conversation_messages ORDER BY sequence DESC LIMIT ?`,
      )
      .all(limit) as {
      id: string;
      sequence: number;
      role: string;
      content: string;
      tool_name: string | null;
      tool_call_id: string | null;
      details_json: string | null;
      created_at: string;
    }[];
    return rows.reverse().map((row) => {
      const details: unknown =
        row.details_json === null ? undefined : JSON.parse(row.details_json);
      let content = row.content;
      let projectedDetails = details;
      if (
        details !== null &&
        typeof details === "object" &&
        Reflect.get(details, "kind") === "conversation_context_result"
      ) {
        const fence = groundedFence.safeParse(Reflect.get(details, "fence"));
        if (
          !fence.success ||
          !this.groundedResultCurrent(
            fence.data.memoryRevision,
            fence.data.card,
            fence.data.work,
          )
        ) {
          content = STALE_CONTEXT_MESSAGE;
          projectedDetails = { kind: "conversation_context_expired" };
        } else {
          const citations = z
            .array(groundedCitation)
            .max(6)
            .safeParse(Reflect.get(details, "citations"));
          if (citations.success && citations.data.length > 0) {
            // A move changes only where to open the Entry, not the quoted text.
            const locations = this.#database.prepare(
              "SELECT bucket_id FROM entries WHERE id=? AND revoked_at IS NULL",
            );
            const refreshed = citations.data.flatMap(({ entryId }) => {
              const bucketId = locations.get(entryId)?.["bucket_id"];
              return typeof bucketId === "string"
                ? [{ entryId, bucketId }]
                : [];
            });
            if (refreshed.length !== citations.data.length) {
              content = STALE_CONTEXT_MESSAGE;
              projectedDetails = { kind: "conversation_context_expired" };
            } else {
              projectedDetails = { ...details, citations: refreshed };
            }
          }
        }
      }
      return {
        id: row.id,
        sequence: row.sequence,
        role: row.role,
        content,
        toolName: row.tool_name,
        toolCallId: row.tool_call_id,
        details: projectedDetails,
        createdAt: row.created_at,
      };
    });
  }
}
