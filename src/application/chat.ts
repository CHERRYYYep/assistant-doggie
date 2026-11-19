/** Shared turn orchestration. Legacy archive-first and routed main chat. */
import { z } from "zod";
import { BucketStatus } from "../domain/types.ts";
import { DomainError, requiredText } from "../domain/errors.ts";
import { decideChatPurpose, type ChatPurpose } from "../domain/chat-purpose.ts";
import { HarnessError, AgentError } from "../domain/agent.ts";
import { TaskError } from "../domain/task.ts";
import { WorkItemError } from "../domain/work-item.ts";
import {
  isAbortError,
  throwIfAborted,
  withCancellation,
} from "../llm/cancellation.ts";
import { LlmError } from "../llm/structured-output.ts";
import { StorageError } from "../storage/database.ts";
import type { Store } from "../storage/store.ts";
import type {
  ChatMessageRow,
  ConversationStore,
} from "../storage/conversation.ts";
import type {
  ArchiveRuntime,
  ArchiveExecution,
  ConfirmationExecution,
  RuntimeConfirmationRequest,
} from "./archive-runtime.ts";
import { ApplicationError } from "./archive.ts";
import { ChatTurns } from "./chat-turns.ts";
import { CorrectionError } from "./correction.ts";
import { MemoryQueryError } from "./memory-query.ts";
import { projectBucket, projectArchiveExecution } from "./archive-view.ts";
import {
  ChatFailure,
  type ChatInput,
  type ChatResponder,
  type ChatResponderInput,
  type ChatResponse,
  type ChatToolMessage,
} from "./chat-types.ts";

type ArchiveSnapshot = ReturnType<typeof decorateChatArchive>;
type ChatArchive = Omit<ArchiveSnapshot, "archive_state"> & {
  readonly archive_state:
    ArchiveSnapshot["archive_state"] | "revoked" | "deleted";
  readonly revoked_at?: string;
};

const CHAT_HISTORY_LIMIT = 40;
const MEMORY_CHANGED = "记忆已更新，请重新提问。";

type AcceptedTurn = {
  readonly sourceText: string;
  readonly userMessage: ChatMessageRow;
  readonly contextRevision: number;
};
type TurnPublished = (
  kind: ChatPurpose["kind"],
  user: ChatMessageRow,
  assistant: ChatMessageRow,
  error: string | null,
) => void;

type AnswerAttempt = {
  readonly response?: ChatResponse;
  readonly error: string | null;
};

export class ChatService {
  readonly #turns = new ChatTurns();
  readonly #store: Pick<
    Store,
    | "getBucket"
    | "getEntry"
    | "listEffectiveMemoryIdsForEntry"
    | "getEntryRevocation"
    | "requirePendingArchiveAttempt"
  >;
  readonly #conversation: ConversationStore;
  readonly #runtime: ArchiveRuntime;
  readonly #chatResponder: ChatResponder | undefined;

  constructor(
    store: Store,
    runtime: ArchiveRuntime,
    responder?: ChatResponder,
  ) {
    this.#store = store;
    this.#conversation = store.conversation;
    this.#runtime = runtime;
    this.#chatResponder = responder;
  }

  chat(request: ChatInput, signal?: AbortSignal) {
    return this.#turns.run(() => this.#chat(request, signal), signal);
  }

  /** Internal entry for the next main-chat transport. The legacy API stays archive-first. */
  mainChat(input: Pick<ChatInput, "text">, signal?: AbortSignal) {
    return this.#turns.run(() => this.#mainChat(input.text, signal), signal);
  }

  /** The C2 application service may commit a clarification or dispatch a regular turn in this slot. */
  coordinateMain<T>(
    operation: (
      dispatch: (text: string, publish?: TurnPublished) => Promise<unknown>,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#turns.run(
      () => operation((text, publish) => this.#mainChat(text, signal, publish)),
      signal,
    );
  }

  async #mainChat(
    rawText: string,
    signal?: AbortSignal,
    publish?: TurnPublished,
  ) {
    throwIfAborted(signal);
    const text = requiredText(rawText, "text");
    const purpose = decideChatPurpose(text);
    if (purpose.kind === "archive")
      return {
        ...(await this.#chat({ text }, signal, publish)),
        purpose,
      } as const;

    const turn = this.#acceptInput({ text }, signal);
    const answer =
      purpose.kind === "answer" || purpose.kind === "lookup"
        ? await this.#tryAnswer(
            turn,
            { archive: null, purpose: purpose.kind },
            signal,
          )
        : undefined;
    // No archive was committed on this path. Cancellation leaves the accepted
    // input but publishes no answer, especially if the model ignored abort.
    throwIfAborted(signal);
    const fallback = mainChatFallback(purpose);
    let chatError = answer?.error ?? null;
    const result = this.#appendReplies(
      turn,
      (memoryChanged) => {
        if (memoryChanged) chatError = MEMORY_CHANGED;
        return {
          assistantText: memoryChanged
            ? MEMORY_CHANGED
            : (answer?.response?.assistantText ?? fallback),
          toolMessages:
            !memoryChanged && purpose.kind === "lookup"
              ? (answer?.response?.toolMessages ?? [])
              : [],
          details: { kind: "main_chat_result", purpose, chat_error: chatError },
        };
      },
      (user, assistant) => publish?.(purpose.kind, user, assistant, chatError),
    );
    return { ...result, purpose, chatError } as const;
  }

  #acceptInput(request: ChatInput, signal?: AbortSignal): AcceptedTurn {
    throwIfAborted(signal);
    const contextRevision = this.#conversation.getMemoryContextRevision();
    const userMessage = this.#conversation.appendChatMessage({
      role: "user",
      content: request.text,
      details: {
        kind: "user_input",
        requested_focus_bucket_id: request.focusBucketId ?? null,
      },
    });
    return { sourceText: request.text, userMessage, contextRevision };
  }

  async #chat(
    request: ChatInput,
    signal?: AbortSignal,
    publish?: TurnPublished,
  ) {
    const turn = this.#acceptInput(request, signal);
    const { userMessage } = turn;

    let execution: ArchiveExecution;
    try {
      // Focus is recorded for UX/audit, but chat auto-classification
      // still uses the server-owned candidate set rather than a UI hint.
      execution = await this.#runtime.archiveText(
        request.text,
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException("operation cancelled", "AbortError");
      this.#throwChatFailure(request.text, userMessage, error);
    }

    let archive: ChatArchive = decorateChatArchive(
      projectArchiveExecution(this.#store, execution),
    );
    // Archive is already committed, so an answer failure preserves its
    // truthful fallback and does not roll back the archive.
    const answer = await this.#tryAnswer(turn, { archive }, signal);
    let chatError = answer.error;
    const result = this.#appendReplies(
      turn,
      (memoryChanged) => {
        if (memoryChanged) {
          chatError = MEMORY_CHANGED;
          archive = this.#currentArchive(archive);
        }
        const pending = archive.archive_state === "needs_confirmation";
        return {
          assistantText: memoryChanged
            ? MEMORY_CHANGED
            : ((!pending ? answer.response?.assistantText : undefined) ??
              archiveAssistantText(archive)),
          toolMessages: memoryChanged
            ? []
            : (answer.response?.toolMessages ?? []),
          details: {
            kind: "archive_result",
            source_text: request.text,
            archive,
            pending_confirmation: pending,
            chat_error: chatError,
          },
        };
      },
      (user, assistant) => publish?.("archive", user, assistant, chatError),
    );
    return { ...result, archive, chatError } as const;
  }

  async #tryAnswer(
    turn: AcceptedTurn,
    mode:
      | { readonly archive: ChatArchive }
      | { readonly archive: null; readonly purpose: "answer" | "lookup" },
    signal?: AbortSignal,
  ): Promise<AnswerAttempt> {
    const responder = this.#chatResponder;
    // Fix history at this admitted user message; do not see later turns.
    const history = this.#conversation.listModelChatMessages(
      CHAT_HISTORY_LIMIT,
      turn.userMessage.sequence,
    );
    if (
      responder === undefined ||
      turn.contextRevision !== this.#conversation.getMemoryContextRevision()
    )
      return { error: null };
    const input: ChatResponderInput = {
      ...mode,
      sourceText: turn.sourceText,
      history,
      ...(signal === undefined ? {} : { signal }),
    };
    try {
      const response = await withCancellation(signal, () =>
        responder.respond(input),
      );
      return { response, error: null };
    } catch (error) {
      return {
        error:
          signal?.aborted || isAbortError(error)
            ? null
            : chatFailureMessage(error),
      };
    }
  }

  #appendReplies(
    turn: AcceptedTurn,
    build: (memoryChanged: boolean) => {
      readonly assistantText: string;
      readonly toolMessages: readonly ChatToolMessage[];
      readonly details: Readonly<Record<string, unknown>>;
    },
    publish?: (user: ChatMessageRow, assistant: ChatMessageRow) => void,
  ) {
    let publishedTools: readonly ChatToolMessage[] = [];
    const replies = this.#conversation.appendChatTurnResults(
      turn.userMessage.id,
      () => {
        // Check the fence inside the same transaction that publishes the replies.
        const reply = build(
          turn.contextRevision !==
            this.#conversation.getMemoryContextRevision(),
        );
        publishedTools = reply.toolMessages;
        return [
          ...reply.toolMessages.map((tool) => ({
            role: "tool" as const,
            content: JSON.stringify(tool.output),
            toolName: tool.name,
            toolCallId: tool.callId,
            details: {
              kind: "agent_tool",
              arguments: tool.arguments,
              output: tool.output,
            },
          })),
          {
            role: "assistant",
            content: reply.assistantText,
            details: reply.details,
          },
        ];
      },
      (rows) => {
        const assistant = rows.at(-1);
        if (assistant !== undefined) publish?.(turn.userMessage, assistant);
      },
    );
    const assistantMessage = replies.at(-1);
    if (assistantMessage === undefined)
      throw new Error("missing conversation reply");
    return {
      userMessage: turn.userMessage,
      toolMessages: publishedTools,
      assistantMessage,
      messages: [turn.userMessage, ...replies],
    } as const;
  }

  confirmChat(request: RuntimeConfirmationRequest, signal?: AbortSignal) {
    return this.#turns.run(() => this.#confirmChat(request, signal), signal);
  }

  async #confirmChat(
    request: RuntimeConfirmationRequest,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    const confirmationText = confirmationUserText(request);
    this.#validateConfirmationBoundary(request);
    const contextRevision = this.#conversation.getMemoryContextRevision();
    const userMessage = this.#conversation.appendChatMessage({
      role: "user",
      content: confirmationText,
      details: {
        kind: "archive_confirmation",
        confirmation_action: request.action,
        source_text: request.rawText,
        attempt_id: request.attemptId,
        source_attempt_id: request.attemptId,
      },
    });

    let execution: ConfirmationExecution;
    try {
      execution = await this.#runtime.confirm(request, signal);
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException("operation cancelled", "AbortError");
      this.#throwConfirmationFailure(request, userMessage, error);
    }
    const confirmationArchive = this.#projectConfirmation(
      execution,
      request.attemptId,
    );
    let archive:
      | typeof confirmationArchive
      | (ChatArchive & { readonly result_attempt_id: string | null }) =
      confirmationArchive;
    const resultAttemptId =
      execution.result.archiveState === "discarded"
        ? null
        : execution.result.attemptId;
    const [assistantMessage] = this.#conversation.appendChatTurnResults(
      userMessage.id,
      () => {
        const changed =
          contextRevision !== this.#conversation.getMemoryContextRevision();
        if (changed && confirmationArchive.archive_state !== "discarded") {
          archive = {
            ...this.#currentArchive(confirmationArchive),
            result_attempt_id: resultAttemptId,
          };
        }
        return [
          {
            role: "assistant",
            content:
              changed && archive.archive_state !== "discarded"
                ? "记忆已更新，请重新提问。"
                : confirmationAssistantText(request.action, archive),
            details: {
              kind: "archive_confirmation_result",
              confirmation_action: request.action,
              source_text: request.rawText,
              attempt_id: request.attemptId,
              source_attempt_id: request.attemptId,
              result_attempt_id: resultAttemptId,
              archive,
              pending_confirmation: false,
            },
          },
        ];
      },
    );
    if (assistantMessage === undefined)
      throw new Error("missing confirmation reply");
    return {
      archive,
      action: request.action,
      sourceAttemptId: request.attemptId,
      resultAttemptId,
      userMessage,
      assistantMessage,
    } as const;
  }

  #validateConfirmationBoundary(request: RuntimeConfirmationRequest): void {
    this.#store.requirePendingArchiveAttempt(
      request.attemptId,
      request.rawText,
    );
    if (request.action === "append") {
      const bucket = this.#store.getBucket(request.targetBucketId);
      if (bucket === undefined) {
        throw StorageError.missingRecord("buckets", request.targetBucketId);
      }
      if (bucket.lifecycle !== BucketStatus.Active) {
        throw StorageError.inactiveBucket(request.targetBucketId);
      }
    }
  }

  #projectConfirmation(
    execution: ConfirmationExecution,
    sourceAttemptId: string,
  ) {
    if ("attemptId" in execution.result) {
      const archiveExecution: ArchiveExecution = {
        result: execution.result,
        candidates: execution.candidates,
        bucket: execution.bucket,
      };
      const projected = projectArchiveExecution(this.#store, archiveExecution);
      return {
        ...projected,
        source_attempt_id: sourceAttemptId,
        result_attempt_id: execution.result.attemptId,
      } as const;
    }
    return {
      ok: true,
      attempt_id: sourceAttemptId,
      archive_state: "discarded",
      bucket_id: null,
      entry_id: null,
      memory_item_ids: [],
      source_attempt_id: sourceAttemptId,
      result_attempt_id: null,
    } as const;
  }

  #currentArchive(archive: ChatArchive): ChatArchive {
    const revocation =
      archive.entry_id === null
        ? undefined
        : this.#store.getEntryRevocation(archive.entry_id);
    const deleted =
      archive.entry_id !== null &&
      revocation === undefined &&
      this.#store.getEntry(archive.entry_id) === undefined;
    return {
      ...archive,
      bucket:
        archive.bucket_id === null
          ? null
          : (() => {
              const bucket = this.#store.getBucket(archive.bucket_id);
              return bucket === undefined ? null : projectBucket(bucket);
            })(),
      ...(revocation !== undefined
        ? {
            archive_state: "revoked" as const,
            revoked_at: revocation.revokedAt,
            extraction: null,
            memory_item_ids: [],
            available_actions: [],
          }
        : deleted
          ? {
              archive_state: "deleted" as const,
              extraction: null,
              memory_item_ids: [],
              available_actions: [],
            }
          : {}),
    };
  }

  #throwChatFailure(
    sourceText: string,
    userMessage: ChatMessageRow,
    error: unknown,
  ): never {
    this.#persistFailure(userMessage, error, "我暂时无法完成这次归档", {
      source_text: sourceText,
    });
  }

  #throwConfirmationFailure(
    request: RuntimeConfirmationRequest,
    userMessage: ChatMessageRow,
    error: unknown,
  ): never {
    this.#persistFailure(userMessage, error, "我暂时无法完成这次确认", {
      confirmation_action: request.action,
      source_text: request.rawText,
      attempt_id: request.attemptId,
    });
  }

  #persistFailure(
    userMessage: ChatMessageRow,
    error: unknown,
    prefix: string,
    details: Readonly<Record<string, string>>,
  ): never {
    if (error instanceof StorageError && error.kind === "storage_unavailable")
      throw error;
    const message = chatFailureMessage(error);
    let assistantMessage: ChatMessageRow | undefined;
    try {
      [assistantMessage] = this.#conversation.appendChatTurnResults(
        userMessage.id,
        () => [
          {
            role: "assistant",
            content: `${prefix}：${message}`,
            details: { kind: "chat_error", ...details, error: message },
          },
        ],
      );
    } catch (writeError) {
      if (
        writeError instanceof StorageError &&
        writeError.kind === "storage_unavailable"
      )
        throw writeError;
      // The accepted user message survives a failure to write the explanation.
    }
    throw new ChatFailure(message, userMessage, assistantMessage);
  }
}

function mainChatFallback(purpose: ChatPurpose): string {
  if (purpose.kind === "clarify") {
    switch (purpose.reason) {
      case "target":
        return "你指的是哪个任务或文件？请给出名称或贴出要修改的段落。";
      case "explicit_confirmation":
        return "如果你要确认保存或批准执行，请使用对应的确认卡片。";
      case "mixed":
        return "这条消息里有多个要求。你想先处理哪一件？";
      case "purpose":
        return "你希望我回答问题、查找记录，还是把这段内容存下来？";
    }
  }
  if (purpose.kind === "propose_execution")
    return "这需要先指定工作目标并通过任务入口提交只读检查申请。";
  return "我暂时无法回答这条消息，请稍后重试。";
}

function decorateChatArchive(
  archive: ReturnType<typeof projectArchiveExecution>,
) {
  if (archive["archive_state"] === "needs_confirmation") {
    return {
      ...archive,
      available_actions: [
        "append_recommended",
        "append_alternative",
        "create_new",
        "discard",
      ] as const,
      confirmation_options: {
        recommended: "append_recommended",
        alternative: "append_alternative",
        create: "create_new",
        discard: "discard",
      },
    };
  }
  if (archive["archive_state"] === "archived" && archive["entry_id"] != null) {
    return {
      ...archive,
      available_actions: ["move_entry", "revoke_entry"] as const,
    };
  }
  return archive;
}

function archiveAssistantText(
  archive: Readonly<Record<string, unknown>>,
): string {
  switch (archive["archive_state"]) {
    case "archived": {
      const bucket = cloneRecord(archive["bucket"]);
      const extraction = cloneRecord(archive["extraction"]);
      const title =
        stringValue(bucket?.["title"]) ??
        stringValue(archive["bucket_title"]) ??
        "目标 Bucket";
      const summary = stringValue(extraction?.["summary"]);
      return summary === undefined
        ? `已将这条内容归档到「${title}」。`
        : `已将这条内容归档到「${title}」。\n摘要：${summary}`;
    }
    case "needs_confirmation": {
      const recommended = cloneRecord(archive["recommended_bucket"]);
      const title =
        stringValue(recommended?.["title"]) ??
        stringValue(archive["bucket_title"]) ??
        "模型推荐的 Bucket";
      const reason =
        stringValue(archive["reason"]) ?? "信息不足以安全确定归档位置。";
      const question = stringValue(archive["question"]) ?? "请选择归档方式。";
      const alternatives = Array.isArray(archive["candidate_buckets"])
        ? archive["candidate_buckets"]
            .map(cloneRecord)
            .filter((candidate) => candidate?.["is_recommended"] !== true)
            .flatMap((candidate) => {
              const candidateTitle = stringValue(candidate?.["title"]);
              return candidateTitle === undefined ? [] : [candidateTitle];
            })
        : [];
      const alternativeHint =
        alternatives.length === 0
          ? "可以从活跃 Bucket 中选择其他目标。"
          : `候选还包括：${alternatives.join("、")}。`;
      return `我认为这条内容可能属于「${title}」，但信息不够明确。\n模型判断理由：${reason}\n${question}\n推荐 Bucket：${title}\n备选 Bucket：${alternativeHint}\n请选择：\n1. 保存到「${title}」\n2. 保存到其他 Bucket\n3. 创建新的 Bucket\n4. 不保存\n如果之后需要调整，也可以使用“修改 Bucket”入口。`;
    }
    case "discarded":
      return "这条内容没有保存为正式 Entry。";
    default:
      return "已处理这条内容，但没有返回归档状态。";
  }
}

function confirmationUserText(request: RuntimeConfirmationRequest): string {
  switch (request.action) {
    case "append":
      return `确认保存到 Bucket ${request.targetBucketId}`;
    case "create":
      return `确认创建新 Bucket「${request.title}」`;
    case "discard":
      return "确认不保存这条内容";
  }
}

function confirmationAssistantText(
  action: RuntimeConfirmationRequest["action"],
  archive: Readonly<Record<string, unknown>>,
): string {
  if (action === "discard") {
    return "好的，这条内容不会保存为正式 Entry。";
  }
  const bucket = cloneRecord(archive["bucket"]);
  const title =
    stringValue(bucket?.["title"]) ??
    stringValue(archive["bucket_title"]) ??
    (action === "append" ? "所选 Bucket" : "新 Bucket");
  return action === "append"
    ? `已根据你的确认保存到「${title}」。`
    : `已根据你的确认创建 Bucket「${title}」，并保存这条 Entry。`;
}

function cloneRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function chatFailureMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "request body is invalid";
  if (error instanceof StorageError) {
    switch (error.kind) {
      case "foreign_database":
      case "unsupported_schema_version":
      case "pragma_not_applied":
        return "storage operation failed";
      default:
        return error.message;
    }
  }
  if (
    error instanceof DomainError ||
    error instanceof LlmError ||
    error instanceof ApplicationError ||
    error instanceof HarnessError ||
    error instanceof AgentError ||
    error instanceof TaskError ||
    error instanceof WorkItemError ||
    error instanceof CorrectionError ||
    error instanceof MemoryQueryError
  )
    return error.message;
  return "internal server error";
}
