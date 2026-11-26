import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  awaitingSchema,
  entryReference,
  clarificationReferenceSchema,
  subjectReferenceSchema,
  type SubjectReference,
  type Awaiting,
  type PromptReference,
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
import {
  ConversationStore,
  type ChatMessageInput,
  type GroundedFence,
} from "./conversation.ts";
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
  awaiting: awaitingSchema.nullable(),
  promptMessageId: z.uuid().nullable(),
  question: z.string().nullable(),
  selectedEntryId: z.uuid().nullable(),
  selectedMemoryRevision: z.number().int().nonnegative().nullable(),
  selectedMessageId: z.uuid().nullable(),
  selectedId: z.uuid().nullable(),
  selectedScopeRevision: z.number().int().positive().nullable(),
});
const select = `SELECT c.id,c.original_message_id AS originalMessageId,c.assistant_message_id AS assistantMessageId,
 o.content AS originalText,r.content AS latestReply,c.latest_reply_id AS latestReplyId,
 c.status,c.revision,c.candidates_json AS candidates,c.truncated,c.awaiting,
 c.prompt_message_id AS promptMessageId,p.content AS question,
 c.selected_entry_id AS selectedEntryId,c.selected_memory_revision AS selectedMemoryRevision,
 c.selected_message_id AS selectedMessageId,
 c.selected_id AS selectedId,c.selected_scope_revision AS selectedScopeRevision
 FROM conversation_clarifications c JOIN conversation_messages o ON o.id=c.original_message_id
 LEFT JOIN conversation_messages r ON r.id=c.latest_reply_id
 LEFT JOIN conversation_messages p ON p.id=c.prompt_message_id`;
function parseCard(raw: unknown) {
  const row = cardRowSchema.parse(raw);
  const subjects = z
    .array(subjectReferenceSchema)
    .max(MAX_CLARIFICATION_CANDIDATES)
    .parse(JSON.parse(row.candidates));
  return {
    ...row,
    subjects,
    entry:
      row.selectedEntryId === null
        ? null
        : entryReference.parse({
            kind: "entry",
            id: row.selectedEntryId,
            memoryRevision: row.selectedMemoryRevision,
          }),
    selectedMessageId: row.selectedMessageId,
    candidates: subjects.flatMap((part) =>
      part.kind === "work_item"
        ? [{ id: part.id, scopeRevision: part.scopeRevision }]
        : [],
    ),
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
  transaction<T>(
    run: () => T &
      (Extract<T, PromiseLike<unknown>> extends never ? unknown : never),
  ): T {
    return withTransaction<T>(this.#db, run);
  }
  readSnapshot<T>(read: () => T): T {
    this.#db.exec("BEGIN DEFERRED");
    try {
      const result = read();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  memoryRevision(): number {
    return this.#conversation.getMemoryContextRevision();
  }
  contextCurrent(fence: GroundedFence): boolean {
    return this.#conversation.groundedResultCurrent(
      fence.memoryRevision,
      fence.card,
      fence.work,
      fence.entry,
    );
  }
  supplements(card: StoredClarification, limit: number) {
    return this.supplementMessages(card, limit).map(({ text }) => text);
  }
  supplementMessages(card: StoredClarification, limit: number) {
    return this.#db
      .prepare(
        `SELECT id,content AS text FROM conversation_messages
      WHERE role='user' AND json_extract(details_json,'$.kind')='task_clarification_reply'
        AND json_extract(details_json,'$.action')='reply'
        AND json_extract(details_json,'$.clarification_id')=?
        AND json_extract(details_json,'$.reply_to_message_id')=?
      ORDER BY sequence LIMIT ?`,
      )
      .all(card.id, card.originalMessageId, limit)
      .map((row) =>
        z.strictObject({ id: z.uuid(), text: z.string() }).parse(row),
      );
  }
  materialMessage(card: StoredClarification) {
    if (card.selectedMessageId === null) return undefined;
    const row = this.#db
      .prepare(
        `SELECT id,content AS text FROM conversation_messages
         WHERE id=? AND role='user' AND json_extract(details_json,'$.kind')='task_clarification_reply'
           AND json_extract(details_json,'$.clarification_id')=?`,
      )
      .get(card.selectedMessageId, card.id);
    return row === undefined
      ? undefined
      : z.strictObject({ id: z.uuid(), text: z.string() }).parse(row);
  }
  latestContextResult(card: StoredClarification) {
    const row = this.#db
      .prepare(
        `SELECT id,content AS text,sequence,
           json_extract(details_json,'$.retryable') AS retryable,
           json_extract(details_json,'$.failed') AS failed
         FROM conversation_messages
         WHERE role='assistant'
           AND json_extract(details_json,'$.kind')='conversation_context_result'
           AND json_extract(details_json,'$.clarification_id')=?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(card.id);
    if (row === undefined) return undefined;
    const parsed = z
      .strictObject({
        id: z.uuid(),
        text: z.string(),
        sequence: z.number().int().positive(),
        retryable: z.union([z.literal(0), z.literal(1), z.null()]),
        failed: z.union([z.literal(0), z.literal(1), z.null()]),
      })
      .parse(row);
    if (parsed.failed === null)
      return {
        id: parsed.id,
        text: parsed.text,
        failed: null,
        retryable: false,
        consumed: false,
        inProgress: false,
        retryRequestId: undefined,
      };
    if (parsed.failed !== 1)
      return {
        id: parsed.id,
        text: parsed.text,
        failed: false as const,
        retryable: false,
        consumed: false,
        inProgress: false,
        retryRequestId: undefined,
      };
    const consumed = this.#db
      .prepare(
        `SELECT json_extract(details_json,'$.retry_request_id') AS retryRequestId
         FROM conversation_messages
         WHERE role='user' AND json_extract(details_json,'$.kind')='task_clarification_reply'
           AND json_extract(details_json,'$.action')='retry'
           AND json_extract(details_json,'$.retry_result_message_id')=?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(parsed.id);
    const consumedRequestId =
      consumed === undefined
        ? undefined
        : (z
            .strictObject({ retryRequestId: z.uuid().nullable() })
            .parse(consumed).retryRequestId ?? undefined);
    const retryRequest =
      consumedRequestId === undefined
        ? undefined
        : this.#db
            .prepare(
              "SELECT result_json AS resultJson FROM conversation_requests WHERE request_id=?",
            )
            .get(consumedRequestId);
    const inProgress =
      retryRequest === undefined
        ? false
        : z
            .strictObject({ resultJson: z.string().nullable() })
            .parse(retryRequest).resultJson === null;
    return {
      id: parsed.id,
      text: parsed.text,
      failed: true as const,
      retryable: parsed.retryable === 1 && consumed === undefined,
      consumed: consumed !== undefined,
      inProgress,
      ...(inProgress && consumedRequestId !== undefined
        ? { retryRequestId: consumedRequestId }
        : {}),
    };
  }
  #requireTransaction() {
    if (!this.#db.isTransaction)
      throw new Error("clarification transaction required");
  }
  #hash(input: ConversationTurn): string {
    // The parsed schema fixes key order; trimming is part of the request contract.
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }
  replay(input: ConversationTurn): ConversationReceipt | null {
    const row = this.#db
      .prepare(
        "SELECT payload_hash,result_json FROM conversation_requests WHERE request_id=?",
      )
      .get(input.requestId);
    if (row === undefined) return null;
    if (row["payload_hash"] !== this.#hash(input))
      throw new ConversationError("conflict");
    if (typeof row["result_json"] !== "string")
      throw new ConversationError("in_progress");
    return conversationReceiptSchema.parse(JSON.parse(row["result_json"]));
  }
  begin(input: ConversationTurn): ConversationReceipt | null {
    this.#requireTransaction();
    const replay = this.replay(input);
    if (replay !== null) return replay;
    this.#db
      .prepare(
        "INSERT INTO conversation_requests(request_id,payload_hash) VALUES (?,?)",
      )
      .run(input.requestId, this.#hash(input));
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
          " ORDER BY CASE WHEN c.awaiting IS NOT NULL OR c.status='pending' THEN 0 ELSE 1 END,o.sequence DESC LIMIT ?",
      )
      .all(MAX_CLARIFICATION_CARDS * 2)
      .map(parseCard);
  }
  throughSequence(): number {
    return z
      .number()
      .int()
      .nonnegative()
      .parse(
        this.#db
          .prepare(
            "SELECT COALESCE(MAX(sequence),0) AS n FROM conversation_messages",
          )
          .get()?.["n"],
      );
  }
  validateObserved(ref: PromptReference, throughSequence: number): void {
    const row = this.#db
      .prepare(
        `SELECT 1 FROM conversation_messages WHERE id=? AND sequence<=? AND role='assistant'
       AND (json_extract(details_json,'$.clarification_id')=? OR EXISTS (
         SELECT 1 FROM conversation_clarifications WHERE id=? AND assistant_message_id=?
       ))`,
      )
      .get(
        ref.promptMessageId,
        throughSequence,
        ref.interactionId,
        ref.interactionId,
        ref.promptMessageId,
      );
    if (row === undefined) throw new ConversationError("stale");
  }
  #checkCapacity(): void {
    const count = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_clarifications WHERE awaiting IS NOT NULL OR status='pending'",
      )
      .get()?.["n"];
    if (typeof count === "number" && count >= MAX_CLARIFICATION_CARDS)
      throw new ConversationError("capacity");
  }
  create(
    originalMessageId: string,
    assistantMessageId: string,
    candidates: readonly ClarificationReference[],
    truncated: boolean,
    selected: ClarificationReference | null,
    awaiting: Awaiting | null = null,
    subjects: readonly SubjectReference[] = candidates.map((part) => ({
      ...part,
      kind: "work_item",
    })),
    entry?: Extract<SubjectReference, { kind: "entry" }>,
  ) {
    this.#requireTransaction();
    const id = randomUUID();
    if ((selected === null && entry === undefined) || awaiting !== null)
      this.#checkCapacity();
    this.#db
      .prepare(
        `INSERT INTO conversation_clarifications(id,original_message_id,assistant_message_id,status,revision,candidates_json,truncated,selected_id,selected_scope_revision,awaiting,prompt_message_id,selected_entry_id,selected_memory_revision,selected_message_id)
       VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        originalMessageId,
        assistantMessageId,
        selected === null && entry === undefined ? "pending" : "resolved",
        JSON.stringify(subjects),
        Number(truncated),
        selected?.id ?? null,
        selected?.scopeRevision ?? null,
        awaiting,
        awaiting === null ? null : assistantMessageId,
        entry?.id ?? null,
        entry?.memoryRevision ?? null,
        null,
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
      awaiting?: Awaiting | null;
      subjects?: readonly SubjectReference[];
      entry?: Extract<SubjectReference, { kind: "entry" }> | null;
      materialMessageId?: string | null;
      promptMessageId?: string | null;
    },
  ) {
    this.#requireTransaction();
    if (
      change.awaiting != null &&
      card.awaiting === null &&
      card.status !== "pending"
    )
      this.#checkCapacity();
    const changed = this.#db
      .prepare(
        `UPDATE conversation_clarifications SET status=?,revision=revision+1,candidates_json=?,truncated=?,
       selected_id=?,selected_scope_revision=?,latest_reply_id=?,awaiting=?,prompt_message_id=?,selected_entry_id=?,selected_memory_revision=?,selected_message_id=? WHERE id=? AND revision=?`,
      )
      .run(
        change.status,
        JSON.stringify(
          change.subjects ??
            change.candidates.map((part) => ({ ...part, kind: "work_item" })),
        ),
        Number(change.truncated),
        change.selected?.id ?? null,
        change.selected?.scopeRevision ?? null,
        change.latestReplyId,
        change.awaiting ?? null,
        change.promptMessageId === undefined
          ? card.promptMessageId
          : change.promptMessageId,
        change.entry?.id ?? null,
        change.entry?.memoryRevision ?? null,
        change.materialMessageId ?? null,
        card.id,
        card.revision,
      );
    if (changed.changes !== 1) throw new ConversationError("stale");
  }
  append(message: ChatMessageInput) {
    return this.#conversation.appendChatMessageWithinTransaction(message);
  }
}
