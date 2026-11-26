import { Bot, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { AgentBackend } from "../../../src/domain/agent.ts";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

export function AgentsView({ app }: Props) {
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceBucket, setWorkspaceBucket] = useState("");
  const [backend, setBackend] = useState<AgentBackend>("codex");
  const [workspaceId, setWorkspaceId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [instruction, setInstruction] = useState("");

  const submitWorkspace = async () => {
    if (!workspacePath.trim()) return;
    const ok = await app.handleRegisterWorkspace(workspacePath.trim(), workspaceBucket);
    if (ok) {
      setWorkspacePath("");
      setWorkspaceBucket("");
    }
  };

  const submitProposal = async () => {
    if (!instruction.trim()) return;
    const ok = await app.handleProposeAgent({
      backend,
      instruction: instruction.trim(),
      workspaceId: workspaceId || null,
      sessionId,
    });
    if (ok) {
      setInstruction("");
      setSessionId("");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">Agent 只读执行与后台任务</h2>
            <p className="text-xs text-[var(--muted)]">
              提案与显式批准严格分两步执行；工具输出仅作只读结果，不会自动写入长期记忆。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void Promise.all([app.refreshTasks(), app.refreshAgents()])}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--panel-subtle)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>刷新状态</span>
            </button>
          </div>
        </div>

        <section className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 text-xs">
          <div className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]">
            <ShieldCheck className="h-4 w-4 text-[var(--accent)]" />
            <span>创建只读 CLI 提案</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[var(--text-2)]">
              CLI 工具
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value as AgentBackend)}
                className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
              >
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label className="block text-[var(--text-2)]">
              工作区
              <select
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
              >
                <option value="">无目录（仅记忆工具）</option>
                {app.agentWorkspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.path} · {ws.baseCommit.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-3 block text-[var(--text-2)]">
            恢复会话 ID（可选）
            <input
              type="text"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="仅在同工作区与范围未变时恢复"
              className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
            />
          </label>
          <label className="mt-3 block text-[var(--text-2)]">
            只读任务指令
            <textarea
              rows={3}
              maxLength={12000}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：阅读项目并说明撤销机制的测试覆盖"
              className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
            />
          </label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--muted)]">
              创建提案不会启动进程，请在下方列表核对后点击「批准只读执行」。
            </span>
            <button
              type="button"
              onClick={() => void submitProposal()}
              className="rounded-lg bg-[var(--accent)] px-3.5 py-1.5 font-medium text-[var(--panel)] hover:bg-[var(--accent-hover)]"
            >
              创建待批准提案
            </button>
          </div>

          <details className="mt-4 border-t border-[var(--line)] pt-3">
            <summary className="cursor-pointer font-medium text-[var(--text-2)]">
              登记本地工作区与 Git 基线
            </summary>
            <div className="mt-2.5 flex flex-wrap items-end gap-2">
              <label className="min-w-[220px] flex-1 text-[var(--text-2)]">
                目录绝对路径
                <input
                  type="text"
                  value={workspacePath}
                  onChange={(e) => setWorkspacePath(e.target.value)}
                  placeholder="/home/user/project"
                  className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
                />
              </label>
              <label className="w-48 text-[var(--text-2)]">
                关联 Bucket ID（可选）
                <input
                  type="text"
                  value={workspaceBucket}
                  onChange={(e) => setWorkspaceBucket(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2.5 py-1.5 text-xs text-[var(--text)]"
                />
              </label>
              <button
                type="button"
                onClick={() => void submitWorkspace()}
                className="rounded-lg border border-[var(--line-strong)] px-3 py-1.5 font-medium hover:bg-[var(--panel-subtle)]"
              >
                登记目录
              </button>
            </div>
          </details>
        </section>

        <section className="space-y-3">
          <div className="text-xs font-semibold text-[var(--muted)]">
            Agent 提案与执行记录 ({app.agentTasks.length})
          </div>
          {app.agentTasks.length === 0 ? (
            <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] py-8 text-center text-xs text-[var(--muted)]">
              <Bot className="mx-auto mb-2 h-6 w-6 opacity-50" />
              <p>暂无 Agent 提案或执行记录。</p>
            </div>
          ) : (
            app.agentTasks.map((task) => (
              <article
                key={task.id}
                className={[
                  "rounded-xl border p-4 text-xs",
                  task.status === "pending"
                    ? "border-[var(--warn-line)] bg-[var(--warn-soft)]"
                    : "border-[var(--line)] bg-[var(--panel)]",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold text-[var(--text)]">
                    {task.backend} · {task.status}
                  </div>
                  <span className="font-mono text-[11px] text-[var(--muted)]">
                    session: {task.sessionId.slice(0, 8)}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-[var(--text)]">
                  {task.instruction}
                </p>
                {task.output ? (
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] p-2.5 whitespace-pre-wrap break-words font-mono text-[11px]">
                    {task.output}
                  </pre>
                ) : null}
                {task.failureCode ? (
                  <p className="mt-1.5 text-[var(--danger)]">失败代码：{task.failureCode}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {task.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void app.handleAgentAction(task, "approve")}
                        className="rounded-lg bg-[var(--accent)] px-3 py-1 font-medium text-[var(--panel)]"
                      >
                        批准只读执行
                      </button>
                      <button
                        type="button"
                        onClick={() => void app.handleAgentAction(task, "reject")}
                        className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1"
                      >
                        拒绝
                      </button>
                    </>
                  ) : null}
                  {task.status === "queued" || task.status === "running" ? (
                    <button
                      type="button"
                      onClick={() => void app.handleAgentAction(task, "cancel")}
                      className="rounded-lg border border-[var(--danger-line)] px-3 py-1 text-[var(--danger)]"
                    >
                      取消任务
                    </button>
                  ) : null}
                </div>
              </article>
            ))
          )}
        </section>

        <section className="space-y-2">
          <div className="text-xs font-semibold text-[var(--muted)]">
            后台任务队列 ({app.tasks.length})
          </div>
          {app.tasks.length === 0 ? (
            <p className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
              最近没有后台队列任务。
            </p>
          ) : (
            <div className="space-y-2">
              {app.tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-[var(--panel)] px-3.5 py-2.5 text-xs"
                >
                  <div>
                    <span className="font-mono text-[11px] text-[var(--muted)]">
                      {task.id.slice(0, 8)}
                    </span>{" "}
                    · <strong className="text-[var(--text)]">{task.status}</strong>
                    {task.errorCode ? (
                      <span className="ml-2 text-[var(--danger)]">({task.errorCode})</span>
                    ) : null}
                  </div>
                  {task.status === "queued" || task.status === "running" ? (
                    <button
                      type="button"
                      onClick={() => void app.handleCancelBackgroundTask(task.id)}
                      className="rounded-md border border-[var(--danger-line)] px-2 py-0.5 text-[11px] text-[var(--danger)]"
                    >
                      取消
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
