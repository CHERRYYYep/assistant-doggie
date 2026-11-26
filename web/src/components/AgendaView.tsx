import { CalendarCheck2, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { TodoDto } from "../../../src/http/dto.ts";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

function formatRepeatRule(rule: NonNullable<TodoDto["todo_rule"]>): string {
  const unit = rule.frequency === "daily" ? "天" : rule.frequency === "weekly" ? "周" : "月";
  return `每 ${rule.interval} ${unit}`;
}

function TodoCard({ todo, app }: { readonly todo: TodoDto; readonly app: DoggieAppController }) {
  const [scheduledAt, setScheduledAt] = useState(todo.scheduled_at ?? "");
  const [dueAt, setDueAt] = useState(todo.due_at ?? "");
  const entryId = todo.entry_id;

  return (
    <article className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="text-sm font-medium text-[var(--text)]">{todo.text}</div>
        <span className="rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
          {todo.status}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-[var(--muted)]">
        {todo.scheduled_at ? <span>计划：{todo.scheduled_at}</span> : null}
        {todo.due_at ? <span>截止：{todo.due_at}</span> : null}
        {todo.todo_rule ? <span>重复：{formatRepeatRule(todo.todo_rule)}</span> : null}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {todo.status === "open" ? (
          <button
            type="button"
            onClick={() => void app.handleTodoTransition(todo, "in_progress")}
            className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1 hover:bg-[var(--panel-subtle)]"
          >
            开始进行
          </button>
        ) : null}
        {todo.status === "open" || todo.status === "in_progress" ? (
          <>
            <button
              type="button"
              onClick={() => void app.handleTodoTransition(todo, "done")}
              className="rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] px-2.5 py-1 font-medium text-[var(--success)]"
            >
              完成
            </button>
            {todo.todo_rule ? (
              <button
                type="button"
                onClick={() => void app.handleTodoAdvance(todo)}
                className="rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-1 text-[var(--accent)]"
              >
                完成并推进下次
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void app.handleTodoTransition(todo, "cancelled")}
              className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1 text-[var(--text-2)]"
            >
              取消
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => void app.handleTodoReopen(todo)}
            className="rounded-lg border border-[var(--line-strong)] px-2.5 py-1"
          >
            重新打开
          </button>
        )}
        {entryId !== null ? (
          <button
            type="button"
            onClick={() => void app.inspectEntrySource(todo.bucket_id, entryId)}
            className="ml-auto rounded-lg border border-[var(--line)] px-2.5 py-1 text-[var(--text-2)] hover:bg-[var(--panel-subtle)]"
          >
            查看来源
          </button>
        ) : null}
      </div>

      <details className="mt-3 border-t border-[var(--line)] pt-2">
        <summary className="cursor-pointer text-[11px] text-[var(--muted)]">
          编辑计划 / 截止时间
        </summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-[11px] text-[var(--text-2)]">
            计划时间（ISO）
            <input
              type="text"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              placeholder="2026-11-27T09:00:00Z"
              className="mt-0.5 block rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
          </label>
          <label className="text-[11px] text-[var(--text-2)]">
            截止时间（ISO）
            <input
              type="text"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              placeholder="2026-11-28T18:00:00Z"
              className="mt-0.5 block rounded-md border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              void app.handleTodoPlan(todo, {
                command_text: "通过界面更新待办计划",
                scheduled_at: scheduledAt.trim() || null,
                due_at: dueAt.trim() || null,
                repeat_rule:
                  todo.todo_rule === null
                    ? null
                    : {
                        frequency: todo.todo_rule.frequency,
                        interval: todo.todo_rule.interval,
                        ...(todo.todo_rule.weekdays !== null
                          ? { weekdays: [...todo.todo_rule.weekdays] }
                          : {}),
                        ...(todo.todo_rule.until !== null ? { until: todo.todo_rule.until } : {}),
                        ...(todo.todo_rule.count !== null ? { count: todo.todo_rule.count } : {}),
                      },
                raw_time: todo.todo_raw_time,
              })
            }
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--panel)]"
          >
            保存计划
          </button>
        </div>
      </details>
    </article>
  );
}

export function AgendaView({ app }: Props) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">待办计划</h2>
            <p className="text-xs text-[var(--muted)]">
              独立于 WorkItem 与后台任务队列的个人待办，支持重复推进与时间计划。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void app.refreshAgenda(!app.agendaIncludeHistory)}
              className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs hover:bg-[var(--panel-subtle)]"
            >
              {app.agendaIncludeHistory ? "仅看活跃待办" : "包含历史待办"}
            </button>
            <button
              type="button"
              onClick={() => void app.refreshAgenda(app.agendaIncludeHistory)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--panel-subtle)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>刷新</span>
            </button>
          </div>
        </div>

        {app.agenda.length === 0 ? (
          <div className="rounded-xl border border-[var(--line)] bg-[var(--panel)] py-12 text-center text-xs text-[var(--muted)]">
            <CalendarCheck2 className="mx-auto mb-2 h-7 w-7 opacity-50" />
            <p>当前没有待办事项。</p>
          </div>
        ) : (
          <div className="space-y-3">
            {app.agenda.map((todo) => (
              <TodoCard key={todo.id} todo={todo} app={app} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
