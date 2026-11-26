import { AlertCircle, ExternalLink, FileText, Inbox, Target, X } from "lucide-react";
import type { DoggieAppController, InspectorTab } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

export function ContextInspector({ app }: Props) {
  if (!app.inspectorOpen) return null;

  const tabs: readonly { readonly id: InspectorTab; readonly label: string }[] = [
    { id: "source", label: "来源原文" },
    { id: "work-item", label: "关联目标" },
    {
      id: "pending",
      label: `活跃待决 (${app.counts.pendingClarifications + app.counts.pendingApprovals})`,
    },
  ];

  const inspectedWorkItem = app.workItems.find((item) => item.id === app.inspectedWorkItemId);

  const pendingCards = app.interactions.filter(
    (card) => card.awaiting !== null && card.status !== "cancelled" && card.status !== "stale",
  );
  const pendingAgents = app.agentTasks.filter((task) => task.status === "pending");

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/30 xl:hidden"
        onClick={() => app.setInspectorOpen(false)}
        aria-hidden="true"
      />
      <aside
        aria-label="上下文检视抽屉"
        className="fixed inset-y-0 right-0 z-40 flex w-[90vw] max-w-[390px] flex-col border-l border-[var(--line)] bg-[var(--panel)] shadow-lg xl:static xl:z-auto xl:w-[380px] xl:shrink-0 xl:shadow-none"
      >
        <div className="flex h-12 items-center justify-between border-b border-[var(--line)] px-3.5">
          <div className="flex items-center gap-1" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={app.inspectorTab === tab.id}
                onClick={() => app.setInspectorTab(tab.id)}
                className={[
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  app.inspectorTab === tab.id
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--muted)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => app.setInspectorOpen(false)}
            aria-label="关闭检视抽屉"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-xs">
          {app.inspectorTab === "source"
            ? (() => {
                const source = app.inspectedSource;
                if (source === null) {
                  return (
                    <div className="py-10 text-center text-[var(--muted)]">
                      <FileText className="mx-auto mb-2 h-6 w-6 opacity-60" />
                      <p>点击对话中的「来源」或「查看原文」，即可在此原位核对，无需离开主对话。</p>
                    </div>
                  );
                }
                if (source.kind === "message") {
                  return (
                    <div className="space-y-3">
                      <div className="inline-flex items-center gap-1.5 rounded-full border border-[var(--info-line)] bg-[var(--info-soft)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--info)]">
                        本轮提供（未归档）
                      </div>
                      <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-subtle)] p-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text)]">
                        {source.text}
                      </div>
                      <p className="text-[11px] text-[var(--muted)]">
                        此内容来自本轮对话消息，尚未写入长期记忆 Bucket。
                      </p>
                    </div>
                  );
                }
                if (source.loading) {
                  return <p className="text-[var(--muted)]">正在加载来源原文…</p>;
                }
                if (source.error) {
                  return (
                    <div className="rounded-lg border border-[var(--danger-line)] bg-[var(--danger-soft)] p-3 text-[var(--danger)]">
                      {source.error}
                    </div>
                  );
                }
                if (!source.detail) return null;

                const detail = source.detail.detail;
                const entry = detail.entries.find((item) => item.id === source.entryId);
                const isRevoked =
                  entry !== undefined &&
                  (entry.archive_state === "revoked" || entry.archive_state === "deleted");

                return (
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[11px] text-[var(--muted)]">所属 Bucket</div>
                        <div className="text-sm font-semibold text-[var(--text)]">
                          {detail.bucket.title}
                        </div>
                      </div>
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 text-[11px] font-medium",
                          entry === undefined || isRevoked
                            ? "border border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
                            : "border border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]",
                        ].join(" ")}
                      >
                        {entry === undefined ? "未找到" : isRevoked ? "已撤销" : "有效来源"}
                      </span>
                    </div>

                    {entry ? (
                      <>
                        <div className="text-[11px] text-[var(--muted)]">
                          记录时间：{entry.created_at}
                        </div>
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-subtle)] p-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text)]">
                          {entry.raw_text}
                        </div>
                        {entry.summary ? (
                          <div className="rounded-lg border border-[var(--line)] bg-[var(--panel)] p-2.5">
                            <div className="text-[11px] font-medium text-[var(--muted)]">摘要</div>
                            <p className="mt-1 text-[var(--text-2)]">{entry.summary}</p>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-[var(--muted)]">该记录可能已被删除或不再有效。</p>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => void app.openBucketInMemory(detail.bucket.id, true)}
                        className="inline-flex items-center gap-1 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1.5 font-medium text-[var(--text)] hover:bg-[var(--panel-subtle)]"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>在记忆空间打开</span>
                      </button>
                      {entry && !isRevoked ? (
                        <button
                          type="button"
                          onClick={() => void app.revokeEntry(entry.id)}
                          className="rounded-lg border border-[var(--danger-line)] bg-[var(--panel)] px-2.5 py-1.5 text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                        >
                          撤销记录
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })()
            : null}

          {app.inspectorTab === "work-item" ? (
            inspectedWorkItem ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold text-[var(--text)]">
                    {inspectedWorkItem.title}
                  </div>
                  <span className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                    {inspectedWorkItem.status}
                  </span>
                </div>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--panel-subtle)] p-3 space-y-2">
                  <div>
                    <div className="text-[11px] font-medium text-[var(--muted)]">目标范围</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[var(--text)]">
                      {inspectedWorkItem.goal}
                    </p>
                  </div>
                  <div>
                    <div className="text-[11px] font-medium text-[var(--muted)]">验收要求</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-[var(--text-2)]">
                      {inspectedWorkItem.acceptance}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {inspectedWorkItem.status === "open" ? (
                    <button
                      type="button"
                      onClick={() =>
                        void app.handleTransitionWorkItem(inspectedWorkItem, "complete")
                      }
                      className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 font-medium text-[var(--panel)]"
                    >
                      标记完成
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void app.handleTransitionWorkItem(inspectedWorkItem, "reopen")}
                      className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1.5"
                    >
                      重新打开
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => app.setActiveTab("work-items")}
                    className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1.5 text-[var(--text-2)]"
                  >
                    打开工作目标页
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-10 text-center text-[var(--muted)]">
                <Target className="mx-auto mb-2 h-6 w-6 opacity-60" />
                <p>在对话或目标列表中选择一个工作目标即可在此检视。</p>
                <button
                  type="button"
                  onClick={() => app.setActiveTab("work-items")}
                  className="mt-3 rounded-lg border border-[var(--line-strong)] px-3 py-1.5 text-[var(--text)] hover:bg-[var(--panel-subtle)]"
                >
                  前往工作目标视图
                </button>
              </div>
            )
          ) : null}

          {app.inspectorTab === "pending" ? (
            <div className="space-y-4">
              <section>
                <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-[var(--muted)]">
                  <span>待回复澄清 ({pendingCards.length})</span>
                </div>
                {pendingCards.length === 0 ? (
                  <p className="rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] p-2.5 text-[var(--muted)]">
                    当前没有等待确认的澄清卡。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {pendingCards.map((card) => (
                      <div
                        key={card.id}
                        className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] p-2.5"
                      >
                        <div className="font-medium text-[var(--text)]">{card.originalText}</div>
                        <div className="mt-1 text-[11px] text-[var(--text-2)]">
                          候选数：{card.candidates.length} · 等待：{card.awaiting}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              app.setActiveTab("chat");
                              app.setReplyTarget({
                                interactionId: card.id,
                                revision: card.revision,
                                promptMessageId: card.promptMessageId,
                                label: card.originalText.slice(0, 32),
                              });
                            }}
                            className="rounded-md bg-[var(--accent)] px-2 py-1 text-[11px] font-medium text-[var(--panel)]"
                          >
                            在输入框回复
                          </button>
                          <button
                            type="button"
                            onClick={() => void app.actOnInteractionCommand(card, "cancel")}
                            className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-[11px]"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <div className="mb-2 flex items-center justify-between text-[11px] font-semibold text-[var(--muted)]">
                  <span>待审批只读 Agent 提案 ({pendingAgents.length})</span>
                </div>
                {pendingAgents.length === 0 ? (
                  <p className="rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] p-2.5 text-[var(--muted)]">
                    当前没有待审批的只读执行提案。
                  </p>
                ) : (
                  <div className="space-y-2">
                    {pendingAgents.map((task) => (
                      <div
                        key={task.id}
                        className="rounded-lg border border-[var(--warn-line)] bg-[var(--warn-soft)] p-2.5"
                      >
                        <div className="flex items-center gap-1.5 font-medium text-[var(--warn)]">
                          <AlertCircle className="h-3.5 w-3.5" />
                          <span>{task.backend} · 只读待审批</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[var(--text-2)]">{task.instruction}</p>
                        <button
                          type="button"
                          onClick={() => app.setActiveTab("agents")}
                          className="mt-2 rounded-md border border-[var(--warn-line)] bg-[var(--panel)] px-2.5 py-1 font-medium text-[var(--text)]"
                        >
                          前往 Agent 面板核对审批
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {pendingCards.length === 0 && pendingAgents.length === 0 ? (
                <div className="py-4 text-center text-[var(--muted)]">
                  <Inbox className="mx-auto mb-1.5 h-5 w-5 opacity-60" />
                  <span>所有待决事项均已清空</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="border-t border-[var(--line)] bg-[var(--panel-subtle)] px-3.5 py-2 text-[11px] text-[var(--muted)]">
          检视来源或目标不会改变当前对话归属，也不会触发归档或执行批准。
        </div>
      </aside>
    </>
  );
}
