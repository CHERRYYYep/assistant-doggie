import {
  AlertTriangle,
  Archive,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentBackend } from "../../../src/domain/agent.ts";
import type { BucketType } from "../../../src/domain/types.ts";
import type { UiChatMessageDto } from "../../../src/http/dto.ts";
import type { ConversationInteraction, DoggieAppController } from "../store/useDoggieApp.ts";
import { MarkdownContent } from "./MarkdownContent.tsx";

type Props = {
  readonly app: DoggieAppController;
};

const EXECUTION_LABELS: Record<string, string> = {
  pending: "等待批准",
  queued: "已入队",
  running: "正在检查",
  succeeded: "检查完成",
  failed: "检查失败",
  cancelled: "已取消",
  rejected: "已拒绝",
  stale: "结果或提案已失效",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractCitations(details: Record<string, unknown>) {
  const rawEntries = Array.isArray(details["citations"]) ? details["citations"] : [];
  const entries = rawEntries.flatMap((item) => {
    if (!isRecord(item)) return [];
    const entryId = asString(item["entryId"]);
    const bucketId = asString(item["bucketId"]);
    return entryId && bucketId ? [{ entryId, bucketId }] : [];
  });
  const rawMaterials = Array.isArray(details["materialMessageIds"])
    ? details["materialMessageIds"]
    : [];
  const materialMessageIds = rawMaterials.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return { entries, materialMessageIds };
}

function ArchiveCard({
  archive,
  sourceText,
  app,
}: {
  readonly archive: Record<string, unknown>;
  readonly sourceText: string;
  readonly app: DoggieAppController;
}) {
  const state = asString(archive["archive_state"]);
  const attemptId = asString(archive["attempt_id"]);
  const bucketId = asString(archive["bucket_id"]);
  const entryId = asString(archive["entry_id"]);
  const reason = asString(archive["reason"]);
  const recommendedTitle = asString(archive["recommended_bucket_title"]);
  const recommendedId = asString(archive["recommended_bucket_id"]);

  const [selectedOtherBucket, setSelectedOtherBucket] = useState("");
  const [newBucketTitle, setNewBucketTitle] = useState(recommendedTitle);
  const [newBucketType, setNewBucketType] = useState<BucketType>("knowledge");
  const [moveTarget, setMoveTarget] = useState("");

  if (state === "needs_confirmation") {
    return (
      <div className="mt-2.5 rounded-xl border border-[var(--warn-line)] bg-[var(--warn-soft)] p-3.5 text-xs">
        <div className="flex items-center gap-2 font-semibold text-[var(--warn)]">
          <Archive className="h-4 w-4 shrink-0" />
          <span>归档待你确认（尚未保存）</span>
        </div>
        {reason ? <p className="mt-1.5 text-[var(--text-2)]">判断理由：{reason}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {recommendedId ? (
            <button
              type="button"
              disabled={app.sending}
              onClick={() =>
                void app.confirmArchiveAction({
                  confirmation_granted: true,
                  attempt_id: attemptId,
                  text: sourceText,
                  action: "append",
                  bucket_id: recommendedId,
                })
              }
              className="rounded-lg bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--panel)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
            >
              保存到「{recommendedTitle || "推荐 Bucket"}」
            </button>
          ) : null}
          {app.buckets.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <select
                aria-label="选择备选 Bucket"
                value={selectedOtherBucket}
                onChange={(e) => setSelectedOtherBucket(e.target.value)}
                className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
              >
                <option value="">选择其他 Bucket…</option>
                {app.buckets.map((bucket) => (
                  <option key={bucket.id} value={bucket.id}>
                    {bucket.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={app.sending || !selectedOtherBucket}
                onClick={() =>
                  void app.confirmArchiveAction({
                    confirmation_granted: true,
                    attempt_id: attemptId,
                    text: sourceText,
                    action: "append",
                    bucket_id: selectedOtherBucket,
                  })
                }
                className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 hover:bg-[var(--panel-subtle)] disabled:opacity-50"
              >
                保存
              </button>
            </div>
          ) : null}
          <button
            type="button"
            disabled={app.sending}
            onClick={() =>
              void app.confirmArchiveAction({
                confirmation_granted: true,
                attempt_id: attemptId,
                text: sourceText,
                action: "discard",
              })
            }
            className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 text-[var(--text-2)] hover:bg-[var(--panel-subtle)] disabled:opacity-50"
          >
            不保存
          </button>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[var(--warn-line)] pt-2.5">
          <input
            type="text"
            value={newBucketTitle}
            onChange={(e) => setNewBucketTitle(e.target.value)}
            placeholder="或新建 Bucket 名称"
            className="min-w-[140px] flex-1 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 text-xs text-[var(--text)]"
          />
          <select
            aria-label="新建 Bucket 类型"
            value={newBucketType}
            onChange={(e) => setNewBucketType(e.target.value as BucketType)}
            className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
          >
            <option value="knowledge">知识</option>
            <option value="experiment">实验</option>
            <option value="task">任务</option>
            <option value="decision">决策</option>
            <option value="draft">草稿</option>
            <option value="idea">想法</option>
            <option value="incident">事件</option>
            <option value="meeting">会议</option>
          </select>
          <button
            type="button"
            disabled={app.sending || !newBucketTitle.trim()}
            onClick={() =>
              void app.confirmArchiveAction({
                confirmation_granted: true,
                attempt_id: attemptId,
                text: sourceText,
                action: "create",
                title: newBucketTitle.trim(),
                bucket_type: newBucketType,
              })
            }
            className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 font-medium hover:bg-[var(--panel-subtle)] disabled:opacity-50"
          >
            新建并保存
          </button>
        </div>
      </div>
    );
  }

  const isRevoked = archive["revoked"] === true;
  if (state === "discarded") {
    return (
      <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] px-2.5 py-1 text-xs text-[var(--muted)]">
        <Info className="h-3.5 w-3.5" />
        <span>已选择不保存</span>
      </div>
    );
  }

  if (state === "archived") {
    return (
      <details className="doggie-audit mt-2 rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] px-3 py-1.5 text-xs">
        <summary className="flex cursor-pointer items-center justify-between gap-2 text-[var(--success)]">
          <span className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              {isRevoked
                ? "记录已撤销（历史保留）"
                : `已归档至「${asString(archive["bucket_title"]) || "Bucket"}」`}
            </span>
          </span>
          <span className="flex items-center gap-1 text-[11px] opacity-80">
            <span>详情</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--success-line)] pt-2 text-[var(--text-2)]">
          {bucketId && entryId ? (
            <button
              type="button"
              onClick={() => void app.inspectEntrySource(bucketId, entryId)}
              className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 hover:bg-[var(--panel-subtle)]"
            >
              检视原文
            </button>
          ) : null}
          {!isRevoked && entryId && app.buckets.length > 0 ? (
            <>
              <select
                aria-label="移动到其他 Bucket"
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
                className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
              >
                <option value="">修改所属 Bucket…</option>
                {app.buckets
                  .filter((b) => b.id !== bucketId)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.title}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={!moveTarget}
                onClick={() => {
                  if (moveTarget) void app.moveEntryToBucket(entryId, moveTarget);
                }}
                className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 hover:bg-[var(--panel-subtle)] disabled:opacity-50"
              >
                移动
              </button>
              <button
                type="button"
                onClick={() => void app.revokeEntry(entryId)}
                className="rounded-md border border-[var(--danger-line)] bg-[var(--panel)] px-2 py-1 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
              >
                撤销记录
              </button>
            </>
          ) : null}
        </div>
      </details>
    );
  }

  return null;
}

function InteractionCard({
  card,
  app,
}: {
  readonly card: ConversationInteraction;
  readonly app: DoggieAppController;
}) {
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [delegateWorkspace, setDelegateWorkspace] = useState("");
  const [delegateBackend, setDelegateBackend] = useState<AgentBackend | "">("");

  const isActive =
    card.status === "pending" || (card.status === "resolved" && card.awaiting !== null);
  const resultStatus = card.contextResult?.status;
  const isRetryableFailure =
    !isActive &&
    (resultStatus === "retryable_failure" ||
      (card.retryResultMessageId !== undefined &&
        resultStatus !== "unknown" &&
        card.status === "resolved"));
  const isUnknown = !isActive && resultStatus === "unknown";
  const isCancelledOrStale = card.status === "cancelled" || card.status === "stale";
  const isCompleted = !isActive && !isRetryableFailure && !isUnknown && !isCancelledOrStale;

  const selected = card.selected;
  const selectedIsEntry = selected !== null && selected.kind === "entry";
  const execStatus = card.execution?.status;
  const canDelegate =
    card.status === "resolved" &&
    selected !== null &&
    !selectedIsEntry &&
    execStatus !== "pending" &&
    execStatus !== "queued" &&
    execStatus !== "running";

  const openSelectedSource = () => {
    if (selected === null) return;
    if (selected.kind === "entry") {
      void app.inspectEntrySource(selected.bucketId, selected.id);
    } else {
      app.inspectWorkItem(selected.id);
    }
  };

  // 1. Active pending card (needs user decision)
  if (isActive) {
    return (
      <article
        aria-label="对话续接"
        className="mt-2 rounded-xl border border-[var(--accent-line)] bg-[var(--panel)] p-3.5 text-xs shadow-xs"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-semibold text-[var(--accent)]">
            <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
            <span>对话续接 · 等待你确认</span>
          </div>
          <button
            type="button"
            disabled={app.sending}
            onClick={() => void app.actOnInteractionCommand(card, "cancel")}
            className="rounded-md px-2 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)] disabled:opacity-50"
          >
            取消澄清
          </button>
        </div>

        <p className="mt-1.5 text-[12px] text-[var(--text-2)]">原请求：{card.originalText}</p>

        {selected !== null ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[var(--text)]">
            <span>
              {selectedIsEntry ? "已关联材料" : "已选目标"}：<strong>{selected.title}</strong>
            </span>
            <button
              type="button"
              onClick={openSelectedSource}
              className="rounded-full border border-[var(--line)] bg-[var(--panel-subtle)] px-2 py-0.5 text-[11px] hover:border-[var(--line-strong)]"
            >
              查看原文
            </button>
          </div>
        ) : null}

        {card.candidates.length > 0 ? (
          <div className="mt-2.5 space-y-1.5">
            {card.candidates.map((candidate) => (
              <div
                key={`${candidate.kind}-${candidate.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] px-2.5 py-2"
              >
                <button
                  type="button"
                  disabled={app.sending}
                  onClick={() => void app.selectCandidate(card, candidate)}
                  className="min-w-0 flex-1 text-left hover:text-[var(--accent)] disabled:opacity-50"
                >
                  <div className="font-medium text-[var(--text)]">{candidate.title}</div>
                  {candidate.hint ? (
                    <div className="truncate text-[11px] text-[var(--muted)]">
                      {candidate.kind === "entry"
                        ? `${candidate.createdAt.slice(0, 10)} · ${candidate.hint}`
                        : candidate.hint}
                    </div>
                  ) : null}
                </button>
                {candidate.kind === "entry" ? (
                  <button
                    type="button"
                    onClick={() => void app.inspectEntrySource(candidate.bucketId, candidate.id)}
                    className="shrink-0 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--text-2)] hover:border-[var(--line-strong)] hover:text-[var(--text)]"
                  >
                    查看原文
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => app.inspectWorkItem(candidate.id)}
                    className="shrink-0 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--text-2)] hover:border-[var(--line-strong)]"
                  >
                    查看目标
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {card.truncated ? (
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            仅展示部分候选，可直接回复更具体的名称或贴出原文。
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {card.candidates.length > 0 ? (
            <button
              type="button"
              disabled={app.sending}
              onClick={() => void app.actOnInteractionCommand(card, "none")}
              className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 font-medium text-[var(--text-2)] hover:bg-[var(--panel-subtle)] disabled:opacity-50"
            >
              都不是
            </button>
          ) : null}
          <button
            type="button"
            disabled={app.sending}
            onClick={() =>
              app.setReplyTarget({
                interactionId: card.id,
                revision: card.revision,
                promptMessageId: card.promptMessageId,
                label: card.originalText.slice(0, 32),
              })
            }
            className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-1 font-medium text-[var(--accent)] hover:opacity-90 disabled:opacity-50"
          >
            补充这条请求
          </button>
        </div>
      </article>
    );
  }

  // 2. Retryable failure card (F8 anchored retry)
  if (isRetryableFailure) {
    return (
      <article
        aria-label="对话续接失败"
        className="mt-2 rounded-xl border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-[var(--danger)]">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{card.contextResult?.text || "暂时无法处理资料，可重试这次回答。"}</span>
          </div>
          {card.retryResultMessageId ? (
            <button
              type="button"
              disabled={app.sending}
              onClick={() => void app.retryInteractionAnswer(card)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--danger)] px-3 py-1 font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{card.retryRequestId ? "核对重试结果" : "重试回答"}</span>
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-2)]">
          {selected !== null ? (
            <>
              <span>
                {selectedIsEntry ? "已关联材料" : "已选目标"}：{selected.title}
              </span>
              <button
                type="button"
                onClick={openSelectedSource}
                className="underline underline-offset-2 hover:text-[var(--text)]"
              >
                查看原文
              </button>
            </>
          ) : card.selectedMaterial ? (
            (() => {
              const material = card.selectedMaterial;
              return (
                <button
                  type="button"
                  onClick={() => app.inspectMessageSource(material.messageId, material.text)}
                  className="underline underline-offset-2 hover:text-[var(--text)]"
                >
                  查看本轮提供的原文
                </button>
              );
            })()
          ) : null}
        </div>
      </article>
    );
  }

  // 3. Unknown / in-progress state
  if (isUnknown) {
    return (
      <article
        aria-label="处理结果待核对"
        className="mt-2 rounded-xl border border-[var(--info-line)] bg-[var(--info-soft)] p-3 text-xs"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium text-[var(--info)]">
            <Clock className="h-4 w-4 shrink-0" />
            <span>结果尚未确认，可核对同一次请求状态。</span>
          </div>
          {card.retryResultMessageId ? (
            <button
              type="button"
              disabled={app.sending}
              onClick={() => void app.retryInteractionAnswer(card)}
              className="rounded-lg border border-[var(--info-line)] bg-[var(--panel)] px-2.5 py-1 font-medium text-[var(--info)] hover:opacity-90 disabled:opacity-50"
            >
              核对重试结果
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  // 4. Cancelled / stale state -> collapsed muted audit bar, 0 actionable buttons
  if (isCancelledOrStale) {
    return (
      <details className="doggie-audit mt-2 rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] px-3 py-1.5 text-xs text-[var(--muted)]">
        <summary className="flex cursor-pointer items-center justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            <span>
              {card.status === "cancelled" ? "已取消这次澄清" : "目标范围或来源已变化，请重新发起"}
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5" />
        </summary>
        <div className="mt-2 border-t border-[var(--line)] pt-2 text-[11px]">
          <div>原请求：{card.originalText}</div>
          {card.latestReply ? <div>补充：{card.latestReply}</div> : null}
        </div>
      </details>
    );
  }

  // 5. Completed state -> collapsed soft audit bar (F9: no stale candidate controls)
  const completedLabel = selected
    ? `${selectedIsEntry ? "已关联材料" : "已选目标"}「${selected.title}」`
    : card.selectedMaterial
      ? "已基于本轮提供原文完成"
      : "已完成对话续接";

  return (
    <details className="doggie-audit mt-2 rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] px-3 py-1.5 text-xs">
      <summary className="flex cursor-pointer items-center justify-between gap-2 text-[var(--text-2)]">
        <span className="flex min-w-0 items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
          <span className="truncate font-medium">{completedLabel}</span>
          {card.execution ? (
            <span className="rounded-full border border-[var(--line)] bg-[var(--panel)] px-2 py-0.5 text-[10px]">
              只读检查：{EXECUTION_LABELS[card.execution.status] ?? card.execution.status}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--muted)]">
          <span>详情</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </summary>
      <div className="mt-2 space-y-2 border-t border-[var(--line)] pt-2 text-[11px] text-[var(--text-2)]">
        <div>原请求：{card.originalText}</div>
        {card.latestReply ? <div>补充：{card.latestReply}</div> : null}
        <div className="flex flex-wrap items-center gap-2">
          {selected !== null ? (
            <button
              type="button"
              onClick={openSelectedSource}
              className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-[var(--text)] hover:bg-[var(--accent-soft)]"
            >
              {selectedIsEntry ? "查看原文" : "查看目标详情"}
            </button>
          ) : null}
          {card.selectedMaterial
            ? (() => {
                const material = card.selectedMaterial;
                return (
                  <button
                    type="button"
                    onClick={() => app.inspectMessageSource(material.messageId, material.text)}
                    className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-[var(--text)] hover:bg-[var(--accent-soft)]"
                  >
                    查看本轮提供原文
                  </button>
                );
              })()
            : null}
          {canDelegate ? (
            <button
              type="button"
              onClick={() => setDelegateOpen((open) => !open)}
              className="rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-1 font-medium text-[var(--accent)]"
            >
              {delegateOpen ? "收起只读检查" : "准备只读检查"}
            </button>
          ) : null}
          {card.execution ? (
            <button
              type="button"
              onClick={() => app.setActiveTab("agents")}
              className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-[var(--text)]"
            >
              {card.execution.status === "pending" ? "前往 Agent 面板审批" : "查看 Agent 任务"}
            </button>
          ) : null}
        </div>

        {canDelegate && delegateOpen ? (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2.5">
            {app.agentBackends.length === 0 || app.agentWorkspaces.length === 0 ? (
              <div className="flex items-center justify-between gap-2 text-[var(--muted)]">
                <span>
                  {app.agentBackends.length === 0
                    ? "需要先配置 CLI 工具。"
                    : "请先登记要检查的工作区。"}
                </span>
                <button
                  type="button"
                  onClick={() => app.setActiveTab("agents")}
                  className="rounded-md border border-[var(--line-strong)] px-2 py-1 text-[var(--text)]"
                >
                  打开 Agent 面板
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[var(--muted)]">
                  提案提交后需在 Agent 面板单独批准，不会自动启动。
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    aria-label="选择工作区"
                    value={delegateWorkspace}
                    onChange={(e) => setDelegateWorkspace(e.target.value)}
                    className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
                  >
                    <option value="">选择工作区…</option>
                    {app.agentWorkspaces.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.path} · {ws.baseCommit.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="选择 CLI"
                    value={delegateBackend}
                    onChange={(e) => setDelegateBackend(e.target.value as AgentBackend | "")}
                    className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs text-[var(--text)]"
                  >
                    <option value="">选择 CLI…</option>
                    {app.agentBackends.map((backend) => (
                      <option key={backend} value={backend}>
                        {backend}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={app.sending || !delegateWorkspace || !delegateBackend}
                    onClick={() => {
                      if (delegateBackend && delegateWorkspace) {
                        void app.delegateInteractionReadonly(
                          card,
                          delegateBackend,
                          delegateWorkspace,
                        );
                        setDelegateOpen(false);
                      }
                    }}
                    className="rounded-md bg-[var(--accent)] px-2.5 py-1 font-medium text-[var(--panel)] disabled:opacity-50"
                  >
                    提交只读检查提案
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {card.execution?.status === "succeeded" && card.execution.output ? (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2">
            <div className="mb-1 text-[10px] font-medium text-[var(--muted)]">
              工具输出（未归档）
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--text)]">
              {card.execution.output}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function MessageRow({
  message,
  card,
  app,
}: {
  readonly message: UiChatMessageDto;
  readonly card: ConversationInteraction | undefined;
  readonly app: DoggieAppController;
}) {
  const highlighted = app.highlightedMessageId === message.id;

  if (message.role === "tool") {
    return (
      <div className="my-1 flex justify-start pl-10">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--panel-subtle)] px-2.5 py-0.5 text-[11px] text-[var(--muted)]">
          <span>工具：{message.tool_name || "memory"}（只读结果已记录）</span>
        </span>
      </div>
    );
  }

  const isUser = message.role === "user";
  const details =
    !isUser && "details" in message && isRecord(message.details) ? message.details : null;
  const archive =
    details &&
    isRecord(details["archive"]) &&
    typeof details["archive"]["archive_state"] === "string"
      ? details["archive"]
      : null;
  const citations = details ? extractCitations(details) : { entries: [], materialMessageIds: [] };

  return (
    <div
      id={`msg-${message.id}`}
      className={[
        "group flex gap-3 rounded-xl px-2 py-1.5 transition-colors",
        isUser ? "justify-end" : "justify-start",
        highlighted ? "bg-[var(--accent-soft)]" : "",
      ].join(" ")}
    >
      {!isUser ? (
        <div
          aria-hidden="true"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-xs font-semibold text-[var(--panel)]"
        >
          D
        </div>
      ) : null}

      <div className={["min-w-0", isUser ? "max-w-[80%]" : "max-w-[88%] flex-1"].join(" ")}>
        <div
          className={[
            "rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed",
            isUser
              ? "bg-[var(--user-bubble)] text-[var(--user-text)]"
              : "border border-[var(--line)] bg-[var(--panel)] text-[var(--text)]",
          ].join(" ")}
        >
          <MarkdownContent content={message.content || ""} />

          {citations.entries.length > 0 || citations.materialMessageIds.length > 0 ? (
            <div
              aria-label="本地证据"
              className="mt-2.5 flex flex-wrap gap-1.5 border-t border-[var(--line)] pt-2"
            >
              {citations.entries.map((citation, index) => (
                <button
                  key={`${citation.entryId}-${index}`}
                  type="button"
                  onClick={() => void app.inspectEntrySource(citation.bucketId, citation.entryId)}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--line-strong)] bg-[var(--panel-subtle)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--text-2)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <FileText className="h-3 w-3" />
                  <span>来源 {index + 1}</span>
                </button>
              ))}
              {citations.materialMessageIds.map((messageId) => (
                <button
                  key={messageId}
                  type="button"
                  onClick={() => app.inspectMessageSource(messageId)}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--info-line)] bg-[var(--info-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--info)] hover:opacity-90"
                >
                  <FileText className="h-3 w-3" />
                  <span>本轮提供（未归档）</span>
                </button>
              ))}
            </div>
          ) : null}

          {archive !== null ? (
            <ArchiveCard
              archive={archive}
              sourceText={details ? asString(details["source_text"]) : ""}
              app={app}
            />
          ) : null}
        </div>

        {card !== undefined ? <InteractionCard card={card} app={app} /> : null}
      </div>
    </div>
  );
}

export function ChatView({ app }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const { cardByMessageId, orphanCards } = useMemo(() => {
    const cards = app.mainMode ? app.interactions : [];
    const historyIds = new Set(app.history.map((m) => m.id));
    const map = new Map<string, ConversationInteraction>();
    const orphans: ConversationInteraction[] = [];
    for (const card of cards) {
      const anchor = card.promptMessageId ?? card.assistantMessageId;
      if (historyIds.has(anchor)) {
        map.set(anchor, card);
      } else {
        orphans.push(card);
      }
    }
    return { cardByMessageId: map, orphanCards: orphans.reverse() };
  }, [app.history, app.interactions, app.mainMode]);

  const interactionVersionKey = useMemo(
    () =>
      app.interactions
        .map(
          (card) =>
            `${card.id}:${card.revision}:${card.status}:${card.contextResult?.status ?? ""}`,
        )
        .join("|"),
    [app.interactions],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [app.history.length, interactionVersionKey]);

  useEffect(() => {
    if (app.replyTarget !== null) {
      inputRef.current?.focus();
    }
  }, [app.replyTarget]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Scrollable timeline */}
      <div
        ref={scrollRef}
        aria-label="对话记录"
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
      >
        <div className="mx-auto max-w-[760px] space-y-3">
          {app.history.length === 0 && orphanCards.length === 0 ? (
            <div className="mx-auto max-w-xl py-12 text-center">
              <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <Sparkles className="h-5 w-5" />
              </div>
              <h2 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
                从这里，接着想。
              </h2>
              <p className="mt-2 text-sm text-[var(--muted)]">
                统一主对话入口：直接提问、贴原文改写、续做已有实验，或说「记一下」归档到长期记忆。
              </p>
              <div className="mt-6 grid gap-3 text-left sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => app.setChatInput("记一下：接口 A 的 p99 延迟已降到 31ms。")}
                  className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3.5 transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]"
                >
                  <div className="text-[11px] font-semibold text-[var(--accent)]">
                    01 / 记录进展
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-2)]">
                    记一下：接口 A 的 p99 延迟已降到 31ms。
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => app.setChatInput("帮我修改那个计网实验")}
                  className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3.5 transition-colors hover:border-[var(--accent-line)] hover:bg-[var(--accent-soft)]"
                >
                  <div className="text-[11px] font-semibold text-[var(--accent)]">
                    02 / 接着改记录
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-2)]">
                    帮我修改那个计网实验（自动定位或列出候选）
                  </div>
                </button>
              </div>
            </div>
          ) : (
            <>
              {app.history.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  card={cardByMessageId.get(message.id)}
                  app={app}
                />
              ))}
              {orphanCards.length > 0 ? (
                <div className="space-y-2 border-t border-[var(--line)] pt-3">
                  <div className="text-[11px] font-medium text-[var(--muted)]">
                    历史窗口外的活跃续接
                  </div>
                  {orphanCards.map((card) => (
                    <InteractionCard key={card.id} card={card} app={app} />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Floating bottom composer (Open WebUI MessageInput pattern) */}
      <div className="shrink-0 border-t border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-[760px]">
          {app.replyTarget !== null ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-1.5 text-xs text-[var(--accent)]">
              <span className="truncate">正在回复：{app.replyTarget.label}</span>
              <button
                type="button"
                onClick={() => {
                  app.setChatInput("");
                  app.setReplyTarget(null);
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--panel)]"
              >
                <X className="h-3.5 w-3.5" />
                <span>退出回复</span>
              </button>
            </div>
          ) : null}

          {app.retryTurn !== null ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--warn-line)] bg-[var(--warn-soft)] px-3 py-1.5 text-xs text-[var(--warn)]">
              <span>上次发送结果尚未确认，请使用同一请求核对。</span>
              <button
                type="button"
                disabled={app.sending}
                onClick={() => void app.retryPendingTurn()}
                className="rounded-md bg-[var(--warn)] px-2.5 py-1 font-medium text-white disabled:opacity-50"
              >
                核对或重试上次发送
              </button>
            </div>
          ) : null}

          <div className="rounded-2xl border border-[var(--line-strong)] bg-[var(--panel)] p-3 shadow-xs focus-within:border-[var(--accent)]">
            <label htmlFor="doggie-chat-input" className="sr-only">
              输入工作事实或消息
            </label>
            <textarea
              id="doggie-chat-input"
              ref={inputRef}
              rows={2}
              value={app.chatInput}
              onChange={(e) => app.setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void app.sendMessage();
                }
              }}
              placeholder={
                app.replyTarget
                  ? "输入对上述问题的回复或贴出原文…"
                  : "记下一个想法、提问，或直接回复上方澄清…"
              }
              className="max-h-44 w-full resize-none bg-transparent text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-[var(--panel-subtle)]">
                  <input
                    id="conversation-preview"
                    type="checkbox"
                    checked={app.mainMode}
                    disabled={app.sending || app.retryTurn !== null}
                    onChange={(e) => void app.setMainMode(e.target.checked)}
                    className="accent-[var(--accent)]"
                  />
                  <span>主对话模式</span>
                </label>
                {app.mainMode ? (
                  <button
                    id="conversation-refresh"
                    type="button"
                    disabled={app.sending}
                    onClick={() => void app.loadHistory(true)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 hover:bg-[var(--panel-subtle)] hover:text-[var(--text)] disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" />
                    <span>刷新对话</span>
                  </button>
                ) : (
                  <span className="text-[11px] text-[var(--warn)]">已回退旧聊天队列模式</span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {app.mainMode && app.chatInput.length > 3500 ? (
                  <span className="text-[11px] text-[var(--warn)]">
                    {app.chatInput.length} / 4000
                  </span>
                ) : null}
                <button
                  id="chat-send"
                  type="button"
                  disabled={app.sending || !app.chatInput.trim()}
                  onClick={() => void app.sendMessage()}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--panel)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  <span>发送</span>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex items-center justify-between px-1 text-[11px] text-[var(--muted)]">
            <span>Enter 发送 · Shift + Enter 换行</span>
            <span>不确定的归档与只读执行均需你显式确认</span>
          </div>
        </div>
      </div>
    </div>
  );
}
