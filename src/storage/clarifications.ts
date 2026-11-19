import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  clarificationReferenceSchema,
  clarificationStatusSchema,
  conversationReceiptSchema,
  ConversationError,
  MAX_CLARIFICATION_CANDIDATES,
  MAX_CLARIFICATION_CARDS,
  type ClarificationReference,
  type ClarificationStatus,
  type ConversationReceipt,
  type ConversationTurn,
} from "../domain/main-conversation.ts";
import { ConversationStore, type ChatMessageInput } from "./conversation.ts";
import { withTransaction } from "./database.ts";

const cardRowSchema = z.strictObject({
  id: z.uuid(),
  originalMessageId: z.uuid(),
  assistantMessageId: z.uuid(),
  originalText: z.string(),
  latestReply: z.string().nullable(),
  latestReplyId: z.uuid().nullable(),
  status: clarificationStatusSchema,
  revision: z.number().int().positive(),
  candidates: z.string(),
  truncated: z.union([z.literal(0), z.literal(1)]),
  selectedId: z.uuid().nullable(),
  selectedScopeRevision: z.number().int().positive().nullable(),
});
const select = `SELECT c.id,c.original_message_id AS originalMessageId,c.assistant_message_id AS assistantMessageId,
 o.content AS originalText,r.content AS latestReply,c.latest_reply_id AS latestReplyId,
 c.status,c.revision,c.candidates_json AS candidates,c.truncated,
 c.selected_id AS selectedId,c.selected_scope_revision AS selectedScopeRevision
 FROM conversation_clarifications c JOIN conversation_messages o ON o.id=c.original_message_id
 LEFT JOIN conversation_messages r ON r.id=c.latest_reply_id`;
function parseCard(raw: unknown) {
  const row = cardRowSchema.parse(raw);
  return {
    ...row,
    candidates: z
      .array(clarificationReferenceSchema)
      .max(MAX_CLARIFICATION_CANDIDATES)
      .parse(JSON.parse(row.candidates)),
    truncated: row.truncated === 1,
    selected:
      row.selectedId === null
        ? null
        : clarificationReferenceSchema.parse({
            id: row.selectedId,
            scopeRevision: row.selectedScopeRevision,
          }),
  };
}
export type StoredClarification = ReturnType<typeof parseCard>;

export class ClarificationStore {
  readonly #db: DatabaseSync;
  readonly #conversation: ConversationStore;
  constructor(db: DatabaseSync, conversation: ConversationStore) {
    this.#db = db;
    this.#conversation = conversation;
  }
  transaction(
    run: () => ConversationReceipt | null,
  ): ConversationReceipt | null {
    return withTransaction(this.#db, run);
  }
  #requireTransaction() {
    if (!this.#db.isTransaction)
      throw new Error("clarification transaction required");
  }
  begin(input: ConversationTurn): ConversationReceipt | null {
    this.#requireTransaction();
    // The parsed schema fixes key order; whitespace trimming is part of the request contract.
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const row = this.#db
      .prepare(
        "SELECT payload_hash,result_json FROM conversation_requests WHERE request_id=?",
      )
      .get(input.requestId);
    if (row !== undefined) {
      if (row["payload_hash"] !== hash) throw new ConversationError("conflict");
      if (typeof row["result_json"] !== "string")
        throw new ConversationError("in_progress");
      return conversationReceiptSchema.parse(JSON.parse(row["result_json"]));
    }
    this.#db
      .prepare(
        "INSERT INTO conversation_requests(request_id,payload_hash) VALUES (?,?)",
      )
      .run(input.requestId, hash);
    return null;
  }
  finish(requestId: string, result: ConversationReceipt) {
    this.#requireTransaction();
    const update = this.#db
      .prepare(
        "UPDATE conversation_requests SET result_json=? WHERE request_id=? AND result_json IS NULL",
      )
      .run(JSON.stringify(conversationReceiptSchema.parse(result)), requestId);
    if (update.changes !== 1) throw new ConversationError("conflict");
  }
  get(id: string): StoredClarification {
    const row = this.#db.prepare(select + " WHERE c.id=?").get(id);
    if (row === undefined) throw new ConversationError("missing");
    return parseCard(row);
  }
  list(): readonly StoredClarification[] {
    return this.#db
      .prepare(
        select +
          " ORDER BY CASE WHEN c.status='pending' THEN 0 ELSE 1 END,o.sequence DESC LIMIT ?",
      )
      .all(MAX_CLARIFICATION_CARDS * 2)
      .map(parseCard);
  }
  create(
    originalMessageId: string,
    assistantMessageId: string,
    candidates: readonly ClarificationReference[],
    truncated: boolean,
    selected: ClarificationReference | null,
  ) {
    this.#requireTransaction();
    const id = randomUUID();
    const count = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_clarifications WHERE status='pending'",
      )
      .get()?.["n"];
    if (
      selected === null &&
      typeof count === "number" &&
      count >= MAX_CLARIFICATION_CARDS
    )
      throw new ConversationError("capacity");
    this.#db
      .prepare(
        `INSERT INTO conversation_clarifications(id,original_message_id,assistant_message_id,status,revision,candidates_json,truncated,selected_id,selected_scope_revision)
       VALUES (?,?,?,?,1,?,?,?,?)`,
      )
      .run(
        id,
        originalMessageId,
        assistantMessageId,
        selected === null ? "pending" : "resolved",
        JSON.stringify(candidates),
        Number(truncated),
        selected?.id ?? null,
        selected?.scopeRevision ?? null,
      );
    return id;
  }
  update(
    card: StoredClarification,
    change: {
      status: ClarificationStatus;
      candidates: readonly ClarificationReference[];
      truncated: boolean;
      selected: ClarificationReference | null;
      latestReplyId: string | null;
    },
  ) {
    this.#requireTransaction();
    const changed = this.#db
      .prepare(
        `UPDATE conversation_clarifications SET status=?,revision=revision+1,candidates_json=?,truncated=?,
       selected_id=?,selected_scope_revision=?,latest_reply_id=? WHERE id=? AND revision=?`,
      )
      .run(
        change.status,
        JSON.stringify(change.candidates),
        Number(change.truncated),
        change.selected?.id ?? null,
        change.selected?.scopeRevision ?? null,
        change.latestReplyId,
        card.id,
        card.revision,
      );
    if (changed.changes !== 1) throw new ConversationError("stale");
  }
  append(message: ChatMessageInput) {
    return this.#conversation.appendChatMessageWithinTransaction(message);
  }
}
