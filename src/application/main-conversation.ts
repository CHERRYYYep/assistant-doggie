import {
  clarificationCardSchema,
  conversationTurnSchema,
  ConversationError,
  MAX_CLARIFICATION_CANDIDATES,
  normalized,
  explicitTitle,
  distinguishingFragment,
  isWorkItemId,
  replyTarget,
  topicTerms,
  type ClarificationCard,
  type ClarificationReference,
  type ConversationReceipt,
  type ConversationTurn,
} from "../domain/main-conversation.ts";
import { decideChatPurpose } from "../domain/chat-purpose.ts";
import {
  resolveWorkItem,
  WorkItemError,
  type WorkItem,
} from "../domain/work-item.ts";
import { throwIfAborted } from "../llm/cancellation.ts";
import type {
  ClarificationStore,
  StoredClarification,
} from "../storage/clarifications.ts";
import type { WorkItemStore } from "../storage/work-items.ts";
import type { ChatService } from "./chat.ts";

type Mutation = Exclude<ConversationTurn, { action: "message" }>;
const ref = (item: WorkItem): ClarificationReference => ({
  id: item.id,
  scopeRevision: item.scopeRevision,
});
const choice = (item: WorkItem) => ({
  ...ref(item),
  title: item.title,
  hint: item.acceptance.slice(0, 240),
});
const ask = (count: number) =>
  count > 0
    ? "你指的是哪个工作目标？请选择、回复目标名称，或选「都不是」。"
    : "请补充实验或任务的完整名称，或贴出要处理的材料。";
const selectedText = (title: string) =>
  `已关联「${title}」。你可以在这张卡里补充原请求的要求。`;

export class MainConversationService {
  readonly #cards: ClarificationStore;
  readonly #items: WorkItemStore;
  readonly #chat: ChatService;
  constructor(
    cards: ClarificationStore,
    items: WorkItemStore,
    chat: ChatService,
  ) {
    this.#cards = cards;
    this.#items = items;
    this.#chat = chat;
  }
  list(): readonly ClarificationCard[] {
    return this.#cards.list().map((card) => this.#project(card));
  }
  turn(raw: unknown, signal?: AbortSignal): Promise<ConversationReceipt> {
    const input = conversationTurnSchema.parse(raw);
    return this.#chat.coordinateMain(async (dispatch) => {
      throwIfAborted(signal);
      const entered = this.#cards.transaction(() => {
        const replay = this.#cards.begin(input);
        if (replay !== null) return replay;
        if (input.action !== "message") return this.#change(input);
        const purpose = decideChatPurpose(input.text);
        if (
          purpose.kind === "propose_execution" ||
          (purpose.kind === "clarify" && purpose.reason === "target")
        )
          return this.#open(input);
        return null;
      });
      if (entered !== null) return entered;
      let result: ConversationReceipt | undefined;
      await dispatch(
        input.action === "message" ? input.text : "",
        (kind, user, assistant, chatError) => {
          result = {
            kind,
            userMessageId: user.id,
            assistantMessageId: assistant.id,
            chatError,
          };
          this.#cards.finish(input.requestId, result);
        },
      );
      if (result === undefined) throw new Error("missing published turn");
      return result;
    }, signal);
  }

  #live(reference: ClarificationReference): WorkItem | undefined {
    try {
      const item = this.#items.get(reference.id);
      return item.scopeRevision === reference.scopeRevision &&
        this.#eligible(item)
        ? item
        : undefined;
    } catch (error) {
      if (error instanceof WorkItemError && error.code === "missing")
        return undefined;
      throw error;
    }
  }
  #eligible(item: WorkItem) {
    return (
      !item.cancelRequested &&
      item.status !== "done" &&
      item.status !== "cancelled" &&
      this.#items.hasAvailableScopeSources(item.id)
    );
  }
  #project(card: StoredClarification): ClarificationCard {
    const selected =
      card.selected === null ? undefined : this.#live(card.selected);
    const candidates =
      card.status === "pending"
        ? card.candidates.flatMap((ref) => {
            const current = this.#live(ref);
            return current === undefined ? [] : [choice(current)];
          })
        : [];
    const invalid =
      (card.status === "resolved" && selected === undefined) ||
      (card.status === "pending" &&
        candidates.length !== card.candidates.length);
    const status = invalid ? "stale" : card.status;
    const projected = clarificationCardSchema.safeParse({
      id: card.id,
      originalMessageId: card.originalMessageId,
      assistantMessageId: card.assistantMessageId,
      originalText: card.originalText,
      latestReply: card.latestReply,
      status,
      revision: card.revision,
      candidates: status === "pending" ? candidates : [],
      selected:
        status === "resolved" && selected !== undefined
          ? choice(selected)
          : null,
      question:
        status === "stale"
          ? "目标范围或来源已变化；请取消旧卡后重新发起。"
          : status === "cancelled"
            ? "已取消这次澄清。"
            : selected === undefined
              ? ask(candidates.length)
              : selectedText(selected.title),
    });
    if (!projected.success) throw new Error("invalid clarification projection");
    return projected.data;
  }
  #exact(titleOrId: string): WorkItem | undefined {
    if (isWorkItemId(titleOrId)) {
      try {
        const item = this.#items.get(titleOrId);
        if (this.#eligible(item)) return item;
      } catch (error) {
        if (!(error instanceof WorkItemError && error.code === "missing"))
          throw error;
      }
    }
    const resolution = resolveWorkItem(
      { title: titleOrId },
      this.#items.findExactTitle(titleOrId),
    );
    if (resolution.workItemId === null) return undefined;
    const item = this.#items.get(resolution.workItemId);
    return this.#eligible(item) ? item : undefined;
  }
  #matches(text: string) {
    const { items, truncated } = this.#items.clarificationPool();
    const wording = normalized(text);
    const terms = topicTerms(text);
    const ranked = items
      .flatMap((item) => {
        const words = new Set(topicTerms(`${item.title} ${item.goal}`));
        if (words.has("tcp") || words.has("udp")) words.add("netlab");
        const titleMention =
          normalized(item.title).length >= 3 &&
          wording.includes(normalized(item.title));
        const score = titleMention
          ? 100
          : terms.filter((term) => words.has(term)).length;
        return score > 0 && this.#eligible(item) ? [{ item, score }] : [];
      })
      .sort((a, b) => b.score - a.score);
    return {
      candidates: ranked
        .slice(0, MAX_CLARIFICATION_CANDIDATES)
        .map(({ item }) => item),
      truncated: truncated || ranked.length > MAX_CLARIFICATION_CANDIDATES,
    };
  }
  #replySelection(text: string, view: ClarificationCard, truncated: boolean) {
    const target = replyTarget(text);
    if (target === undefined || !target) return undefined;
    const exact = this.#exact(target);
    if (exact !== undefined) return exact;
    const fragment = distinguishingFragment(target);
    if (truncated || view.candidates.length < 2 || fragment === undefined)
      return undefined;
    const pool = this.#items.clarificationPool();
    if (pool.truncated) return undefined;
    const matches = pool.items.filter((item) =>
      normalized(item.title).includes(fragment),
    );
    const match = matches.length === 1 ? matches[0] : undefined;
    return match !== undefined &&
      view.candidates.some(({ id }) => id === match.id)
      ? match
      : undefined;
  }
  #open(
    input: Extract<ConversationTurn, { action: "message" }>,
  ): ConversationReceipt {
    const title = explicitTitle(input.text);
    const selected = title === undefined ? undefined : this.#exact(title);
    const matches =
      selected === undefined
        ? this.#matches(input.text)
        : { candidates: [], truncated: false };
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: { kind: "task_clarification_input" },
    });
    const assistant = this.#cards.append({
      role: "assistant",
      content:
        selected === undefined
          ? ask(matches.candidates.length)
          : "已关联工作目标。",
      details: {
        kind: "task_clarification_result",
        source_message_id: user.id,
      },
    });
    const clarificationId = this.#cards.create(
      user.id,
      assistant.id,
      matches.candidates.map(ref),
      matches.truncated,
      selected === undefined ? null : ref(selected),
    );
    const result = {
      kind: "clarification",
      clarificationId,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    } as const;
    this.#cards.finish(input.requestId, result);
    return result;
  }

  #change(input: Mutation): ConversationReceipt {
    const card = this.#cards.get(input.clarificationId);
    if (card.revision !== input.expectedRevision)
      throw new ConversationError("stale");
    const view = this.#project(card);
    if (
      view.status === "cancelled" ||
      (view.status === "stale" && input.action !== "cancel")
    )
      throw new ConversationError("stale");
    if (
      view.status === "resolved" &&
      input.action !== "reply" &&
      input.action !== "cancel"
    )
      throw new ConversationError("stale");

    let selected: ClarificationReference | null = view.selected;
    let candidates = card.candidates;
    let truncated = card.truncated;
    let content: string;
    let latestReplyId = card.latestReplyId;
    switch (input.action) {
      case "select": {
        const picked = view.candidates.find(
          ({ id }) => id === input.workItemId,
        );
        if (picked === undefined) throw new ConversationError("conflict");
        selected = picked;
        content = "选择工作目标";
        break;
      }
      case "reply": {
        content = input.text;
        if (selected === null) {
          if (/^(?:都不是|不是这个|不选这些)/u.test(input.text)) {
            candidates = [];
            truncated = false;
          } else {
            const matched = this.#replySelection(
              input.text,
              view,
              card.truncated,
            );
            if (matched !== undefined) {
              selected = matched;
            } else {
              const revised = this.#matches(input.text);
              if (revised.candidates.length > 0) {
                candidates = revised.candidates.map(ref);
                truncated = revised.truncated;
              }
            }
          }
        }
        break;
      }
      case "none":
        candidates = [];
        truncated = false;
        content = "这些目标都不是";
        break;
      case "cancel":
        content = "取消这次澄清";
        break;
    }
    const details = {
      clarification_id: card.id,
      reply_to_message_id: card.originalMessageId,
      action: input.action,
    };
    const user = this.#cards.append({
      role: "user",
      content,
      details: {
        kind: "task_clarification_reply",
        ...details,
        ...(selected === null
          ? {}
          : {
              target: {
                id: selected.id,
                scopeRevision: selected.scopeRevision,
              },
            }),
      },
    });
    if (input.action === "reply") latestReplyId = user.id;
    const nextStatus: ClarificationCard["status"] =
      input.action === "cancel"
        ? "cancelled"
        : selected !== null
          ? "resolved"
          : "pending";
    const assistant = this.#cards.append({
      role: "assistant",
      content:
        nextStatus === "cancelled"
          ? "已取消这次澄清。"
          : selected === null
            ? ask(candidates.length)
            : input.action === "reply"
              ? "已把补充关联到原请求。"
              : "已关联工作目标。",
      details: {
        kind: "task_clarification_result",
        source_message_id: user.id,
        ...details,
      },
    });
    const references = candidates.map(({ id, scopeRevision }) => ({
      id,
      scopeRevision,
    }));
    this.#cards.update(card, {
      status: nextStatus,
      candidates: references,
      truncated,
      latestReplyId,
      selected:
        nextStatus === "cancelled" || selected === null
          ? null
          : { id: selected.id, scopeRevision: selected.scopeRevision },
    });
    const result = {
      kind: "clarification",
      clarificationId: card.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    } as const;
    this.#cards.finish(input.requestId, result);
    return result;
  }
}
