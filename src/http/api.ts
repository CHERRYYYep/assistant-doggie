/** Concrete application composition behind the local HTTP routes. */

import type { ArchiveRuntime } from "../application/archive-runtime.ts";
import { projectArchiveExecution } from "../application/archive-view.ts";
import { ChatService } from "../application/chat.ts";
import {
  ChatFailure,
  type ChatResponder,
  type ChatToolMessage,
} from "../application/chat-types.ts";
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
import { StorageError } from "../storage/database.ts";
import type { ChatMessageRow, Store } from "../storage/store.ts";
import type { DoggieHttpApi } from "./app.ts";
import {
  HttpBoundaryError,
  jsonDetails,
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

export type { ChatResponder } from "../application/chat-types.ts";

export type ConcreteDoggieHttpApiOptions = {
  readonly clock?: (() => Date) | undefined;
  readonly chatResponder?: ChatResponder | undefined;
  readonly chatService?: ChatService;
};

export class ConcreteDoggieHttpApi implements DoggieHttpApi {
  readonly #store: Store;
  readonly #runtime: ArchiveRuntime;
  readonly #query: MemoryQueryService;
  readonly #correction: CorrectionService;
  readonly #status: BucketStatusService;
  readonly #todo: TodoService;
  readonly #clock: () => Date;
  readonly #chat: ChatService;

  constructor(
    store: Store,
    runtime: ArchiveRuntime,
    options: ConcreteDoggieHttpApiOptions = {},
  ) {
    this.#store = store;
    this.#runtime = runtime;
    this.#clock = options.clock ?? (() => new Date());
    this.#query = new MemoryQueryService(store.memory, this.#clock);
    this.#correction = new CorrectionService(store);
    this.#status = new BucketStatusService(store);
    this.#todo = new TodoService(store, this.#clock);
    this.#chat =
      options.chatService ??
      new ChatService(store, runtime, options.chatResponder);
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
      messages: this.#store.conversation
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
    return projectArchiveExecution(
      this.#store,
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
    try {
      const result = await this.#chat.chat(
        { text: request.message, focusBucketId: request.focus_bucket_id },
        signal,
      );
      return {
        ok: true,
        archive: result.archive,
        archive_state: result.archive.archive_state,
        user_message: projectChatMessage(result.userMessage),
        tool_messages: result.toolMessages.map(projectChatToolMessage),
        assistant_message: projectChatMessage(result.assistantMessage),
        messages: result.messages.map(projectChatMessage),
        chat_error: result.chatError,
      };
    } catch (error) {
      rethrowChatFailure(error);
    }
  }

  async confirmChat(
    request: ChatConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<ChatConfirmationResponse> {
    try {
      const result = await this.#chat.confirmChat(
        toRuntimeConfirmation(request),
        signal,
      );
      const user = projectChatMessage(result.userMessage);
      const assistant = projectChatMessage(result.assistantMessage);
      return {
        ok: true,
        confirmation_action: result.action,
        archive: result.archive,
        archive_state: result.archive.archive_state,
        source_attempt_id: result.sourceAttemptId,
        result_attempt_id: result.resultAttemptId,
        user_message: user,
        assistant_message: assistant,
        messages: [user, assistant],
      };
    } catch (error) {
      rethrowChatFailure(error);
    }
  }

  async appendConfirmed(
    request: ArchiveRequest & { readonly bucket_id: string },
    signal?: AbortSignal,
  ): Promise<ArchiveResponse> {
    return projectArchiveExecution(
      this.#store,
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
    return projectArchiveExecution(
      this.#store,
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
      const bucket = this.#store.getBucket(attempt.bucketId);
      if (bucket !== undefined) {
        archive["bucket"] = projectBucket(bucket);
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

function rethrowChatFailure(error: unknown): never {
  if (!(error instanceof ChatFailure)) throw error;
  throw new HttpBoundaryError(500, error.message, {
    user_message: projectChatMessage(error.userMessage),
    ...(error.assistantMessage === undefined
      ? {}
      : {
          assistant_message: projectChatMessage(error.assistantMessage),
        }),
  });
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
