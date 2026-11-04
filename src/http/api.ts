import {
  throwIfAborted,
  withCancellation,
  isAbortError,
} from "../llm/cancellation.ts";
/** Concrete application composition behind the local HTTP routes. */

import {
  ArchiveRuntime,
  type ArchiveExecution,
  type ConfirmationExecution,
} from "../application/archive-runtime.ts";
import { CorrectionService } from "../application/correction.ts";
import {
  MemoryQueryError,
  createStructuredFieldFilter,
  createTimeRange,
  parseMemoryQuery,
  withMemoryQueryOverrides,
} from "../application/memory-query.ts";
import { MemoryQueryService } from "../application/query.ts";
import { BucketStatusService } from "../application/status.ts";
import { TodoService } from "../application/todo.ts";
import type { JsonValue } from "../storage/store.ts";
import { BucketStatus } from "../domain/types.ts";
import { StorageError } from "../storage/database.ts";
import type { ChatMessageRow, Store } from "../storage/store.ts";
import type { DoggieHttpApi } from "./app.ts";
import {
  HttpBoundaryError,
  jsonDetails,
  normalizeHttpError,
  projectArchive,
  projectBucket,
  projectBucketDetail,
  projectChatMessage,
  projectEntry,
  projectMemoryQuery,
  projectTodo,
  type ArchiveRequest,
  type BucketStatusRequest,
  type ChatConfirmationRequest,
  type ChatRequest,
  type MemoryQueryRequest,
  type MoveEntryRequest,
  type TodoAgendaQuery,
  type TodoAdvanceRequest,
  type TodoPlanRequest,
  type TodoReopenRequest,
  type TodoTransitionRequest,
} from "./contracts.ts";
import type {
  ActiveBucketsResponse,
  ArchiveDto,
  ArchiveResponse,
  BucketDetailResponse,
  BucketSearchResponse,
  BucketStatusResponse,
  ChatConfirmationResponse,
  ChatHistoryResponse,
  ChatResponse as HttpChatResponse,
  DeleteBucketResponse,
  EntryRevocationResponse,
  MemoryQueryResponse,
  MoveEntryResponse,
  AgendaResponse,
  TodoMutationResponse,
  TodoResponse,
} from "./dto.ts";

export const CHAT_HISTORY_LIMIT = 40;

export type ChatToolMessage = {
  readonly name: string;
  readonly callId: string;
  readonly arguments: JsonValue;
  readonly output: JsonValue;
};

export type ChatResponse = {
  readonly assistantText: string;
  readonly toolMessages?: readonly ChatToolMessage[];
};

export type ChatResponder = {
  readonly respond: (request: {
    readonly sourceText: string;
    readonly history: readonly ChatMessageRow[];
    readonly archive: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }) => Promise<ChatResponse>;
};

export type ConcreteDoggieHttpApiOptions = {
  readonly clock?: (() => Date) | undefined;
  readonly chatResponder?: ChatResponder | undefined;
};

export class ConcreteDoggieHttpApi implements DoggieHttpApi {
  readonly #store: Store;
  readonly #runtime: ArchiveRuntime;
  readonly #query: MemoryQueryService;
  readonly #correction: CorrectionService;
  readonly #status: BucketStatusService;
  readonly #todo: TodoService;
  readonly #clock: () => Date;
  readonly #chatResponder: ChatResponder | undefined;

  constructor(
    store: Store,
    runtime: ArchiveRuntime,
    options: ConcreteDoggieHttpApiOptions = {},
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#clock = options.clock ?? (() => new Date());
    this.#query = new MemoryQueryService(store, this.#clock);
    this.#correction = new CorrectionService(store);
    this.#status = new BucketStatusService(store);
    this.#todo = new TodoService(store, this.#clock);
    this.#chatResponder = options.chatResponder;
  }

  activeBuckets(limit: number): ActiveBucketsResponse {
    return {
      ok: true,
      buckets: this.#store.listActiveBuckets(limit).map(projectBucket),
    } as const;
  }

  searchBuckets(query: string, limit: number): BucketSearchResponse {
    return {
      ok: true,
      results: this.#store.searchBuckets(query, limit).map((hit) => ({
        bucket: projectBucket(hit.bucket),
        matched_entry_count: hit.matchedEntryCount,
        score: hit.score,
      })),
    } as const;
  }

  chatHistory(limit: number): ChatHistoryResponse {
    return {
      ok: true,
      messages: this.#store
        .listChatMessages(limit)
        .map((message) => this.#hydrateChatMessage(message)),
    } as const;
  }

  memoryQuery(query: string, limit: number): MemoryQueryResponse {
    return projectMemoryQuery(this.#query.search(query, limit));
  }

  memoryQueryJson(request: MemoryQueryRequest): MemoryQueryResponse {
    const now = this.#clock();
    const base = parseMemoryQuery(request.query, request.limit, now);
    const hasStart = request.start_at !== undefined;
    const hasEnd = request.end_at !== undefined;
    if (hasStart !== hasEnd) {
      throw new MemoryQueryError(
        "invalid_time_range",
        "start_at and end_at must be provided together",
      );
    }
    const plan = withMemoryQueryOverrides(base, {
      timeRange:
        hasStart && hasEnd
          ? createTimeRange(request.start_at!, request.end_at!, "explicit")
          : base.timeRange,
      statuses:
        request.statuses.length === 0 ? base.statuses : request.statuses,
      structuredFilters: request.filters.map((filter) =>
        createStructuredFieldFilter(filter.field, filter.value),
      ),
    });
    return projectMemoryQuery(this.#query.searchWithPlan(plan, now));
  }

  bucketDetail(bucketId: string): BucketDetailResponse {
    const detail = this.#store.getBucketDetail(bucketId);
    if (detail === undefined) {
      throw StorageError.missingRecord("buckets", bucketId);
    }
    return { ok: true, detail: projectBucketDetail(detail) } as const;
  }

  deleteBucket(bucketId: string): DeleteBucketResponse {
    const result = this.#correction.deleteBucket(
      bucketId,
      "Delete Bucket through Doggie API.",
    );
    return {
      ok: true,
      bucket_id: result.bucketId,
      deleted_entry_ids: [...result.deletedEntryIds],
      deleted_memory_item_ids: [...result.deletedMemoryItemIds],
      updated_archive_attempt_ids: [...result.updatedArchiveAttemptIds],
      correction_id: result.correctionId,
    } as const;
  }

  revokeEntry(entryId: string): EntryRevocationResponse {
    const result = this.#correction.deleteEntry(
      entryId,
      "用户撤销 Entry；聊天和审计保留。",
    );
    return {
      ok: true,
      entry_id: result.entryId,
      bucket_id: result.bucketId,
      correction_id: result.correctionId,
      revoked_at: result.revokedAt,
      memory_item_ids: [...result.memoryItemIds],
    };
  }

  async archive(
    request: ArchiveRequest,
    signal?: AbortSignal,
  ): Promise<ArchiveResponse> {
    return this.#projectExecution(
      await this.#runtime.archiveText(
        request.text,
        request.focus_bucket_id,
        signal,
      ),
    );
  }

  async chat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<HttpChatResponse> {
    throwIfAborted(signal);
    const contextRevision = this.#store.getMemoryContextRevision();
    const userMessage = this.#store.appendChatMessage({
      role: "user",
      content: request.message,
      details: {
        kind: "user_input",
        requested_focus_bucket_id: request.focus_bucket_id ?? null,
      },
    });

    let execution: ArchiveExecution;
    try {
      // Focus is recorded for UX/audit, but chat auto-classification
      // still uses the server-owned candidate set rather than a UI hint.
      execution = await this.#runtime.archiveText(
        request.message,
        undefined,
        signal,
      );
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException("operation cancelled", "AbortError");
      this.#throwChatFailure(request.message, userMessage, error);
    }

    let archive: ArchiveResponse = decorateChatArchive(
      this.#projectExecution(execution!),
    );
    const history = this.#store.listModelChatMessages(CHAT_HISTORY_LIMIT);
    let assistantText = archiveAssistantText(archive);
    let toolMessages: readonly ChatToolMessage[] = [];
    let chatError: string | null = null;
    if (
      this.#chatResponder !== undefined &&
      contextRevision === this.#store.getMemoryContextRevision()
    ) {
      try {
        const responder = this.#chatResponder;
        const response = await withCancellation(signal, () =>
          responder.respond({
            sourceText: request.message,
            history,
            archive,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        toolMessages = response.toolMessages ?? [];
        if (archive.archive_state !== "needs_confirmation") {
          assistantText = response.assistantText;
        }
      } catch (error) {
        // Archive is already committed. Persist its truthful fallback/audit,
        // not late model tool messages; cancellation cannot undo the archive.
        if (!signal?.aborted && !isAbortError(error))
          chatError = normalizeHttpError(error).message;
      }
    }

    // Old tool results and model answers have no complete dependency graph.
    // A concurrent revocation invalidates this answer before any reply is saved.
    if (contextRevision !== this.#store.getMemoryContextRevision()) {
      toolMessages = [];
      chatError = "记忆已更新，请重新提问。";
      assistantText = chatError;
      archive = this.#currentArchive(archive);
    }

    const persistedMessages: ReturnType<typeof projectChatMessage>[] = [
      projectChatMessage(userMessage),
    ];
    for (const tool of toolMessages) {
      const message = this.#store.appendChatMessage({
        role: "tool",
        content: JSON.stringify(tool.output),
        toolName: tool.name,
        toolCallId: tool.callId,
        details: {
          kind: "agent_tool",
          arguments: tool.arguments,
          output: tool.output,
        },
      });
      persistedMessages.push(projectChatMessage(message));
    }
    const assistantMessage = this.#store.appendChatMessage({
      role: "assistant",
      content: assistantText,
      details: {
        kind: "archive_result",
        source_text: request.message,
        archive,
        pending_confirmation: archive.archive_state === "needs_confirmation",
        chat_error: chatError,
      },
    });
    persistedMessages.push(projectChatMessage(assistantMessage));

    return {
      ok: true,
      archive,
      archive_state: archive.archive_state,
      user_message: projectChatMessage(userMessage),
      tool_messages: toolMessages.map(projectChatToolMessage),
      assistant_message: projectChatMessage(assistantMessage),
      messages: persistedMessages,
      chat_error: chatError,
    } as const;
  }

  async confirmChat(
    request: ChatConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<ChatConfirmationResponse> {
    throwIfAborted(signal);
    const confirmationText = confirmationUserText(request);
    this.#validateConfirmationBoundary(request);
    const userMessage = this.#store.appendChatMessage({
      role: "user",
      content: confirmationText,
      details: {
        kind: "archive_confirmation",
        confirmation_action: request.action,
        source_text: request.text,
        attempt_id: request.attempt_id,
        source_attempt_id: request.attempt_id,
      },
    });

    let execution: ConfirmationExecution;
    try {
      execution = await this.#runtime.confirm(
        toRuntimeConfirmation(request),
        signal,
      );
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException("operation cancelled", "AbortError");
      this.#throwConfirmationFailure(request, userMessage, error);
    }
    const archive = this.#projectConfirmation(execution!, request.attempt_id);
    const resultAttemptId =
      execution!.result.archiveState === "discarded"
        ? null
        : execution!.result.attemptId;
    const assistantMessage = this.#store.appendChatMessage({
      role: "assistant",
      content: confirmationAssistantText(request.action, archive),
      details: {
        kind: "archive_confirmation_result",
        confirmation_action: request.action,
        source_text: request.text,
        attempt_id: request.attempt_id,
        source_attempt_id: request.attempt_id,
        result_attempt_id: resultAttemptId,
        archive,
        pending_confirmation: false,
      },
    });
    return {
      ok: true,
      confirmation_action: request.action,
      archive,
      archive_state: archive.archive_state,
      source_attempt_id: request.attempt_id,
      result_attempt_id: resultAttemptId,
      user_message: projectChatMessage(userMessage),
      assistant_message: projectChatMessage(assistantMessage),
      messages: [
        projectChatMessage(userMessage),
        projectChatMessage(assistantMessage),
      ],
    } as const;
  }

  async appendConfirmed(
    request: ArchiveRequest & { readonly bucket_id: string },
    signal?: AbortSignal,
  ): Promise<ArchiveResponse> {
    return this.#projectExecution(
      await this.#runtime.appendConfirmed(
        request.text,
        request.bucket_id,
        request.focus_bucket_id,
        signal,
      ),
    );
  }

  async createConfirmed(
    request: ArchiveRequest & {
      readonly title: string;
      readonly bucket_type: Parameters<ArchiveRuntime["createConfirmed"]>[2];
    },
    signal?: AbortSignal,
  ): Promise<ArchiveResponse> {
    return this.#projectExecution(
      await this.#runtime.createConfirmed(
        request.text,
        request.title,
        request.bucket_type,
        request.focus_bucket_id,
        signal,
      ),
    );
  }

  moveEntry(request: MoveEntryRequest): MoveEntryResponse {
    const result = this.#correction.moveEntry(
      request.entry_id,
      request.target_bucket_id,
      request.command_text,
    );
    return {
      ok: true,
      correction_id: result.correctionId,
      source_bucket_id: result.sourceBucketId,
      target_bucket_id: result.targetBucketId,
      entry: projectEntry(result.entry),
    } as const;
  }

  setBucketStatus(request: BucketStatusRequest): BucketStatusResponse {
    const bucket = this.#status.setStatus(request.bucket_id, request.status);
    return {
      ok: true,
      bucket_id: bucket.id,
      status: bucket.lifecycle,
    } as const;
  }

  agenda(request: TodoAgendaQuery): AgendaResponse {
    const result = this.#todo.listAgenda({
      from: request.from,
      to: request.to,
      bucketId: request.bucket_id,
      includeHistory: request.include_history === "true",
    });
    return {
      ok: true,
      now: result.now,
      todos: result.todos.map(projectTodo),
    } as const;
  }

  getTodo(todoId: string): TodoResponse {
    return { ok: true, todo: projectTodo(this.#todo.getTodo(todoId)) } as const;
  }

  transitionTodo(
    todoId: string,
    request: TodoTransitionRequest,
  ): TodoMutationResponse {
    const result = this.#todo.transitionTodo(
      todoId,
      request.status,
      request.command_text,
      request.expected_updated_at,
    );
    return this.#projectTodoMutation(result);
  }

  updateTodoPlan(
    todoId: string,
    request: TodoPlanRequest,
  ): TodoMutationResponse {
    const result = this.#todo.updateTodoPlan(
      todoId,
      {
        scheduledAt: request.scheduled_at,
        dueAt: request.due_at,
        repeatRule:
          request.repeat_rule === null
            ? null
            : {
                frequency: request.repeat_rule.frequency,
                interval: request.repeat_rule.interval,
                weekdays: request.repeat_rule.weekdays,
                until: request.repeat_rule.until,
                count: request.repeat_rule.count,
              },
        rawTime:
          request.raw_time === null
            ? null
            : {
                scheduledText: request.raw_time.scheduled_text,
                dueText: request.raw_time.due_text,
                timeZone: request.raw_time.time_zone,
              },
      },
      request.command_text,
      request.expected_updated_at,
    );
    return this.#projectTodoMutation(result);
  }

  advanceTodo(
    todoId: string,
    request: TodoAdvanceRequest,
  ): TodoMutationResponse {
    return this.#projectTodoMutation(
      this.#todo.advanceRepeatingTodo(
        todoId,
        request.command_text,
        request.expected_updated_at,
      ),
    );
  }

  reopenTodo(todoId: string, request: TodoReopenRequest): TodoMutationResponse {
    return this.#projectTodoMutation(
      this.#todo.reopenTodo(
        todoId,
        request.command_text,
        request.expected_updated_at,
      ),
    );
  }

  #projectTodoMutation(result: {
    readonly todo: import("../storage/store.ts").TodoRow;
    readonly correctionId: string;
  }): TodoMutationResponse {
    return {
      ok: true,
      todo: projectTodo(result.todo),
      correction_id: result.correctionId,
    } as const;
  }

  #validateConfirmationBoundary(request: ChatConfirmationRequest): void {
    this.#store.requirePendingArchiveAttempt(request.attempt_id, request.text);
    if (request.action === "append") {
      const bucket = this.#store.getBucket(request.bucket_id);
      if (bucket === undefined) {
        throw StorageError.missingRecord("buckets", request.bucket_id);
      }
      if (bucket.lifecycle !== BucketStatus.Active) {
        throw StorageError.inactiveBucket(request.bucket_id);
      }
    }
  }

  #throwConfirmationFailure(
    request: ChatConfirmationRequest,
    userMessage: ChatMessageRow,
    error: unknown,
  ): never {
    const normalized = normalizeHttpError(error);
    const assistantText = `我暂时无法完成这次确认：${normalized.message}`;
    let assistantMessage: ChatMessageRow | undefined;
    try {
      assistantMessage = this.#store.appendChatMessage({
        role: "assistant",
        content: assistantText,
        details: {
          kind: "chat_error",
          confirmation_action: request.action,
          source_text: request.text,
          attempt_id: request.attempt_id,
          error: normalized.message,
        },
      });
    } catch {
      // Keep the accepted confirmation user message as the hard invariant.
    }
    throw new HttpBoundaryError(500, normalized.message, {
      user_message: projectChatMessage(userMessage),
      ...(assistantMessage === undefined
        ? {}
        : { assistant_message: projectChatMessage(assistantMessage) }),
    });
  }

  #projectExecution(execution: ArchiveExecution) {
    const memoryItemIds =
      execution.result.bucketId === undefined ||
      execution.result.entryId === undefined
        ? []
        : (this.#store
            .getBucketDetail(execution.result.bucketId)
            ?.memories.filter(
              (memory) => memory.entryId === execution.result.entryId,
            )
            .map((memory) => memory.id) ?? []);
    return projectArchive(execution.result, {
      candidates: execution.candidates,
      bucket:
        execution.result.bucketId === undefined
          ? undefined
          : this.#store.getBucket(execution.result.bucketId),
      memoryItemIds,
    });
  }

  #projectConfirmation(
    execution: ConfirmationExecution,
    sourceAttemptId: string,
  ): ArchiveDto {
    if ("attemptId" in execution.result) {
      const archiveExecution: ArchiveExecution = {
        result: execution.result,
        candidates: execution.candidates,
        bucket: execution.bucket,
      };
      const projected = this.#projectExecution(archiveExecution);
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

  #hydrateChatMessage(message: ChatMessageRow) {
    const projected = projectChatMessage(message);
    const details = cloneRecord(projected.details);
    const archive = cloneRecord(details?.["archive"]);
    if (details !== undefined && archive !== undefined) {
      const entryId = archive["entry_id"];
      if (typeof entryId === "string") {
        const revocation = this.#store.getEntryRevocation(entryId);
        if (revocation !== undefined) {
          archive["archive_state"] = "revoked";
          archive["revoked_at"] = revocation.revokedAt;
          archive["memory_item_ids"] = [];
          archive["extraction"] = null;
          archive["available_actions"] = [];
          archive["pending_confirmation"] = false;
          delete archive["confirmation_options"];
          details["archive"] = archive;
          details["pending_confirmation"] = false;
          return { ...projected, details };
        }
        const current = this.#store.getEntry(entryId);
        if (current !== undefined) {
          archive["bucket_id"] = current.bucketId;
          const bucket = this.#store.getBucket(current.bucketId);
          archive["bucket"] =
            bucket === undefined ? null : projectBucket(bucket);
          archive["available_actions"] = ["move_entry", "revoke_entry"];
          details["archive"] = archive;
        } else {
          archive["archive_state"] = "deleted";
          archive["available_actions"] = [];
          archive["pending_confirmation"] = false;
          details["archive"] = archive;
          details["pending_confirmation"] = false;
          return { ...projected, details };
        }
      }
    }
    if (
      details === undefined ||
      archive === undefined ||
      archive["archive_state"] !== "needs_confirmation" ||
      typeof archive["attempt_id"] !== "string"
    ) {
      return details === undefined ? projected : { ...projected, details };
    }
    const attempt = this.#store.getArchiveAttempt(archive["attempt_id"]);
    if (
      attempt === undefined ||
      (attempt.archiveState === "needs_confirmation" && !attempt.corrected)
    ) {
      return projected;
    }
    archive["archive_state"] = attempt.archiveState;
    archive["bucket_id"] = attempt.bucketId;
    archive["entry_id"] = attempt.entryId;
    archive["pending_confirmation"] = false;
    if (attempt.archiveState === "archived" && attempt.bucketId !== null) {
      const detail = this.#store.getBucketDetail(attempt.bucketId);
      if (detail !== undefined) {
        archive["bucket"] = projectBucket(detail.bucket);
        archive["available_actions"] = ["move_entry", "revoke_entry"];
      } else {
        delete archive["available_actions"];
      }
    } else {
      delete archive["available_actions"];
      delete archive["confirmation_options"];
    }
    details["archive"] = archive;
    details["pending_confirmation"] = false;
    return { ...projected, details } as const;
  }

  #currentArchive(archive: ArchiveResponse): ArchiveResponse {
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
    const normalized = normalizeHttpError(error);
    const assistantText = `我暂时无法完成这次归档：${normalized.message}`;
    let assistantMessage: ChatMessageRow | undefined;
    try {
      assistantMessage = this.#store.appendChatMessage({
        role: "assistant",
        content: assistantText,
        details: {
          kind: "chat_error",
          source_text: sourceText,
          error: normalized.message,
        },
      });
    } catch {
      // The accepted user message remains the primary invariant even if the
      // best-effort explanatory assistant message cannot be persisted.
    }
    throw new HttpBoundaryError(500, normalized.message, {
      user_message: projectChatMessage(userMessage),
      ...(assistantMessage === undefined
        ? {}
        : { assistant_message: projectChatMessage(assistantMessage) }),
    });
  }
}

function toRuntimeConfirmation(request: ChatConfirmationRequest) {
  switch (request.action) {
    case "append":
      return {
        action: "append" as const,
        attemptId: request.attempt_id,
        rawText: request.text,
        targetBucketId: request.bucket_id,
        ...(request.focus_bucket_id === undefined
          ? {}
          : { focusBucketId: request.focus_bucket_id }),
      };
    case "create":
      return {
        action: "create" as const,
        attemptId: request.attempt_id,
        rawText: request.text,
        title: request.title,
        bucketType: request.bucket_type,
        ...(request.focus_bucket_id === undefined
          ? {}
          : { focusBucketId: request.focus_bucket_id }),
      };
    case "discard":
      return {
        action: "discard" as const,
        attemptId: request.attempt_id,
        rawText: request.text,
      };
  }
}

function decorateChatArchive<T extends Readonly<Record<string, unknown>>>(
  archive: T,
): T & Readonly<Record<string, unknown>> {
  if (archive["archive_state"] === "needs_confirmation") {
    return {
      ...archive,
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
    };
  }
  if (archive["archive_state"] === "archived" && archive["entry_id"] != null) {
    return { ...archive, available_actions: ["move_entry", "revoke_entry"] };
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

function confirmationUserText(request: ChatConfirmationRequest): string {
  switch (request.action) {
    case "append":
      return `确认保存到 Bucket ${request.bucket_id}`;
    case "create":
      return `确认创建新 Bucket「${request.title}」`;
    case "discard":
      return "确认不保存这条内容";
  }
}

function confirmationAssistantText(
  action: ChatConfirmationRequest["action"],
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

function projectChatToolMessage(message: ChatToolMessage) {
  return {
    name: message.name,
    call_id: message.callId,
    arguments: message.arguments,
    output: message.output,
  } as const;
}

function cloneRecord(value: unknown): { [key: string]: JsonValue } | undefined {
  const json = jsonDetails(value);
  return json !== null && typeof json === "object" && !Array.isArray(json)
    ? ({ ...json } as { [key: string]: JsonValue })
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
