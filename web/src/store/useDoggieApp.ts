import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentBackend, AgentTask, AgentWorkspace } from "../../../src/domain/agent.ts";
import type { TaskSnapshot } from "../../../src/domain/task.ts";
import type { WorkItem } from "../../../src/domain/work-item.ts";
import type {
  ChatConfirmationRequest,
  ConversationTurnRequest,
  TodoPlanRequest,
  TodoTransitionRequest,
} from "../../../src/http/contracts.ts";
import type {
  BucketDetailResponse,
  BucketDto,
  ConversationInteractionListResponse,
  MemoryQueryResponse,
  TodoDto,
  UiChatMessageDto,
} from "../../../src/http/dto.ts";
import {
  ApiRequestError,
  createWorkItem,
  deleteBucketRequest,
  fetchActiveBuckets,
  fetchAgentCapabilities,
  fetchAgentTasks,
  fetchAgentWorkspaces,
  fetchAgenda,
  fetchBucketDetail,
  fetchChatHistory,
  fetchConversationInteractions,
  fetchMemoryQuery,
  fetchTasks,
  fetchWorkItems,
  isConflictError,
  isTerminalTask,
  postAgentAction,
  postAgentProposal,
  postChatConfirmation,
  postConversationTurn,
  postEntryMove,
  postTask,
  postTaskCancel,
  postTodoAdvance,
  postTodoPlan,
  postTodoReopen,
  postTodoTransition,
  postWorkItemAttempt,
  registerAgentWorkspace,
  revokeEntryRequest,
  transitionWorkItem,
  watchTask,
} from "../../assets/api.ts";

export type WorkspaceTab = "chat" | "memory" | "work-items" | "agenda" | "search" | "agents";

export type InspectorTab = "source" | "work-item" | "pending";

export type ConversationInteraction = ConversationInteractionListResponse["interactions"][number];
export type ObservedConversation = ConversationInteractionListResponse["snapshot"];

export type ReplyTarget = {
  readonly interactionId: string;
  readonly revision: number;
  readonly promptMessageId: string | null;
  readonly label: string;
};

export type InspectedSource =
  | {
      readonly kind: "entry";
      readonly bucketId: string;
      readonly entryId: string;
      readonly loading: boolean;
      readonly error: string | null;
      readonly detail: BucketDetailResponse | null;
    }
  | {
      readonly kind: "message";
      readonly messageId: string;
      readonly text: string;
    };

export type StatusBanner = {
  readonly text: string;
  readonly tone: "neutral" | "warning" | "success" | "danger";
};

const PREVIEW_KEY = "doggie.mainConversationPreview";

function readInitialMainMode(): boolean {
  try {
    return sessionStorage.getItem(PREVIEW_KEY) !== "false";
  } catch {
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDoggieApp() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [mainMode, setMainModeState] = useState<boolean>(readInitialMainMode);
  const [status, setStatusState] = useState<StatusBanner | null>(null);

  const [history, setHistory] = useState<readonly UiChatMessageDto[]>([]);
  const [interactions, setInteractions] = useState<readonly ConversationInteraction[]>([]);
  const [observedConversation, setObservedConversation] = useState<ObservedConversation | null>(
    null,
  );

  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [retryTurn, setRetryTurn] = useState<ConversationTurnRequest | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

  const [buckets, setBuckets] = useState<readonly BucketDto[]>([]);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const [bucketDetail, setBucketDetail] = useState<BucketDetailResponse | null>(null);
  const [bucketDetailLoading, setBucketDetailLoading] = useState(false);
  const [bucketDetailError, setBucketDetailError] = useState<string | null>(null);

  const [workItems, setWorkItems] = useState<readonly WorkItem[]>([]);
  const [agenda, setAgenda] = useState<readonly TodoDto[]>([]);
  const [agendaIncludeHistory, setAgendaIncludeHistory] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<MemoryQueryResponse | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [tasks, setTasks] = useState<readonly TaskSnapshot[]>([]);
  const [agentBackends, setAgentBackends] = useState<readonly AgentBackend[]>([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState<readonly AgentWorkspace[]>([]);
  const [agentTasks, setAgentTasks] = useState<readonly AgentTask[]>([]);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("source");
  const [inspectedSource, setInspectedSource] = useState<InspectedSource | null>(null);
  const [inspectedWorkItemId, setInspectedWorkItemId] = useState<string | null>(null);

  const historyRevisionRef = useRef(0);
  const taskControllersRef = useRef(new Map<string, AbortController>());

  const setBanner = useCallback((text: string, tone: StatusBanner["tone"] = "neutral") => {
    setStatusState(text.trim() === "" ? null : { text, tone });
  }, []);

  const refreshBuckets = useCallback(async () => {
    try {
      const res = await fetchActiveBuckets();
      setBuckets(res.buckets);
    } catch (error) {
      setBanner(errorMessage(error), "warning");
    }
  }, [setBanner]);

  const refreshAgenda = useCallback(
    async (includeHistory = agendaIncludeHistory) => {
      try {
        const res = await fetchAgenda(includeHistory);
        setAgenda(res.todos);
        setAgendaIncludeHistory(includeHistory);
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [agendaIncludeHistory, setBanner],
  );

  const refreshWorkItems = useCallback(async () => {
    try {
      const res = await fetchWorkItems();
      setWorkItems(res.workItems);
    } catch (error) {
      setBanner(errorMessage(error), "warning");
    }
  }, [setBanner]);

  const refreshAgents = useCallback(async () => {
    try {
      const [caps, workspaces, agentList] = await Promise.all([
        fetchAgentCapabilities(),
        fetchAgentWorkspaces(),
        fetchAgentTasks(),
      ]);
      setAgentBackends(caps.backends);
      setAgentWorkspaces(workspaces.workspaces);
      setAgentTasks(agentList.tasks);
    } catch (error) {
      setBanner(errorMessage(error), "warning");
    }
  }, [setBanner]);

  const loadHistory = useCallback(
    async (modeOverride?: boolean) => {
      const useMain = modeOverride ?? mainMode;
      const rev = ++historyRevisionRef.current;
      try {
        const [histRes, interRes] = await Promise.all([
          fetchChatHistory(),
          useMain
            ? fetchConversationInteractions().catch((error: unknown) => ({
                error,
              }))
            : Promise.resolve(undefined),
        ]);
        if (rev !== historyRevisionRef.current) return;
        setHistory(histRes.messages);
        if (interRes && "interactions" in interRes) {
          setInteractions(interRes.interactions);
          setObservedConversation(interRes.snapshot);
        } else if (interRes && "error" in interRes) {
          setInteractions([]);
          setObservedConversation(null);
          setBanner(`无法恢复待回复问题，请刷新对话：${errorMessage(interRes.error)}`, "warning");
        }
      } catch (error) {
        if (rev !== historyRevisionRef.current) return;
        setBanner(errorMessage(error), "warning");
      }
    },
    [mainMode, setBanner],
  );

  const observeBackgroundTask = useCallback(
    (initial: TaskSnapshot) => {
      if (isTerminalTask(initial)) return;
      if (taskControllersRef.current.has(initial.id)) return;
      const controller = new AbortController();
      taskControllersRef.current.set(initial.id, controller);
      void watchTask(
        initial,
        (updated) => {
          setTasks((prev) => {
            const exists = prev.some((item) => item.id === updated.id);
            return exists
              ? prev.map((item) => (item.id === updated.id ? updated : item))
              : [updated, ...prev];
          });
        },
        { signal: controller.signal },
      )
        .then(async (terminal) => {
          setTasks((prev) => prev.map((item) => (item.id === terminal.id ? terminal : item)));
          await Promise.all([
            loadHistory(),
            refreshBuckets(),
            refreshAgenda(),
            refreshAgents(),
            refreshWorkItems(),
          ]);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setBanner(errorMessage(error), "warning");
          }
        })
        .finally(() => {
          taskControllersRef.current.delete(initial.id);
        });
    },
    [loadHistory, refreshAgents, refreshAgenda, refreshBuckets, refreshWorkItems, setBanner],
  );

  const refreshTasks = useCallback(async () => {
    try {
      const res = await fetchTasks();
      setTasks(res.tasks);
      for (const task of res.tasks) {
        if (!isTerminalTask(task)) observeBackgroundTask(task);
      }
    } catch (error) {
      setBanner(errorMessage(error), "warning");
    }
  }, [observeBackgroundTask, setBanner]);

  useEffect(() => {
    void Promise.all([
      loadHistory(mainMode),
      refreshBuckets(),
      refreshAgenda(false),
      refreshWorkItems(),
      refreshTasks(),
      refreshAgents(),
    ]);
    const controllers = taskControllersRef.current;
    return () => {
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
    // Initial mount bootstrap only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMainMode = useCallback(
    async (enabled: boolean) => {
      if (!enabled && replyTarget !== null && chatInput.trim() !== "") {
        setBanner("请先发送或退出当前卡片回复草稿。", "warning");
        return;
      }
      setMainModeState(enabled);
      try {
        sessionStorage.setItem(PREVIEW_KEY, String(enabled));
      } catch {
        // Storage may be unavailable in restricted contexts.
      }
      if (!enabled) {
        setInteractions([]);
        setObservedConversation(null);
        setReplyTarget(null);
      }
      await loadHistory(enabled);
    },
    [chatInput, loadHistory, replyTarget, setBanner],
  );

  const submitConversationTurn = useCallback(
    async (request: ConversationTurnRequest) => {
      if (sending) return;
      setSending(true);
      setBanner("正在处理主对话…", "neutral");
      try {
        const { result } = await postConversationTurn(request);
        setRetryTurn(null);
        if (
          "text" in request &&
          (request.action !== "utterance" || (!request.command && !request.selection))
        ) {
          setChatInput("");
          if (request.action === "reply" || (request.action === "utterance" && request.replyTo)) {
            setReplyTarget(null);
          }
        }
        if (result.kind === "archive") {
          await Promise.all([refreshBuckets(), refreshAgenda()]);
        }
        if (request.action === "delegate" && result.kind === "clarification") {
          await refreshAgents();
          setBanner("已提交只读检查提案。请在 Agent 面板核对后显式批准。", "success");
        } else if ("chatError" in result && result.chatError) {
          setBanner(result.chatError, "warning");
        } else {
          setStatusState(null);
        }
        await loadHistory(true);
      } catch (error) {
        const known = error instanceof ApiRequestError && error.status < 500;
        setRetryTurn(known ? null : request);
        await loadHistory(true);
        setBanner(
          known
            ? isConflictError(error) && request.action === "utterance"
              ? `${errorMessage(error)} 请核对刷新后的问题，再决定是否重新发送。`
              : errorMessage(error)
            : "提交结果未确认。可用同一请求核对或重试。",
          "warning",
        );
      } finally {
        setSending(false);
      }
    },
    [loadHistory, refreshAgents, refreshAgenda, refreshBuckets, sending, setBanner],
  );

  const sendMessage = useCallback(async () => {
    const text = chatInput.trim();
    if (!text || sending) return;
    if (retryTurn !== null) {
      setBanner("请先核对或重试上次发送结果。", "warning");
      return;
    }
    if (mainMode) {
      if (text.length > 4000) {
        setBanner("主对话每条消息最多 4000 字符。", "warning");
        return;
      }
      if (observedConversation === null) {
        setBanner("请先刷新对话以恢复当前状态，再发送消息。", "warning");
        return;
      }
      const requestId = crypto.randomUUID();
      if (replyTarget !== null && replyTarget.promptMessageId === null) {
        await submitConversationTurn({
          action: "reply",
          text,
          requestId,
          clarificationId: replyTarget.interactionId,
          expectedRevision: replyTarget.revision,
        });
      } else {
        await submitConversationTurn({
          action: "utterance",
          text,
          requestId,
          snapshot: {
            throughSequence: observedConversation.throughSequence,
            prompts: [...observedConversation.prompts],
          },
          ...(replyTarget !== null && replyTarget.promptMessageId !== null
            ? {
                replyTo: {
                  interactionId: replyTarget.interactionId,
                  revision: replyTarget.revision,
                  promptMessageId: replyTarget.promptMessageId,
                },
              }
            : {}),
        });
      }
      return;
    }

    // Legacy background queue chat fallback
    setSending(true);
    setBanner("已提交旧聊天后台任务…", "neutral");
    try {
      const { task } = await postTask({
        message: text,
        ...(selectedBucketId ? { focus_bucket_id: selectedBucketId } : {}),
      });
      setChatInput("");
      setTasks((prev) => [task, ...prev.filter((t) => t.id !== task.id)]);
      observeBackgroundTask(task);
      setStatusState(null);
    } catch (error) {
      setBanner(errorMessage(error), "warning");
    } finally {
      setSending(false);
    }
  }, [
    chatInput,
    mainMode,
    observedConversation,
    observeBackgroundTask,
    replyTarget,
    retryTurn,
    selectedBucketId,
    sending,
    setBanner,
    submitConversationTurn,
  ]);

  const retryPendingTurn = useCallback(async () => {
    if (retryTurn !== null) await submitConversationTurn(retryTurn);
  }, [retryTurn, submitConversationTurn]);

  const selectCandidate = useCallback(
    async (
      card: ConversationInteraction,
      candidate: ConversationInteraction["candidates"][number],
    ) => {
      const requestId = crypto.randomUUID();
      if (card.promptMessageId !== null) {
        await submitConversationTurn({
          action: "utterance",
          requestId,
          text: candidate.title,
          replyTo: {
            interactionId: card.id,
            revision: card.revision,
            promptMessageId: card.promptMessageId,
          },
          selection:
            candidate.kind === "entry"
              ? {
                  kind: "entry",
                  id: candidate.id,
                  memoryRevision: candidate.memoryRevision,
                }
              : {
                  kind: "work_item",
                  id: candidate.id,
                  scopeRevision: candidate.scopeRevision,
                },
        });
      } else if (candidate.kind === "work_item") {
        await submitConversationTurn({
          action: "select",
          requestId,
          clarificationId: card.id,
          expectedRevision: card.revision,
          workItemId: candidate.id,
        });
      }
    },
    [submitConversationTurn],
  );

  const actOnInteractionCommand = useCallback(
    async (card: ConversationInteraction, command: "none" | "cancel") => {
      const requestId = crypto.randomUUID();
      if (card.promptMessageId !== null) {
        await submitConversationTurn({
          action: "utterance",
          requestId,
          text: command === "none" ? "都不是" : "取消这次澄清",
          replyTo: {
            interactionId: card.id,
            revision: card.revision,
            promptMessageId: card.promptMessageId,
          },
          command,
        });
      } else {
        await submitConversationTurn({
          action: command,
          requestId,
          clarificationId: card.id,
          expectedRevision: card.revision,
        });
      }
    },
    [submitConversationTurn],
  );

  const retryInteractionAnswer = useCallback(
    async (card: ConversationInteraction) => {
      if (!card.retryResultMessageId) return;
      const requestId = card.retryRequestId ?? crypto.randomUUID();
      await submitConversationTurn({
        action: "retry_context",
        requestId,
        clarificationId: card.id,
        expectedRevision: card.revision,
        resultMessageId: card.retryResultMessageId,
      });
    },
    [submitConversationTurn],
  );

  const delegateInteractionReadonly = useCallback(
    async (card: ConversationInteraction, backend: AgentBackend, workspaceId: string) => {
      await submitConversationTurn({
        action: "delegate",
        requestId: crypto.randomUUID(),
        clarificationId: card.id,
        expectedRevision: card.revision,
        backend,
        workspaceId,
      });
    },
    [submitConversationTurn],
  );

  const confirmArchiveAction = useCallback(
    async (request: ChatConfirmationRequest) => {
      setSending(true);
      try {
        await postChatConfirmation(request);
        await Promise.all([loadHistory(), refreshBuckets(), refreshAgenda()]);
        setBanner(request.action === "discard" ? "已选择不保存。" : "归档已确认保存。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      } finally {
        setSending(false);
      }
    },
    [loadHistory, refreshAgenda, refreshBuckets, setBanner],
  );

  const openBucketInMemory = useCallback(async (bucketId: string, switchView = true) => {
    setSelectedBucketId(bucketId);
    if (switchView) setActiveTab("memory");
    setBucketDetailLoading(true);
    setBucketDetailError(null);
    try {
      const detail = await fetchBucketDetail(bucketId);
      setBucketDetail(detail);
    } catch (error) {
      setBucketDetailError(errorMessage(error));
    } finally {
      setBucketDetailLoading(false);
    }
  }, []);

  const inspectEntrySource = useCallback(async (bucketId: string, entryId: string) => {
    setInspectorOpen(true);
    setInspectorTab("source");
    setInspectedSource({
      kind: "entry",
      bucketId,
      entryId,
      loading: true,
      error: null,
      detail: null,
    });
    try {
      const detail = await fetchBucketDetail(bucketId);
      setInspectedSource({
        kind: "entry",
        bucketId,
        entryId,
        loading: false,
        error: null,
        detail,
      });
    } catch (error) {
      setInspectedSource({
        kind: "entry",
        bucketId,
        entryId,
        loading: false,
        error: errorMessage(error),
        detail: null,
      });
    }
  }, []);

  const inspectMessageSource = useCallback(
    (messageId: string, fallbackText?: string) => {
      const found = history.find((m) => m.id === messageId);
      const text = found?.content ?? fallbackText ?? "该消息不在当前历史窗口。";
      setHighlightedMessageId(messageId);
      setInspectorOpen(true);
      setInspectorTab("source");
      setInspectedSource({ kind: "message", messageId, text });
    },
    [history],
  );

  const inspectWorkItem = useCallback((workItemId: string) => {
    setInspectedWorkItemId(workItemId);
    setInspectorOpen(true);
    setInspectorTab("work-item");
  }, []);

  const openPendingInspector = useCallback(() => {
    setInspectorOpen(true);
    setInspectorTab("pending");
  }, []);

  const moveEntryToBucket = useCallback(
    async (entryId: string, targetBucketId: string) => {
      try {
        await postEntryMove({
          entry_id: entryId,
          target_bucket_id: targetBucketId,
          command_text: "通过界面移动记录",
        });
        await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
        if (selectedBucketId) {
          await openBucketInMemory(selectedBucketId, false);
        }
        setBanner("已移动记录到目标 Bucket。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [loadHistory, openBucketInMemory, refreshAgenda, refreshBuckets, selectedBucketId, setBanner],
  );

  const revokeEntry = useCallback(
    async (entryId: string) => {
      if (!window.confirm("确认撤销这条记录？原文和审计会保留，但将从有效检索与上下文中移除。")) {
        return;
      }
      try {
        await revokeEntryRequest(entryId);
        await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
        if (selectedBucketId) {
          await openBucketInMemory(selectedBucketId, false);
        }
        if (inspectedSource?.kind === "entry" && inspectedSource.entryId === entryId) {
          await inspectEntrySource(inspectedSource.bucketId, entryId);
        }
        setBanner("记录已逻辑撤销。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [
      inspectEntrySource,
      inspectedSource,
      loadHistory,
      openBucketInMemory,
      refreshAgenda,
      refreshBuckets,
      selectedBucketId,
      setBanner,
    ],
  );

  const deleteBucket = useCallback(
    async (bucketId: string) => {
      if (!window.confirm("确认删除该 Bucket？此操作不可撤销。")) return;
      try {
        await deleteBucketRequest(bucketId);
        if (selectedBucketId === bucketId) {
          setSelectedBucketId(null);
          setBucketDetail(null);
        }
        await Promise.all([refreshBuckets(), loadHistory(), refreshAgenda()]);
        setBanner("Bucket 已删除。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [loadHistory, refreshAgenda, refreshBuckets, selectedBucketId, setBanner],
  );

  const handleCreateWorkItem = useCallback(
    async (input: { title: string; goal: string; acceptance: string }) => {
      try {
        const created = await createWorkItem({
          requestId: crypto.randomUUID(),
          title: input.title,
          goal: input.goal,
          acceptance: input.acceptance,
          sources: [],
        });
        await refreshWorkItems();
        setInspectedWorkItemId(created.workItem.id);
        setBanner(`已创建工作目标「${created.workItem.title}」。`, "success");
        return true;
      } catch (error) {
        setBanner(errorMessage(error), "warning");
        return false;
      }
    },
    [refreshWorkItems, setBanner],
  );

  const handleTransitionWorkItem = useCallback(
    async (item: WorkItem, action: "complete" | "reopen" | "cancel") => {
      try {
        await transitionWorkItem(item.id, {
          expectedRevision: item.revision,
          action,
        });
        await refreshWorkItems();
        setBanner("工作目标状态已更新。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [refreshWorkItems, setBanner],
  );

  const handleProposeWorkItemAttempt = useCallback(
    async (item: WorkItem, backend: AgentBackend, workspaceId: string | null, note: string) => {
      try {
        await postWorkItemAttempt(item.id, {
          requestId: crypto.randomUUID(),
          expectedRevision: item.revision,
          backend,
          workspaceId,
          instruction: note.trim() || "请只读检查当前工作目标关联的材料与工作区状态。",
        });
        await Promise.all([refreshWorkItems(), refreshAgents()]);
        setBanner("已创建只读执行提案，请在 Agent 面板显式批准。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [refreshAgents, refreshWorkItems, setBanner],
  );

  const handleTodoTransition = useCallback(
    async (todo: TodoDto, statusNext: TodoTransitionRequest["status"]) => {
      try {
        await postTodoTransition(todo.id, {
          command_text: "通过界面更新待办状态",
          status: statusNext,
          expected_updated_at: todo.updated_at,
        });
        await refreshAgenda();
      } catch (error) {
        setBanner(errorMessage(error), "warning");
        await refreshAgenda();
      }
    },
    [refreshAgenda, setBanner],
  );

  const handleTodoAdvance = useCallback(
    async (todo: TodoDto) => {
      try {
        await postTodoAdvance(todo.id, {
          command_text: "通过界面完成并推进待办",
          expected_updated_at: todo.updated_at,
        });
        await refreshAgenda();
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [refreshAgenda, setBanner],
  );

  const handleTodoReopen = useCallback(
    async (todo: TodoDto) => {
      try {
        await postTodoReopen(todo.id, {
          command_text: "通过界面重新打开待办",
          expected_updated_at: todo.updated_at,
        });
        await refreshAgenda();
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [refreshAgenda, setBanner],
  );

  const handleTodoPlan = useCallback(
    async (todo: TodoDto, plan: Omit<TodoPlanRequest, "expected_updated_at">) => {
      try {
        await postTodoPlan(todo.id, {
          ...plan,
          expected_updated_at: todo.updated_at,
        });
        await refreshAgenda();
        setBanner("待办计划已保存。", "success");
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [refreshAgenda, setBanner],
  );

  const runSearch = useCallback(async () => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchError("请输入自然语言查询。");
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetchMemoryQuery(trimmed);
      setSearchResult(res);
    } catch (error) {
      setSearchError(errorMessage(error));
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const handleCancelBackgroundTask = useCallback(
    async (taskId: string) => {
      try {
        const { task } = await postTaskCancel(taskId);
        setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [setBanner],
  );

  const handleRegisterWorkspace = useCallback(
    async (path: string, bucketId?: string) => {
      try {
        await registerAgentWorkspace({
          path,
          ...(bucketId && bucketId.trim() ? { bucketId: bucketId.trim() } : {}),
        });
        await refreshAgents();
        setBanner("工作区已登记。", "success");
        return true;
      } catch (error) {
        setBanner(errorMessage(error), "warning");
        return false;
      }
    },
    [refreshAgents, setBanner],
  );

  const handleProposeAgent = useCallback(
    async (input: {
      backend: AgentBackend;
      instruction: string;
      workspaceId: string | null;
      sessionId?: string;
    }) => {
      try {
        await postAgentProposal({
          backend: input.backend,
          instruction: input.instruction,
          workspaceId: input.workspaceId,
          ...(input.sessionId && input.sessionId.trim()
            ? { sessionId: input.sessionId.trim() }
            : {}),
        });
        await refreshAgents();
        setBanner("已创建待批准提案。请核对指令后再显式批准。", "success");
        return true;
      } catch (error) {
        setBanner(errorMessage(error), "warning");
        return false;
      }
    },
    [refreshAgents, setBanner],
  );

  const handleAgentAction = useCallback(
    async (task: AgentTask, action: "approve" | "reject" | "cancel") => {
      try {
        await postAgentAction(task, action);
        await Promise.all([refreshAgents(), refreshTasks(), loadHistory()]);
        setBanner(
          action === "approve"
            ? "已显式批准并入队执行。"
            : action === "reject"
              ? "已拒绝提案。"
              : "已发送取消请求。",
          "success",
        );
      } catch (error) {
        setBanner(errorMessage(error), "warning");
      }
    },
    [loadHistory, refreshAgents, refreshTasks, setBanner],
  );

  const clearInputAndFocusChat = useCallback(() => {
    setActiveTab("chat");
    setChatInput("");
    setReplyTarget(null);
    setStatusState(null);
    setMobileMenuOpen(false);
  }, []);

  const counts = useMemo(() => {
    const pendingClarifications = interactions.filter(
      (card) => card.awaiting !== null && card.status !== "cancelled" && card.status !== "stale",
    ).length;
    const pendingArchives = history.filter((msg) => {
      if (msg.role !== "assistant" || !("details" in msg)) return false;
      const details: unknown = msg.details;
      if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
      if (!("archive" in details)) return false;
      const archive: unknown = details.archive;
      if (archive === null || typeof archive !== "object" || Array.isArray(archive)) return false;
      return "archive_state" in archive && archive.archive_state === "needs_confirmation";
    }).length;
    const pendingApprovals = agentTasks.filter((task) => task.status === "pending").length;
    const activeWorkItems = workItems.filter((item) => item.status === "open").length;
    const openTodos = agenda.filter(
      (todo) => todo.status === "open" || todo.status === "in_progress",
    ).length;
    return {
      pendingClarifications,
      pendingArchives,
      pendingApprovals,
      activeWorkItems,
      openTodos,
      buckets: buckets.length,
    };
  }, [agenda, agentTasks, buckets.length, history, interactions, workItems]);

  return {
    activeTab,
    setActiveTab,
    sidebarCollapsed,
    setSidebarCollapsed,
    mobileMenuOpen,
    setMobileMenuOpen,
    mainMode,
    setMainMode,
    status,
    setBanner,
    clearBanner: () => setStatusState(null),
    history,
    interactions,
    observedConversation,
    chatInput,
    setChatInput,
    sending,
    replyTarget,
    setReplyTarget,
    retryTurn,
    highlightedMessageId,
    buckets,
    selectedBucketId,
    bucketDetail,
    bucketDetailLoading,
    bucketDetailError,
    workItems,
    agenda,
    agendaIncludeHistory,
    searchQuery,
    setSearchQuery,
    searchResult,
    searchLoading,
    searchError,
    tasks,
    agentBackends,
    agentWorkspaces,
    agentTasks,
    inspectorOpen,
    setInspectorOpen,
    inspectorTab,
    setInspectorTab,
    inspectedSource,
    inspectedWorkItemId,
    counts,
    loadHistory,
    refreshBuckets,
    refreshAgenda,
    refreshWorkItems,
    refreshTasks,
    refreshAgents,
    sendMessage,
    retryPendingTurn,
    selectCandidate,
    actOnInteractionCommand,
    retryInteractionAnswer,
    delegateInteractionReadonly,
    confirmArchiveAction,
    openBucketInMemory,
    inspectEntrySource,
    inspectMessageSource,
    inspectWorkItem,
    openPendingInspector,
    moveEntryToBucket,
    revokeEntry,
    deleteBucket,
    handleCreateWorkItem,
    handleTransitionWorkItem,
    handleProposeWorkItemAttempt,
    handleTodoTransition,
    handleTodoAdvance,
    handleTodoReopen,
    handleTodoPlan,
    runSearch,
    handleCancelBackgroundTask,
    handleRegisterWorkspace,
    handleProposeAgent,
    handleAgentAction,
    clearInputAndFocusChat,
  };
}

export type DoggieAppController = ReturnType<typeof useDoggieApp>;
