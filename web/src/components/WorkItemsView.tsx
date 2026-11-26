import { Plus, RefreshCw, Target } from "lucide-react";
import { useState } from "react";
import type { AgentBackend } from "../../../src/domain/agent.ts";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

export function WorkItemsView({ app }: Props) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [attemptBackend, setAttemptBackend] = useState<AgentBackend>("codex");
  const [attemptWorkspace, setAttemptWorkspace] = useState("");

  const submitCreate = async () => {
    if (!title.trim() || !goal.trim() || !acceptance.trim()) {
      app.setBanner("请填写目标名称、要完成什么和验收要求。", "warning");
      return;
    }
    const ok = await app.handleCreateWorkItem({
      title: title.trim(),
      goal: goal.trim(),
      acceptance: acceptance.trim(),
    });
    if (ok) {
      setTitle("");
      setGoal("");
      setAcceptance("");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">工作目标</h2>
            <p className="text-xs text-[var(--muted)]">
              管理需要跟踪范围与验收的工作目标（已从主对话底部独立出来，释放聊天视口）。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void app.refreshWorkItems()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--panel-subtle)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>刷新目标</span>
          </button>
        </div>

        <section
          aria-label="创建工作目标"
          className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4"
        >
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-[var(--text)]">
            <Plus className="h-4 w-4 text-[var(--accent)]" />
            <span>新建工作目标</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="block text-xs text-[var(--text-2)]">
              <span>目标名称</span>
              <input
                type="text"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：审查后端撤销机制"
                className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
              />
            </label>
            <label className="block text-xs text-[var(--text-2)]">
              <span>要完成什么</span>
              <input
                type="text"
                maxLength={4000}
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="描述目标范围"
                className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
              />
            </label>
            <label className="block text-xs text-[var(--text-2)]">
              <span>验收要求</span>
              <input
                type="text"
                maxLength={2000}
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
                placeholder="例如：给出有来源的问题清单"
                className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => void submitCreate()}
              className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 text-xs font-medium text-[var(--panel)] hover:bg-[var(--accent-hover)]"
            >
              建立工作目标
            </button>
          </div>
        </section>

        <section aria-label="工作目标列表" className="space-y-3">
          {app.workItems.length === 0 ? (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] py-12 text-center text-xs text-[var(--muted)]">
              <Target className="mx-auto mb-2 h-7 w-7 opacity-50" />
              <p>暂无工作目标。普通对话与历史记录改写无需预先创建目标。</p>
            </div>
          ) : (
            app.workItems.map((item) => (
              <article
                key={item.id}
                className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--text)]">{item.title}</h3>
                    <span className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                      {item.status}
                    </span>
                  </div>
                  <span className="text-[11px] text-[var(--muted)]">
                    v{item.revision} · scope v{item.scopeRevision}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[var(--text-2)]">范围：{item.goal}</p>
                <p className="mt-1 whitespace-pre-wrap text-[var(--muted)]">
                  验收：{item.acceptance}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
                  {item.status === "open" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void app.handleTransitionWorkItem(item, "complete")}
                        className="rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] px-2.5 py-1 font-medium text-[var(--success)]"
                      >
                        标记完成
                      </button>
                      <button
                        type="button"
                        onClick={() => void app.handleTransitionWorkItem(item, "cancel")}
                        className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1 text-[var(--text-2)]"
                      >
                        取消目标
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void app.handleTransitionWorkItem(item, "reopen")}
                      className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1"
                    >
                      重新打开
                    </button>
                  )}

                  {item.status === "open" && app.agentBackends.length > 0 ? (
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      <select
                        aria-label="执行工具"
                        value={attemptBackend}
                        onChange={(e) => setAttemptBackend(e.target.value as AgentBackend)}
                        className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs"
                      >
                        {app.agentBackends.map((b) => (
                          <option key={b} value={b}>
                            {b}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="关联工作区"
                        value={attemptWorkspace}
                        onChange={(e) => setAttemptWorkspace(e.target.value)}
                        className="rounded-md border border-[var(--line-strong)] bg-[var(--panel)] px-2 py-1 text-xs"
                      >
                        <option value="">无目录（纯记忆）</option>
                        {app.agentWorkspaces.map((ws) => (
                          <option key={ws.id} value={ws.id}>
                            {ws.path}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          void app.handleProposeWorkItemAttempt(
                            item,
                            attemptBackend,
                            attemptWorkspace || null,
                            "",
                          )
                        }
                        className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-1 font-medium text-[var(--accent)]"
                      >
                        创建只读提案
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
