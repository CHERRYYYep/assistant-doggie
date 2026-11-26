import { randomUUID } from "node:crypto";
import type { AgentService } from "../agent/service.ts";
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
  type Utterance,
  type Interaction,
  type SubjectReference,
  type SubjectCandidate,
  type Awaiting,
  type PromptReference,
} from "../domain/main-conversation.ts";
import { AgentError, HarnessError } from "../domain/agent.ts";
import { LlmError } from "../llm/structured-output.ts";
import {
  chatMaterialText,
  decideChatPurpose,
  hasExplicitMaterialMarker,
} from "../domain/chat-purpose.ts";
import {
  resolveWorkItem,
  WorkItemError,
  workItemAttemptSchema,
  workItemInstruction,
  type WorkItem,
} from "../domain/work-item.ts";
import { throwIfAborted } from "../llm/cancellation.ts";
import type {
  ClarificationStore,
  StoredClarification,
} from "../storage/clarifications.ts";
import {
  MAX_LISTED_WORK_ITEMS,
  type WorkItemStore,
} from "../storage/work-items.ts";
import {
  STALE_CONTEXT_MESSAGE,
  type GroundedFence,
} from "../storage/conversation.ts";
import {
  type ConversationContext,
  type ConversationContextService,
  type GroundedResult,
  explicitGoalReview,
  MAX_SUPPLEMENTS,
} from "./conversation-context.ts";
import type { ChatService } from "./chat.ts";
import {
  entryCandidate,
  locateEntries,
  subjectRef,
} from "./conversation-subjects.ts";
import {
  hasRequirements,
  materialText,
  candidateSelection,
  resolveNaturalReply,
} from "../domain/natural-reply.ts";

type Mutation = Exclude<
  ConversationTurn,
  {
    action: "message" | "continue" | "delegate" | "utterance" | "retry_context";
  }
>;
type Continue = Extract<ConversationTurn, { action: "continue" }>;
type Delegate = Extract<ConversationTurn, { action: "delegate" }>;
type Lookup = Extract<ConversationTurn, { action: "message" }>;
type GroundedTurn = Continue | Lookup | Utterance;
type NaturalAdmission = GroundedAdmission;
type GroundedAdmission = {
  readonly userMessageId: string;
  readonly fence: GroundedFence;
  readonly context: ConversationContext;
  readonly entryIds: readonly string[];
  readonly allowTitleSearch: boolean;
  readonly immediate?: GroundedResult;
};
type LocatedTarget = {
  readonly exact: SubjectCandidate | undefined;
  readonly candidates: readonly SubjectCandidate[];
  readonly truncated: boolean;
};
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
  readonly #grounding: ConversationContextService | undefined;
  readonly #agent:
    | Pick<
        AgentService,
        | "verifyWorkItemWorkspace"
        | "proposeForConversationWithinTransaction"
        | "conversationExecution"
        | "rejectPendingForConversationWithinTransaction"
      >
    | undefined;
  constructor(
    cards: ClarificationStore,
    items: WorkItemStore,
    chat: ChatService,
    grounding?: ConversationContextService,
    agent?: Pick<
      AgentService,
      | "verifyWorkItemWorkspace"
      | "proposeForConversationWithinTransaction"
      | "conversationExecution"
      | "rejectPendingForConversationWithinTransaction"
    >,
  ) {
    this.#cards = cards;
    this.#items = items;
    this.#chat = chat;
    this.#grounding = grounding;
    this.#agent = agent;
  }
  list(): readonly ClarificationCard[] {
    return this.#cards
      .list()
      .filter(
        (card) =>
          card.entry === null &&
          !card.subjects.some((subject) => subject.kind === "entry"),
      )
      .map((card) => this.#project(card));
  }
  interactions() {
    return this.#cards.readSnapshot(() => {
      const throughSequence = this.#cards.throughSequence();
      const interactions = this.#cards
        .list()
        .map((card) => this.#interaction(card));
      const prompts = interactions.flatMap(
        ({ id, revision, awaiting, promptMessageId }) =>
          promptMessageId === null || awaiting === null
            ? []
            : [{ interactionId: id, revision, promptMessageId }],
      );
      return { interactions, snapshot: { throughSequence, prompts } };
    });
  }
  turn(raw: unknown, signal?: AbortSignal): Promise<ConversationReceipt> {
    const input = conversationTurnSchema.parse(raw);
    return this.#chat.coordinateMain(async (dispatch) => {
      throwIfAborted(signal);
      if (input.action === "utterance")
        return this.#utterance(input, dispatch, signal);
      if (input.action === "retry_context")
        return this.#retryContext(input, signal);
      if (input.action === "delegate") return this.#delegate(input, signal);
      if (
        input.action === "continue" ||
        (input.action === "message" &&
          this.#grounding !== undefined &&
          decideChatPurpose(input.text).kind === "lookup")
      )
        return this.#grounded(input, signal);
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

  #subject(reference: SubjectReference): SubjectCandidate | undefined {
    if (reference.kind === "work_item") {
      const item = this.#live(reference, true);
      return item === undefined
        ? undefined
        : { kind: "work_item", ...choice(item) };
    }
    const entry = this.#grounding?.entry(reference.id);
    return entry === undefined
      ? undefined
      : entryCandidate(entry, reference.memoryRevision);
  }
  #interaction(card: StoredClarification): Interaction {
    const ref =
      card.entry ??
      (card.selected === null
        ? null
        : { ...card.selected, kind: "work_item" as const });
    const selected = ref === null ? null : (this.#subject(ref) ?? null);
    const materialMessage =
      card.selectedMessageId === null
        ? undefined
        : this.#cards.materialMessage(card);
    const selectedMaterialText =
      materialMessage === undefined
        ? undefined
        : materialText(materialMessage.text);
    const rejectedCurrentCandidates =
      card.awaiting === "subject" &&
      /^都不是[。！!]?$/u.test(normalized(card.latestReply ?? ""));
    const candidates =
      card.status === "pending" && !rejectedCurrentCandidates
        ? card.subjects.flatMap((ref) => this.#subject(ref) ?? [])
        : [];
    const stale =
      (card.status === "resolved" &&
        selected === null &&
        selectedMaterialText === undefined) ||
      (card.status === "pending" &&
        !rejectedCurrentCandidates &&
        candidates.length !== card.subjects.length);
    const execution = this.#agent?.conversationExecution(card.id);
    const latestContextResult = this.#cards.latestContextResult(card);
    const contextResult =
      !stale && card.status === "resolved" && card.awaiting === null
        ? latestContextResult
        : undefined;
    return {
      id: card.id,
      originalMessageId: card.originalMessageId,
      assistantMessageId: card.assistantMessageId,
      originalText: card.originalText,
      latestReply: card.latestReply,
      revision: card.revision,
      status: stale ? "stale" : card.status,
      candidates: stale ? [] : candidates,
      selected: stale ? null : selected,
      awaiting: stale ? null : card.awaiting,
      promptMessageId: card.promptMessageId,
      ...(contextResult?.retryable === true ||
      contextResult?.inProgress === true
        ? { retryResultMessageId: contextResult.id }
        : {}),
      ...(contextResult === undefined ||
      (contextResult.consumed && !contextResult.inProgress)
        ? {}
        : {
            contextResult: {
              messageId: contextResult.id,
              status: contextResult.inProgress
                ? ("unknown" as const)
                : contextResult.retryable
                  ? ("retryable_failure" as const)
                  : contextResult.failed === null
                    ? ("unknown" as const)
                    : contextResult.failed
                      ? ("failed" as const)
                      : ("completed" as const),
              text: contextResult.text,
            },
          }),
      ...(contextResult?.inProgress && contextResult.retryRequestId
        ? { retryRequestId: contextResult.retryRequestId }
        : {}),
      ...(card.selectedMessageId === null
        ? {}
        : { selectedMaterialMessageId: card.selectedMessageId }),
      ...(selectedMaterialText === undefined || materialMessage === undefined
        ? {}
        : {
            selectedMaterial: {
              messageId: materialMessage.id,
              text: selectedMaterialText,
            },
          }),
      truncated: card.truncated,
      question: stale
        ? "目标范围或来源已变化，请刷新后重新发起。"
        : (card.question ??
          (selected === null
            ? ask(candidates.length)
            : selectedText(selected.title))),
      ...(execution == null ? {} : { execution }),
    };
  }
  #observed(ref: PromptReference, allowStale = false) {
    const card = this.#cards.get(ref.interactionId);
    if (
      card.revision !== ref.revision ||
      card.promptMessageId !== ref.promptMessageId ||
      (!allowStale && this.#interaction(card).status === "stale")
    )
      throw new ConversationError("stale");
    return card;
  }
  async #retryContext(
    input: Extract<ConversationTurn, { action: "retry_context" }>,
    signal?: AbortSignal,
  ): Promise<ConversationReceipt> {
    const admitted = this.#cards.transaction<
      NaturalAdmission | ConversationReceipt
    >(() => {
      const replay = this.#cards.begin(input);
      if (replay !== null) return replay;
      const card = this.#cards.get(input.clarificationId);
      const failure = this.#cards.latestContextResult(card);
      if (
        card.revision !== input.expectedRevision ||
        card.status !== "resolved" ||
        card.awaiting !== null ||
        failure?.retryable !== true ||
        failure.id !== input.resultMessageId
      )
        throw new ConversationError("stale");
      const user = this.#cards.append({
        role: "user",
        content: "重试这次回答",
        details: {
          kind: "task_clarification_reply",
          action: "retry",
          clarification_id: card.id,
          reply_to_message_id: card.originalMessageId,
          observed_revision: card.revision,
          retry_result_message_id: failure.id,
          retry_request_id: input.requestId,
        },
      });
      if (card.selectedMessageId !== null)
        return this.#forMaterialMessage(card, card.selectedMessageId, user.id);
      const prior =
        card.entry ??
        (card.selected === null
          ? null
          : { kind: "work_item" as const, ...card.selected });
      if (prior === null) throw new ConversationError("stale");
      return this.#forSubject(card, prior, user.id);
    });
    if ("kind" in admitted) return admitted;
    return this.#answerNatural(input, admitted, signal);
  }
  #naturalTarget(text: string): LocatedTarget {
    const title =
      explicitTitle(text) ??
      /^把[「“]([^」”]+)[」”](?:改写|改成|改为|润色)/u.exec(text)?.[1];
    const first = title
      ?.split(/[，,；;\n]/u)[0]
      ?.trim()
      .replace(/^[「“]|[」”]$/gu, "");
    const directWorkItem =
      first !== undefined && isWorkItemId(first)
        ? this.#exact(first, true)
        : undefined;
    const directEntry =
      first !== undefined && isWorkItemId(first)
        ? this.#grounding?.entry(first)
        : undefined;
    const memoryRevision = this.#cards.memoryRevision();
    const titleSource =
      first ?? /^[把将]?[「“]([^」”]+)[」”]/u.exec(text)?.[1]?.trim();
    const namedEntries =
      titleSource === undefined || this.#grounding === undefined
        ? { candidates: [], truncated: false }
        : locateEntries(this.#grounding.query(), titleSource, memoryRevision);
    const exactEntries =
      titleSource === undefined
        ? []
        : namedEntries.candidates.filter(
            (candidate) =>
              normalized(candidate.title) === normalized(titleSource),
          );
    const exactWorkItemRefs =
      titleSource === undefined ? [] : this.#items.findExactTitle(titleSource);
    const workTitleTruncated = exactWorkItemRefs.length > MAX_LISTED_WORK_ITEMS;
    const exactWorkItems: SubjectCandidate[] = exactWorkItemRefs.flatMap(
      (reference) => {
        try {
          const current = this.#items.get(reference.id);
          return this.#eligible(current, true)
            ? [{ kind: "work_item" as const, ...choice(current) }]
            : [];
        } catch (error) {
          if (error instanceof WorkItemError && error.code === "missing")
            return [];
          throw error;
        }
      },
    );
    const namedEntry =
      !namedEntries.truncated && exactEntries.length === 1
        ? exactEntries[0]
        : undefined;

    // A title is only a direct binding when the bounded Entry search is complete
    // and unique across both subject kinds. A ranked hit (or one returned before
    // a truncated tail) is never enough to choose a historical source.
    if (directEntry !== undefined)
      return {
        exact: entryCandidate(directEntry, memoryRevision),
        candidates: [],
        truncated: false,
      };
    if (directWorkItem !== undefined)
      return {
        exact: { kind: "work_item", ...choice(directWorkItem) },
        candidates: [],
        truncated: false,
      };
    if (workTitleTruncated)
      return {
        exact: undefined,
        candidates: [
          ...exactWorkItems,
          ...(namedEntries.truncated ? namedEntries.candidates : exactEntries),
        ].slice(0, MAX_CLARIFICATION_CANDIDATES),
        truncated: true,
      };
    if (
      titleSource !== undefined &&
      (exactWorkItems.length + exactEntries.length > 1 ||
        (namedEntries.truncated && exactWorkItems.length > 0))
    )
      return {
        exact: undefined,
        candidates: [
          ...exactWorkItems,
          ...(namedEntries.truncated ? namedEntries.candidates : exactEntries),
        ].slice(0, MAX_CLARIFICATION_CANDIDATES),
        truncated:
          namedEntries.truncated ||
          exactWorkItems.length + exactEntries.length >
            MAX_CLARIFICATION_CANDIDATES,
      };
    if (exactWorkItems.length === 1 || namedEntry !== undefined)
      return {
        exact: exactWorkItems[0] ?? namedEntry,
        candidates: [],
        truncated: false,
      };
    const work = this.#matches(text, true);
    const query = this.#grounding?.query();
    const entries =
      query === undefined
        ? { candidates: [], truncated: false }
        : locateEntries(query, text, memoryRevision);
    // Merge only explicit work-item/source relations, never similar titles.
    const linked = new Set(
      work.candidates.flatMap((item) =>
        this.#items.entrySourceIds(item.id, 16),
      ),
    );
    const combined = [
      ...work.candidates.map((item) => ({
        kind: "work_item" as const,
        ...choice(item),
      })),
      ...entries.candidates.filter((part) => !linked.has(part.id)),
    ];
    return {
      exact: undefined,
      candidates: combined.slice(0, MAX_CLARIFICATION_CANDIDATES),
      truncated:
        work.truncated ||
        entries.truncated ||
        combined.length > MAX_CLARIFICATION_CANDIDATES,
    };
  }
  #utterance(
    input: Utterance,
    dispatch: Parameters<Parameters<ChatService["coordinateMain"]>[0]>[0],
    signal?: AbortSignal,
  ) {
    const admitted = this.#cards.transaction<
      ConversationReceipt | NaturalAdmission | null
    >(() => {
      const replay = this.#cards.begin(input);
      if (replay !== null) return replay;
      if (input.replyTo !== undefined) {
        const card = this.#observed(input.replyTo, input.command === "cancel");
        if (input.selection !== undefined && input.command !== undefined)
          throw new ConversationError("conflict");
        const view = this.#interaction(card);
        const selection =
          input.selection === undefined
            ? candidateSelection(input.text, view.candidates, view.truncated)
            : undefined;
        if (selection?.kind === "conflict")
          return this.#naturalMessage(
            input,
            "我看到多个不同的目标选择。请明确回复一个目标名称；这条消息还没有用于生成内容。",
          );
        const picked =
          input.selection === undefined
            ? selection?.kind === "selected"
              ? selection.candidate
              : undefined
            : view.candidates.find(
                (candidate) =>
                  JSON.stringify(subjectRef(candidate)) ===
                  JSON.stringify(input.selection),
              );
        if (input.selection !== undefined && picked === undefined)
          throw new ConversationError("conflict");
        return this.#resumeNatural(
          input,
          card,
          picked,
          input.command,
          "explicit",
        );
      }
      if (input.selection !== undefined || input.command !== undefined)
        throw new ConversationError("conflict");
      const purpose = decideChatPurpose(input.text);
      const bareMaterial = materialText(input.text);
      const material =
        purpose.kind === "answer" ? chatMaterialText(input.text) : null;
      const quotedObject =
        material !== null &&
        (this.#looksLikeNamedObject(material) ||
          this.#matchesKnownSubjectTitle(input.text, material));
      const independent =
        purpose.kind === "archive" ||
        purpose.kind === "lookup" ||
        (purpose.kind === "answer" &&
          !quotedObject &&
          !this.#looksLikeNamedObject(input.text)) ||
        (purpose.kind === "clarify" &&
          ["explicit_confirmation", "archive_content", "mixed"].includes(
            purpose.reason,
          ));
      if (input.snapshot !== undefined) {
        const snapshot = input.snapshot;
        if (
          snapshot.throughSequence > this.#cards.throughSequence() ||
          new Set(snapshot.prompts.map((ref) => ref.interactionId)).size !==
            snapshot.prompts.length
        )
          throw new ConversationError("stale");
        if (!independent) {
          const currentPrompts = this.#cards.list().flatMap((card) => {
            const view = this.#interaction(card);
            return view.promptMessageId === null || view.awaiting === null
              ? []
              : [
                  {
                    interactionId: view.id,
                    revision: view.revision,
                    promptMessageId: view.promptMessageId,
                  },
                ];
          });
          const sorted = (refs: readonly PromptReference[]) =>
            [...refs].sort((a, b) =>
              a.interactionId.localeCompare(b.interactionId),
            );
          if (
            JSON.stringify(sorted(snapshot.prompts)) !==
            JSON.stringify(sorted(currentPrompts))
          )
            throw new ConversationError("stale");
          for (const ref of snapshot.prompts)
            this.#cards.validateObserved(ref, snapshot.throughSequence);
          const cards = snapshot.prompts.map((ref) => this.#observed(ref));
          const matches = resolveNaturalReply(
            input.text,
            cards.map((card) => this.#interaction(card)),
          );
          if (matches.length > 1)
            return this.#naturalMessage(
              input,
              "这些内容是给哪个问题的？请补充完整对象名称，或使用对应的回复入口。",
            );
          const match = matches[0];
          const card = cards.find(({ id }) => id === match?.view.id);
          if (match?.conflict === true)
            return this.#naturalMessage(
              input,
              "我看到多个不同的目标选择。请明确回复一个目标名称；这条消息还没有用于生成内容。",
            );
          if (match !== undefined && card !== undefined)
            return this.#resumeNatural(
              input,
              card,
              match.picked,
              match.command,
              "natural",
            );
          const rejected = cards.filter(
            (card) =>
              card.awaiting === "subject" &&
              /^都不是[。！!]?$/u.test(normalized(card.latestReply ?? "")),
          );
          if (rejected.length === 1)
            return this.#refreshNaturalSubjects(input, rejected[0]!);
          const emptySubjectCards = cards.filter(
            (card) => card.awaiting === "subject" && card.subjects.length === 0,
          );
          if (bareMaterial !== undefined && emptySubjectCards.length > 1) {
            return this.#naturalMessage(
              input,
              "我已收到材料，但有多个待回答的问题。请使用对应问题的回复入口说明这段材料用于哪一条请求。",
            );
          } else if (
            bareMaterial !== undefined &&
            emptySubjectCards.length === 1
          ) {
            return this.#bindNaturalMaterial(input, emptySubjectCards[0]!);
          } else if (emptySubjectCards.length > 1) {
            const located = this.#naturalTarget(input.text);
            if (located.exact !== undefined || located.candidates.length > 0)
              return this.#naturalMessage(
                input,
                "我找到了一份相关材料，但同时有多个待回答的问题。请使用对应问题的回复入口。",
              );
          } else if (emptySubjectCards.length === 1) {
            const located = this.#naturalTarget(input.text);
            if (located.exact !== undefined || located.candidates.length > 0)
              return this.#refreshNaturalSubjects(input, emptySubjectCards[0]!);
          }
        }
      }
      if (material !== null && !quotedObject) {
        const user = this.#cards.append({
          role: "user",
          content: input.text,
          details: { kind: "conversation_context_input" },
        });
        return {
          userMessageId: user.id,
          fence: {
            memoryRevision: this.#cards.memoryRevision(),
            card: null,
            work: null,
          },
          context: {
            original: input.text,
            supplements: [],
            target: null,
            materialSources: [{ messageId: user.id, text: material }],
            operation: "rewrite",
          },
          entryIds: [],
          allowTitleSearch: false,
        };
      }
      const namedRewrite = quotedObject;
      if (
        purpose.kind === "propose_execution" ||
        namedRewrite ||
        (purpose.kind === "clarify" && purpose.reason === "target")
      )
        return this.#openNatural(input, namedRewrite);
      if (purpose.kind === "lookup" && this.#grounding !== undefined)
        return this.#admitGrounded(input);
      if (bareMaterial !== undefined && purpose.kind !== "archive")
        return this.#naturalMessage(
          input,
          "已收到原文。你希望怎么处理这段内容？",
        );
      return null;
    });
    if (admitted === null) return this.#dispatchNatural(input, dispatch);
    if ("kind" in admitted) return Promise.resolve(admitted);
    return this.#answerNatural(input, admitted, signal);
  }
  async #dispatchNatural(
    input: Utterance,
    dispatch: Parameters<Parameters<ChatService["coordinateMain"]>[0]>[0],
  ): Promise<ConversationReceipt> {
    let result: ConversationReceipt | undefined;
    await dispatch(input.text, (kind, user, assistant, chatError) => {
      result = {
        kind,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        chatError,
      };
      this.#cards.finish(input.requestId, result);
    });
    if (result === undefined) throw new Error("missing published utterance");
    return result;
  }
  #looksLikeNamedObject(text: string) {
    return (
      text.length <= 120 &&
      !/[，。；;、!?？\n:：]/u.test(text) &&
      /(?:实验|报告|任务|项目|记录|作业|文件)$/u.test(text)
    );
  }
  #matchesKnownSubjectTitle(rawText: string, material: string): boolean {
    if (
      hasExplicitMaterialMarker(rawText) ||
      material.length > 120 ||
      /[，。；;!?？\n]/u.test(material)
    )
      return false;
    const located = this.#naturalTarget(rawText);
    if (located.exact !== undefined) return true;
    const needle = normalized(material);
    return located.candidates.some(
      (candidate) => normalized(candidate.title) === needle,
    );
  }
  #naturalMessage(input: Utterance, content: string): ConversationReceipt {
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: { kind: "conversation_context_input" },
    });
    return this.#publish(
      input.requestId,
      user.id,
      { kind: "clarify", chatError: null },
      content,
      { kind: "task_clarification_result" },
    );
  }
  #openNatural(
    input: Utterance,
    namedRewrite: boolean,
  ): NaturalAdmission | ConversationReceipt {
    const { exact, candidates, truncated } = this.#naturalTarget(input.text);
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: { kind: "task_clarification_input" },
    });
    const requirements =
      namedRewrite ||
      hasRequirements(input.text) ||
      /只改报告|仅改报告|只读检查/u.test(input.text);
    const direct =
      exact?.kind === "entry"
        ? [exact.id]
        : exact === undefined
          ? []
          : this.#items.entrySourceIds(exact.id, 6);
    const workspace =
      /^(?:请\s*)?(?:帮我\s*)?(?:只读\s*)?(?:检查|打开|读取|运行|执行)/u.test(
        input.text,
      );
    const awaiting: Awaiting | null =
      exact === undefined
        ? "subject"
        : workspace
          ? null
          : !requirements
            ? "requirements"
            : direct.length === 0
              ? "material"
              : null;
    const question =
      workspace && exact !== undefined
        ? exact.kind === "entry"
          ? "已定位这份记录。检查工作区需要单独指定工作目标并批准。"
          : "已关联目标。检查工作区请从卡片创建只读提案。"
        : this.#question(awaiting, candidates, exact?.title);
    const assistant = this.#cards.append({
      role: "assistant",
      content: question,
      details: {
        kind: "task_clarification_result",
        source_message_id: user.id,
      },
    });
    const ref = exact === undefined ? undefined : subjectRef(exact);
    const id = this.#cards.create(
      user.id,
      assistant.id,
      [],
      truncated,
      ref?.kind === "work_item" ? ref : null,
      awaiting,
      candidates.map(subjectRef),
      ref?.kind === "entry" ? ref : undefined,
    );
    if (
      exact !== undefined &&
      awaiting === null &&
      !workspace &&
      ref !== undefined
    ) {
      const card = this.#cards.get(id);
      return this.#forSubject(card, ref, user.id);
    }
    const result = {
      kind: "clarification",
      clarificationId: id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    } as const;
    this.#cards.finish(input.requestId, result);
    return result;
  }
  #question(
    awaiting: Awaiting | null,
    candidates: readonly SubjectCandidate[],
    title?: string,
  ) {
    if (awaiting === "subject")
      return candidates.length === 0
        ? "在已保存的有效记录中没有定位到相关材料。请告诉我完整主题或贴出原文。"
        : (
            "你指的是哪一份？" +
            candidates
              .map((x) =>
                x.kind === "entry"
                  ? `记录「${x.title.slice(0, 14)}」（${x.createdAt.slice(5, 10)} ${x.hint.slice(0, 12)}）`
                  : `工作目标「${x.title.slice(0, 20)}」`,
              )
              .join("；") +
            "。可回复名称或区分内容，也可以说都不是。"
          ).slice(0, 240);
    if (awaiting === "material")
      return (
        "已关联「" + (title ?? "材料").slice(0, 80) + "」。请贴出要处理的原文。"
      );
    if (awaiting === "requirements")
      return "已关联「" + (title ?? "材料").slice(0, 80) + "」。你希望怎么改？";
    return "已关联所选材料，下面处理原请求。";
  }
  #resumeNatural(
    input: Utterance,
    card: StoredClarification,
    picked: SubjectCandidate | undefined,
    command: "none" | "cancel" | "retry" | undefined,
    relation: "natural" | "explicit",
  ): NaturalAdmission | ConversationReceipt {
    if (card.status === "cancelled" || card.status === "stale")
      throw new ConversationError("stale");
    if (
      command === undefined &&
      picked === undefined &&
      (card.awaiting === "material" ||
        (card.awaiting === "subject" &&
          (card.subjects.length === 0 ||
            /^都不是[。！!]?$/u.test(normalized(card.latestReply ?? ""))))) &&
      materialText(input.text) !== undefined
    )
      return this.#bindNaturalMaterial(input, card);
    if (
      command === undefined &&
      card.awaiting === "requirements" &&
      card.selectedMessageId !== null
    ) {
      const user = this.#cards.append({
        role: "user",
        content: input.text,
        details: {
          kind: "task_clarification_reply",
          action: "reply",
          clarification_id: card.id,
          reply_to_message_id: card.originalMessageId,
          prompt_message_id: card.promptMessageId,
          observed_revision: card.revision,
          relation,
          material_message_id: card.selectedMessageId,
        },
      });
      if (hasRequirements(input.text)) {
        this.#cards.update(card, {
          status: "resolved",
          candidates: [],
          subjects: [],
          truncated: false,
          selected: null,
          entry: null,
          materialMessageId: card.selectedMessageId,
          latestReplyId: user.id,
          awaiting: null,
          promptMessageId: null,
        });
        return this.#forMaterialMessage(
          this.#cards.get(card.id),
          card.selectedMessageId,
          user.id,
        );
      }
      const result = this.#publish(
        input.requestId,
        user.id,
        { kind: "clarification", clarificationId: card.id },
        "已收到补充。请告诉我希望如何改写这段原文。",
        { kind: "task_clarification_result", clarification_id: card.id },
      );
      this.#cards.update(card, {
        status: "resolved",
        candidates: [],
        subjects: [],
        truncated: false,
        selected: null,
        entry: null,
        materialMessageId: card.selectedMessageId,
        latestReplyId: user.id,
        awaiting: "requirements",
        promptMessageId: result.assistantMessageId,
      });
      return result;
    }
    const prior =
      card.entry ??
      (card.selected === null
        ? null
        : { kind: "work_item" as const, ...card.selected });
    if (command === "retry") {
      const failedResult = this.#cards.latestContextResult(card);
      if (
        input.retryResultMessageId === undefined ||
        failedResult?.retryable !== true ||
        failedResult.id !== input.retryResultMessageId ||
        card.awaiting !== null
      )
        throw new ConversationError("stale");
      const retry = this.#cards.append({
        role: "user",
        content: input.text,
        details: {
          kind: "task_clarification_reply",
          action: "retry",
          clarification_id: card.id,
          reply_to_message_id: card.originalMessageId,
          prompt_message_id: card.promptMessageId,
          observed_revision: card.revision,
          relation,
          retry_result_message_id: failedResult.id,
          retry_request_id: input.requestId,
        },
      });
      if (card.selectedMessageId !== null)
        return this.#forMaterialMessage(card, card.selectedMessageId, retry.id);
      if (prior === null) throw new ConversationError("stale");
      return this.#forSubject(card, prior, retry.id);
    }
    if (card.awaiting === null && command !== "cancel")
      throw new ConversationError("stale");
    const ref = picked === undefined ? prior : subjectRef(picked);
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: {
        kind: "task_clarification_reply",
        action: command ?? "reply",
        clarification_id: card.id,
        reply_to_message_id: card.originalMessageId,
        prompt_message_id: card.promptMessageId,
        observed_revision: card.revision,
        relation,
        ...(ref === null ? {} : { target: ref }),
      },
    });
    const changed = {
      status:
        command === "cancel"
          ? ("cancelled" as const)
          : ref === null
            ? ("pending" as const)
            : ("resolved" as const),
      candidates: [],
      subjects: command === "cancel" ? [] : card.subjects,
      truncated: command === "none" ? false : card.truncated,
      selected: command !== "cancel" && ref?.kind === "work_item" ? ref : null,
      entry: command !== "cancel" && ref?.kind === "entry" ? ref : null,
      latestReplyId: command === "cancel" ? card.latestReplyId : user.id,
    };
    const supplements = this.#cards.supplements(card, MAX_SUPPLEMENTS + 1);
    if (supplements.length > MAX_SUPPLEMENTS)
      throw new ConversationError("context_limit");
    const workspace =
      /^(?:请\s*)?(?:帮我\s*)?(?:只读\s*)?(?:检查|打开|读取|运行|执行)/u.test(
        input.text,
      );
    const title =
      picked?.title ?? (ref === null ? undefined : this.#subject(ref)?.title);
    const awaiting: Awaiting | null =
      changed.status === "cancelled" || (workspace && ref !== null)
        ? null
        : ref === null
          ? "subject"
          : ![card.originalText, ...supplements].some(
                (x) => hasRequirements(x) || /只改报告|仅改报告/u.test(x),
              )
            ? "requirements"
            : ref.kind === "work_item" &&
                this.#items.entrySourceIds(ref.id, 1).length === 0 &&
                ![card.originalText, ...supplements].some(
                  (x) => materialText(x) !== undefined,
                )
              ? "material"
              : null;
    if (
      awaiting === null &&
      changed.status === "resolved" &&
      ref !== null &&
      !workspace
    ) {
      this.#cards.update(card, { ...changed, awaiting: null });
      this.#agent?.rejectPendingForConversationWithinTransaction(card.id);
      return this.#forSubject(this.#cards.get(card.id), ref, user.id);
    }
    const content =
      changed.status === "cancelled"
        ? "已取消这次澄清。"
        : workspace && ref !== null
          ? "检查工作区需要单独创建只读提案并批准；这条回复没有执行任何操作。"
          : this.#question(
              awaiting,
              command === "none" ? [] : this.#interaction(card).candidates,
              title,
            );
    const result = this.#publish(
      input.requestId,
      user.id,
      { kind: "clarification", clarificationId: card.id },
      content,
      { kind: "task_clarification_result", clarification_id: card.id },
    );
    this.#cards.update(card, {
      ...changed,
      awaiting,
      promptMessageId: result.assistantMessageId,
    });
    this.#agent?.rejectPendingForConversationWithinTransaction(card.id);
    return result;
  }
  #bindNaturalMaterial(
    input: Utterance,
    card: StoredClarification,
  ): NaturalAdmission | ConversationReceipt {
    const body = materialText(input.text);
    if (body === undefined) return this.#refreshNaturalSubjects(input, card);
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: {
        kind: "task_clarification_reply",
        action: "reply",
        clarification_id: card.id,
        reply_to_message_id: card.originalMessageId,
        prompt_message_id: card.promptMessageId,
        observed_revision: card.revision,
        relation: "natural",
      },
    });
    const existing = this.#cards.supplements(card, MAX_SUPPLEMENTS + 1);
    if (existing.length >= MAX_SUPPLEMENTS)
      throw new ConversationError("context_limit");
    const requirements = [card.originalText, ...existing, input.text].some(
      (part) => hasRequirements(part) || /只改报告|仅改报告/u.test(part),
    );
    this.#cards.update(card, {
      status: "resolved",
      candidates: [],
      subjects: [],
      truncated: false,
      selected: null,
      entry: null,
      materialMessageId: user.id,
      latestReplyId: user.id,
      awaiting: requirements ? null : "requirements",
      promptMessageId: card.promptMessageId,
    });
    const updated = this.#cards.get(card.id);
    if (requirements)
      return this.#forMaterialMessage(updated, user.id, user.id);
    const result = this.#publish(
      input.requestId,
      user.id,
      { kind: "clarification", clarificationId: card.id },
      "已收到这段原文。你希望怎么改？",
      { kind: "task_clarification_result", clarification_id: card.id },
    );
    this.#cards.update(updated, {
      status: "resolved",
      candidates: [],
      subjects: [],
      truncated: false,
      selected: null,
      entry: null,
      materialMessageId: user.id,
      latestReplyId: user.id,
      awaiting: "requirements",
      promptMessageId: result.assistantMessageId,
    });
    return result;
  }
  #forMaterialMessage(
    card: StoredClarification,
    materialMessageId: string,
    userMessageId: string,
  ): NaturalAdmission {
    const source = this.#cards.materialMessage(card);
    const body = source === undefined ? undefined : materialText(source.text);
    if (source === undefined || body === undefined)
      throw new ConversationError("stale");
    const supplements = this.#cards.supplements(card, MAX_SUPPLEMENTS + 1);
    if (supplements.length > MAX_SUPPLEMENTS)
      throw new ConversationError("context_limit");
    return {
      userMessageId,
      fence: {
        memoryRevision: this.#cards.memoryRevision(),
        card: {
          id: card.id,
          revision: card.revision,
          selectedMessageId: materialMessageId,
        },
        work: null,
      },
      context: {
        original: card.originalText,
        supplements,
        target: null,
        operation: "rewrite",
        materialSources: [{ messageId: source.id, text: body }],
      },
      entryIds: [],
      allowTitleSearch: false,
    };
  }
  #refreshNaturalSubjects(
    input: Utterance,
    card: StoredClarification,
  ): NaturalAdmission | ConversationReceipt {
    const located = this.#naturalTarget(input.text);
    if (located.exact !== undefined)
      return this.#resumeNatural(
        input,
        card,
        located.exact,
        undefined,
        "natural",
      );
    const candidates =
      located.exact === undefined ? located.candidates : [located.exact];
    const user = this.#cards.append({
      role: "user",
      content: input.text,
      details: {
        kind: "task_clarification_reply",
        action: "reply",
        clarification_id: card.id,
        reply_to_message_id: card.originalMessageId,
        prompt_message_id: card.promptMessageId,
        observed_revision: card.revision,
        relation: "natural",
      },
    });
    const question = this.#question("subject", candidates);
    const result = this.#publish(
      input.requestId,
      user.id,
      { kind: "clarification", clarificationId: card.id },
      question,
      { kind: "task_clarification_result", clarification_id: card.id },
    );
    this.#cards.update(card, {
      status: "pending",
      candidates: [],
      subjects: candidates.map(subjectRef),
      truncated: located.truncated,
      selected: null,
      entry: null,
      awaiting: "subject",
      latestReplyId: user.id,
      promptMessageId: result.assistantMessageId,
    });
    return result;
  }
  #forSubject(
    card: StoredClarification,
    ref: SubjectReference,
    userMessageId: string,
  ): NaturalAdmission {
    const target = ref.kind === "work_item" ? this.#live(ref, true) : null;
    if (target === undefined || this.#subject(ref) === undefined)
      throw new ConversationError("stale");
    const supplements = this.#cards.supplementMessages(
      card,
      MAX_SUPPLEMENTS + 1,
    );
    const subjectTitle = this.#subject(ref)?.title;
    const materialSources = [
      { id: card.originalMessageId, text: card.originalText },
      ...supplements,
    ].flatMap(({ id, text }) => {
      const value = materialText(text);
      if (value === undefined) return [];
      if (
        !hasExplicitMaterialMarker(text) &&
        subjectTitle !== undefined &&
        normalized(value) === normalized(subjectTitle)
      )
        return [];
      return [{ messageId: id, text: value }];
    });
    return {
      userMessageId,
      fence: {
        memoryRevision: this.#cards.memoryRevision(),
        card: {
          id: card.id,
          revision: card.revision,
          selectedMessageId: card.selectedMessageId,
        },
        work:
          target === null
            ? null
            : {
                id: target.id,
                scopeRevision: target.scopeRevision,
                status: target.status,
              },
        ...(ref.kind === "entry" ? { entry: ref.id } : {}),
      },
      context: {
        original: card.originalText,
        supplements: supplements.map(({ text }) => text),
        target,
        operation: "rewrite",
        subject: { kind: ref.kind, id: ref.id },
        materialSources,
      },
      entryIds:
        ref.kind === "entry" ? [ref.id] : this.#items.entrySourceIds(ref.id, 6),
      allowTitleSearch: false,
    };
  }
  async #answerNatural(
    input: { readonly requestId: string },
    admitted: NaturalAdmission,
    signal?: AbortSignal,
  ): Promise<ConversationReceipt> {
    const current = () =>
      this.#cards.contextCurrent(admitted.fence) &&
      (admitted.fence.work === null ||
        this.#items.hasAvailableScopeSources(admitted.fence.work.id));
    let result: GroundedResult;
    let retryableFailure = false;
    let knownFailure = false;
    try {
      result = admitted.immediate ??
        (await this.#grounding?.answer(
          admitted.context,
          admitted.entryIds,
          admitted.allowTitleSearch,
          current,
          signal,
        )) ?? { text: "暂时无法处理资料，请稍后重试。", citations: [] };
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof LlmError) && !(error instanceof HarnessError))
        throw error;
      knownFailure = true;
      retryableFailure =
        error instanceof LlmError
          ? error.retryable
          : error.code !== "context_limit";
      result = { text: "暂时无法处理资料，可从对应卡片重试。", citations: [] };
    }
    throwIfAborted(signal);
    return this.#cards.transaction(() => {
      const valid = current();
      const card =
        admitted.fence.card === null
          ? null
          : this.#cards.get(admitted.fence.card.id);
      const needsMaterial = valid && result.missing && card !== null;
      const fence =
        needsMaterial && card !== null
          ? {
              ...admitted.fence,
              card: {
                id: card.id,
                revision: card.revision + 1,
                selectedMessageId: card.selectedMessageId,
              },
            }
          : admitted.fence;
      const content = !valid
        ? STALE_CONTEXT_MESSAGE
        : needsMaterial
          ? this.#question(
              "material",
              [],
              card === null
                ? undefined
                : this.#interaction(card).selected?.title,
            )
          : result.text;
      const payload =
        card === null
          ? {
              kind:
                admitted.context.operation === "rewrite"
                  ? ("answer" as const)
                  : ("lookup" as const),
              chatError: valid ? null : STALE_CONTEXT_MESSAGE,
            }
          : { kind: "clarification" as const, clarificationId: card.id };
      const published = this.#publish(
        input.requestId,
        admitted.userMessageId,
        payload,
        content,
        {
          kind: "conversation_context_result",
          fence,
          ...(valid
            ? {
                citations: result.citations,
                materialMessageIds: result.materialMessageIds ?? [],
                clarification_id: card?.id,
                workItemId: fence.work?.id,
                retryable: retryableFailure,
                failed: knownFailure,
              }
            : {}),
        },
      );
      if (needsMaterial && card !== null)
        this.#cards.update(card, {
          status: card.status,
          candidates: card.candidates,
          subjects: card.subjects,
          truncated: card.truncated,
          selected: card.selected,
          entry: card.entry,
          latestReplyId: card.latestReplyId,
          awaiting: "material",
          promptMessageId: published.assistantMessageId,
        });
      return published;
    });
  }

  #resolved(input: Continue | Delegate) {
    const card = this.#cards.get(input.clarificationId);
    const item = card.selected === null ? undefined : this.#live(card.selected);
    if (
      card.status !== "resolved" ||
      card.revision !== input.expectedRevision ||
      item === undefined
    )
      throw new ConversationError("stale");
    return { card, item };
  }

  async #delegate(
    input: Delegate,
    signal?: AbortSignal,
  ): Promise<ConversationReceipt> {
    const replay = this.#cards.replay(input);
    if (replay !== null) return replay;
    const agent = this.#agent;
    if (agent === undefined) throw new AgentError("disabled");
    this.#resolved(input);
    const memoryRevision = this.#cards.memoryRevision();
    await agent.verifyWorkItemWorkspace(
      input.backend,
      input.workspaceId,
      signal,
    );
    throwIfAborted(signal);
    return this.#cards.transaction<ConversationReceipt>(() => {
      const replay = this.#cards.begin(input);
      if (replay !== null) return replay;
      const { card, item } = this.#resolved(input);
      if (this.#cards.memoryRevision() !== memoryRevision)
        throw new ConversationError("stale");
      const supplements = this.#cards.supplements(card, MAX_SUPPLEMENTS + 1);
      const entryIds = this.#items.entrySourceIds(item.id, 17);
      const instruction = [
        "只读检查明确登记的工作区。只输出发现与建议，不写文件。",
        `目标 ID：${item.id}；范围版本：${item.scopeRevision}`,
        "原请求：",
        card.originalText,
        ...supplements.flatMap((text) => ["补充要求：", text]),
        ...(entryIds.length === 0
          ? []
          : [`关联 Entry（仅作材料引用）：${entryIds.join("、")}`]),
      ].join("\n");
      const attempt = workItemAttemptSchema.safeParse({
        requestId: randomUUID(),
        expectedRevision: item.revision,
        backend: input.backend,
        workspaceId: input.workspaceId,
        instruction,
      });
      const fullInstruction = workItemInstruction(item, instruction);
      if (
        !attempt.success ||
        supplements.length > MAX_SUPPLEMENTS ||
        entryIds.length > 16 ||
        fullInstruction.length > 12000 ||
        Buffer.byteLength(fullInstruction) * 2 + 512 > 32 * 1024
      )
        throw new ConversationError("context_limit");
      const task = agent.proposeForConversationWithinTransaction(
        item.id,
        attempt.data,
        card,
      );
      const user = this.#cards.append({
        role: "user",
        content: "创建工作区只读检查提案",
        details: {
          kind: "conversation_context_input",
          clarification_id: card.id,
        },
      });
      return this.#publish(
        input.requestId,
        user.id,
        {
          kind: "clarification",
          clarificationId: card.id,
        },
        "已创建只读检查提案，批准后才会运行。",
        {
          kind: "task_clarification_result",
          clarification_id: card.id,
          task_id: task.id,
        },
      );
    });
  }

  #admitGrounded(input: GroundedTurn): GroundedAdmission {
    let cardRef: GroundedFence["card"] = null;
    let work: GroundedFence["work"] = null;
    let target: ConversationContext["target"] = null;
    let supplements: readonly string[] = [];
    let entryIds: readonly string[] = [];
    let allowTitleSearch = false;
    let immediate: GroundedResult | undefined;
    let original: string;
    if (input.action === "continue") {
      const { card, item } = this.#resolved(input);
      cardRef = {
        id: card.id,
        revision: card.revision,
        selectedMessageId: card.selectedMessageId,
      };
      work = { id: item.id, scopeRevision: item.scopeRevision };
      const {
        id,
        title,
        goal,
        acceptance,
        status,
        lastAttemptId,
        lastAttemptStatus,
      } = item;
      target = {
        id,
        title,
        goal,
        acceptance,
        status,
        lastAttemptId,
        lastAttemptStatus,
      };
      supplements = this.#cards.supplements(card, MAX_SUPPLEMENTS + 1);
      entryIds = this.#items.entrySourceIds(item.id, 16);
      allowTitleSearch = this.#items.findExactTitle(item.title).length === 1;
      original = card.originalText;
    } else {
      original = input.text;
      const title = explicitGoalReview(original);
      if (title !== undefined) {
        const candidates = this.#items.findExactTitle(title);
        const identity = candidates.length === 1 ? candidates[0] : undefined;
        if (identity === undefined) {
          immediate = {
            text:
              candidates.length === 0
                ? "没有找到这个完整名称的工作目标。"
                : "有多个同名目标，请在工作目标列表中核对。",
            citations: [],
          };
        } else {
          const item = this.#items.get(identity.id);
          if (item.cancelRequested) {
            immediate = {
              text: "这个工作目标正在取消，请稍后查看。",
              citations: [],
            };
          } else {
            work = {
              id: item.id,
              scopeRevision: item.scopeRevision,
              status: item.status,
            };
            immediate = {
              text: `「${item.title}」
状态：${item.status}
验收要求：${item.acceptance}`,
              citations: [],
            };
          }
        }
      }
    }
    const user = this.#cards.append({
      role: "user",
      content: cardRef === null ? original : "按原请求和补充继续处理",
      details: {
        kind: "conversation_context_input",
        clarification_id: cardRef?.id ?? null,
      },
    });
    return {
      userMessageId: user.id,
      fence: {
        memoryRevision: this.#cards.memoryRevision(),
        card: cardRef,
        work,
      },
      context: { original, supplements, target },
      entryIds,
      allowTitleSearch,
      ...(immediate === undefined ? {} : { immediate }),
    };
  }

  async #grounded(
    input: GroundedTurn,
    signal?: AbortSignal,
  ): Promise<ConversationReceipt> {
    const entry = this.#cards.transaction<
      GroundedAdmission | ConversationReceipt
    >(() => {
      const replay = this.#cards.begin(input);
      return replay ?? this.#admitGrounded(input);
    });
    if ("kind" in entry) return entry;
    const current = () =>
      this.#cards.contextCurrent(entry.fence) &&
      (entry.fence.card === null ||
        (entry.fence.work !== null &&
          this.#items.hasAvailableScopeSources(entry.fence.work.id)));
    let result: GroundedResult;
    let retryableFailure = false;
    let knownFailure = false;
    try {
      result = entry.immediate ??
        (await this.#grounding?.answer(
          entry.context,
          entry.entryIds,
          entry.allowTitleSearch,
          current,
          signal,
        )) ?? {
          text: "当前无法处理材料，可补充原文或创建只读检查提案。",
          citations: [],
        };
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      if (!(error instanceof HarnessError) && !(error instanceof LlmError))
        throw error;
      knownFailure = true;
      retryableFailure =
        error instanceof LlmError
          ? error.retryable
          : error.code !== "context_limit";
      result = { text: "暂时无法从资料生成答案，请稍后重试。", citations: [] };
    }
    throwIfAborted(signal);
    return this.#cards.transaction<ConversationReceipt>(() => {
      const valid = current();
      return this.#publish(
        input.requestId,
        entry.userMessageId,
        input.action === "continue"
          ? { kind: "clarification", clarificationId: input.clarificationId }
          : { kind: "lookup", chatError: valid ? null : STALE_CONTEXT_MESSAGE },
        valid ? result.text : STALE_CONTEXT_MESSAGE,
        valid
          ? {
              kind: "conversation_context_result",
              fence: entry.fence,
              citations: result.citations,
              workItemId: entry.fence.work?.id,
              clarification_id: entry.fence.card?.id,
              retryable: retryableFailure,
              failed: knownFailure,
            }
          : { kind: "conversation_context_result", fence: entry.fence },
      );
    });
  }

  #publish(
    requestId: string,
    userMessageId: string,
    payload:
      | { kind: "clarification"; clarificationId: string }
      | { kind: "lookup" | "clarify" | "answer"; chatError: string | null },
    content: string,
    details: Readonly<Record<string, unknown>>,
  ): ConversationReceipt {
    const assistant = this.#cards.append({
      role: "assistant",
      content,
      details: { ...details, source_message_id: userMessageId },
    });
    const result = {
      ...payload,
      userMessageId,
      assistantMessageId: assistant.id,
    };
    this.#cards.finish(requestId, result);
    return result;
  }

  #live(
    reference: ClarificationReference,
    natural = false,
  ): WorkItem | undefined {
    try {
      const item = this.#items.get(reference.id);
      return item.scopeRevision === reference.scopeRevision &&
        this.#eligible(item, natural)
        ? item
        : undefined;
    } catch (error) {
      if (error instanceof WorkItemError && error.code === "missing")
        return undefined;
      throw error;
    }
  }
  #eligible(item: WorkItem, natural = false) {
    return (
      !item.cancelRequested &&
      (natural || item.status !== "done") &&
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
    const execution = this.#agent?.conversationExecution(card.id);
    const projected = clarificationCardSchema.safeParse({
      id: card.id,
      originalMessageId: card.originalMessageId,
      assistantMessageId: card.assistantMessageId,
      originalText: card.originalText,
      latestReply: card.latestReply,
      ...(execution == null ? {} : { execution }),
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
  #exact(titleOrId: string, natural = false): WorkItem | undefined {
    if (isWorkItemId(titleOrId)) {
      try {
        const item = this.#items.get(titleOrId);
        if (this.#eligible(item, natural)) return item;
      } catch (error) {
        if (!(error instanceof WorkItemError && error.code === "missing"))
          throw error;
      }
    }
    if (natural) {
      const matches = this.#items.findExactTitle(titleOrId);
      if (matches.length !== 1 || matches[0] === undefined) return undefined;
      const item = this.#items.get(matches[0].id);
      return this.#eligible(item, true) ? item : undefined;
    }
    const resolution = resolveWorkItem(
      { title: titleOrId },
      this.#items.findExactTitle(titleOrId),
    );
    if (resolution.workItemId === null) return undefined;
    const item = this.#items.get(resolution.workItemId);
    return this.#eligible(item, natural) ? item : undefined;
  }
  #matches(text: string, natural = false) {
    const { items, truncated } = this.#items.clarificationPool(natural);
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
        return score > 0 && this.#eligible(item, natural)
          ? [{ item, score }]
          : [];
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
    if (
      card.entry !== null ||
      card.subjects.some((subject) => subject.kind === "entry")
    )
      throw new ConversationError("conflict");
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
    this.#agent?.rejectPendingForConversationWithinTransaction(card.id);
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
