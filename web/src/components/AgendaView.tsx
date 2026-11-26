import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  RefreshCw,
  Repeat,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TodoDto } from "../../../src/http/dto.ts";
import type { DoggieAppController } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localTimeZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function toLocalDateTimeInput(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fromLocalDateTimeInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

function formatClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatFullNow(date: Date): string {
  const wd = WEEKDAYS[date.getDay()] ?? "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${wd} ${formatClock(date)}`;
}

function formatDateTag(date: Date, now: Date): string {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((targetStart - dayStart) / 86_400_000);
  if (diffDays === 0) return `今天 ${formatClock(date)}`;
  if (diffDays === 1) return `明天 ${formatClock(date)}`;
  if (diffDays === 2) return `后天 ${formatClock(date)}`;
  if (diffDays === -1) return `昨天 ${formatClock(date)}`;
  const wd = WEEKDAYS[date.getDay()] ?? "";
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${wd} ${formatClock(date)}`;
}

function formatRelativeDelta(
  targetMs: number,
  nowMs: number,
): {
  readonly label: string;
  readonly overdue: boolean;
} {
  const diffMs = targetMs - nowMs;
  const overdue = diffMs < 0;
  const absMinutes = Math.round(Math.abs(diffMs) / 60_000);
  if (absMinutes < 1) return { label: "就在现在", overdue: false };
  if (absMinutes < 60) {
    return {
      label: overdue ? `已逾期 ${absMinutes} 分钟` : `${absMinutes} 分钟后`,
      overdue,
    };
  }
  const hours = Math.floor(absMinutes / 60);
  const mins = absMinutes % 60;
  if (hours < 24) {
    const text = mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
    return {
      label: overdue ? `已逾期 ${text}` : `还有 ${text}`,
      overdue,
    };
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const text = remHours > 0 ? `${days} 天 ${remHours} 小时` : `${days} 天`;
  return {
    label: overdue ? `已逾期 ${text}` : `还有 ${text}`,
    overdue,
  };
}

function formatRepeatRule(rule: NonNullable<TodoDto["todo_rule"]>): string {
  const unit = rule.frequency === "daily" ? "天" : rule.frequency === "weekly" ? "周" : "月";
  return `每 ${rule.interval} ${unit}`;
}

function statusLabel(status: TodoDto["status"]): string {
  switch (status) {
    case "open":
      return "待开始";
    case "in_progress":
      return "进行中";
    case "blocked":
      return "已阻塞";
    case "done":
      return "已完成";
    case "cancelled":
      return "已取消";
  }
}

function primaryAnchorIso(todo: TodoDto): string | null {
  return todo.scheduled_at ?? todo.due_at;
}

function TimelineTodoItem({
  todo,
  now,
  app,
  variant,
}: {
  readonly todo: TodoDto;
  readonly now: Date;
  readonly app: DoggieAppController;
  readonly variant: "overdue" | "scheduled" | "unscheduled" | "history";
}) {
  const [scheduledLocal, setScheduledLocal] = useState(() =>
    toLocalDateTimeInput(todo.scheduled_at),
  );
  const [dueLocal, setDueLocal] = useState(() => toLocalDateTimeInput(todo.due_at));

  useEffect(() => {
    setScheduledLocal(toLocalDateTimeInput(todo.scheduled_at));
    setDueLocal(toLocalDateTimeInput(todo.due_at));
  }, [todo.due_at, todo.scheduled_at]);

  const anchorIso = primaryAnchorIso(todo);
  const anchorDate = anchorIso !== null ? new Date(anchorIso) : null;
  const delta =
    anchorDate !== null && Number.isFinite(anchorDate.getTime())
      ? formatRelativeDelta(anchorDate.getTime(), now.getTime())
      : null;
  const entryId = todo.entry_id;
  const rawPhrase = todo.todo_raw_time?.scheduled_text ?? todo.todo_raw_time?.due_text ?? null;
  const isActive =
    todo.status === "open" || todo.status === "in_progress" || todo.status === "blocked";

  const dotClass =
    variant === "overdue"
      ? "border-[var(--danger)] bg-[var(--danger)]"
      : variant === "scheduled"
        ? "border-[var(--accent)] bg-[var(--bg)]"
        : variant === "history"
          ? "border-[var(--line-strong)] bg-[var(--panel-subtle)]"
          : "border-[var(--line-strong)] bg-[var(--bg)]";

  return (
    <div className="relative pl-6">
      <span
        aria-hidden="true"
        className={["absolute top-4 -left-[7px] h-3 w-3 rounded-full border-2", dotClass].join(" ")}
      />
      <article
        className={[
          "rounded-xl border p-3.5 text-xs transition-colors",
          variant === "overdue"
            ? "border-[var(--danger-line)] bg-[var(--danger-soft)]"
            : variant === "history"
              ? "border-[var(--line)] bg-[var(--panel-subtle)] opacity-75"
              : "border-[var(--line)] bg-[var(--panel)] hover:border-[var(--line-strong)]",
        ].join(" ")}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {anchorDate !== null && delta !== null ? (
              <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1 font-semibold text-[var(--text)]">
                  <Clock className="h-3 w-3 opacity-75" />
                  <span>{formatDateTag(anchorDate, now)}</span>
                </span>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 font-medium",
                    delta.overdue && isActive
                      ? "bg-[var(--danger)] text-white"
                      : "bg-[var(--panel-subtle)] text-[var(--text-2)]",
                  ].join(" ")}
                >
                  {delta.label}
                </span>
                {todo.due_at !== null && todo.scheduled_at === null ? (
                  <span className="rounded-full border border-[var(--warn-line)] bg-[var(--warn-soft)] px-1.5 py-0.5 text-[10px] text-[var(--warn)]">
                    截止
                  </span>
                ) : null}
                {rawPhrase ? <span className="text-[var(--muted)]">原文：{rawPhrase}</span> : null}
              </div>
            ) : null}

            <div className="text-[14px] font-medium text-[var(--text)]">{todo.text}</div>

            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
              {todo.scheduled_at !== null && todo.due_at !== null ? (
                <span>截止：{formatDateTag(new Date(todo.due_at), now)}</span>
              ) : null}
              {todo.todo_rule !== null ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  <Repeat className="h-2.5 w-2.5" />
                  <span>{formatRepeatRule(todo.todo_rule)}</span>
                </span>
              ) : null}
            </div>
          </div>

          <span
            className={[
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              todo.status === "done"
                ? "border border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
                : todo.status === "in_progress"
                  ? "border border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border border-[var(--line)] bg-[var(--panel-subtle)] text-[var(--text-2)]",
            ].join(" ")}
          >
            {statusLabel(todo.status)}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {todo.status === "open" ? (
            <button
              type="button"
              onClick={() => void app.handleTodoTransition(todo, "in_progress")}
              className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 text-[var(--text)] hover:bg-[var(--panel-subtle)]"
            >
              开始进行
            </button>
          ) : null}
          {isActive ? (
            <>
              <button
                type="button"
                onClick={() => void app.handleTodoTransition(todo, "done")}
                className="inline-flex items-center gap-1 rounded-lg border border-[var(--success-line)] bg-[var(--success-soft)] px-2.5 py-1 font-medium text-[var(--success)] hover:opacity-90"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>完成</span>
              </button>
              {todo.todo_rule !== null ? (
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
                className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[var(--muted)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]"
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void app.handleTodoReopen(todo)}
              className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-2.5 py-1 hover:bg-[var(--panel-subtle)]"
            >
              重新打开
            </button>
          )}
          {entryId !== null ? (
            <button
              type="button"
              onClick={() => void app.inspectEntrySource(todo.bucket_id, entryId)}
              className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1 text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]"
            >
              <FileText className="h-3 w-3" />
              <span>查看来源</span>
            </button>
          ) : null}
        </div>

        <details className="mt-2.5 border-t border-[var(--line)] pt-2">
          <summary className="cursor-pointer text-[11px] text-[var(--muted)] hover:text-[var(--text)]">
            {anchorIso === null ? "设置排期加入时间轴" : "调整计划 / 截止时间"}
          </summary>
          <div className="mt-2 flex flex-wrap items-end gap-2.5">
            <label className="text-[11px] text-[var(--text-2)]">
              计划时间
              <input
                type="datetime-local"
                value={scheduledLocal}
                onChange={(e) => setScheduledLocal(e.target.value)}
                className="mt-0.5 block rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
              />
            </label>
            <label className="text-[11px] text-[var(--text-2)]">
              截止时间
              <input
                type="datetime-local"
                value={dueLocal}
                onChange={(e) => setDueLocal(e.target.value)}
                className="mt-0.5 block rounded-lg border border-[var(--line-strong)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                const scheduledAt = fromLocalDateTimeInput(scheduledLocal);
                const dueAt = fromLocalDateTimeInput(dueLocal);
                void app.handleTodoPlan(todo, {
                  command_text: "通过时间轴界面更新待办计划",
                  scheduled_at: scheduledAt,
                  due_at: dueAt,
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
                  raw_time:
                    scheduledAt !== null || dueAt !== null
                      ? {
                          scheduled_text: scheduledAt !== null ? scheduledLocal : null,
                          due_text: dueAt !== null ? dueLocal : null,
                          time_zone: localTimeZoneName(),
                        }
                      : null,
                });
              }}
              className="rounded-lg bg-[var(--send-bg)] px-3 py-1.5 font-medium text-[var(--send-text)] hover:opacity-90"
            >
              保存排期
            </button>
          </div>
        </details>
      </article>
    </div>
  );
}

export function AgendaView({ app }: Props) {
  const [liveNow, setLiveNow] = useState<Date>(() =>
    app.agendaNow ? new Date(app.agendaNow) : new Date(),
  );

  useEffect(() => {
    if (app.agendaNow) {
      const parsed = new Date(app.agendaNow);
      if (Number.isFinite(parsed.getTime())) setLiveNow(parsed);
    }
  }, [app.agendaNow]);

  useEffect(() => {
    const timer = window.setInterval(() => setLiveNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(() => {
    const nowMs = liveNow.getTime();
    const todayStart = new Date(
      liveNow.getFullYear(),
      liveNow.getMonth(),
      liveNow.getDate(),
    ).getTime();
    const tomorrowStart = todayStart + 86_400_000;
    const dayAfterTomorrowStart = tomorrowStart + 86_400_000;

    const overdue: TodoDto[] = [];
    const today: TodoDto[] = [];
    const tomorrow: TodoDto[] = [];
    const upcoming: TodoDto[] = [];
    const unscheduled: TodoDto[] = [];
    const history: TodoDto[] = [];

    const sortByTime = (a: TodoDto, b: TodoDto) => {
      const ta = primaryAnchorIso(a);
      const tb = primaryAnchorIso(b);
      if (ta && tb) return ta.localeCompare(tb);
      if (ta) return -1;
      if (tb) return 1;
      return b.created_at.localeCompare(a.created_at);
    };

    for (const todo of app.agenda) {
      if (todo.status === "done" || todo.status === "cancelled") {
        history.push(todo);
        continue;
      }
      const anchor = primaryAnchorIso(todo);
      if (anchor === null) {
        unscheduled.push(todo);
        continue;
      }
      const anchorMs = Date.parse(anchor);
      if (!Number.isFinite(anchorMs)) {
        unscheduled.push(todo);
        continue;
      }
      if (anchorMs < nowMs) {
        overdue.push(todo);
      } else if (anchorMs < tomorrowStart) {
        today.push(todo);
      } else if (anchorMs < dayAfterTomorrowStart) {
        tomorrow.push(todo);
      } else {
        upcoming.push(todo);
      }
    }

    overdue.sort(sortByTime);
    today.sort(sortByTime);
    tomorrow.sort(sortByTime);
    upcoming.sort(sortByTime);
    unscheduled.sort(sortByTime);
    history.sort(sortByTime);

    return { overdue, today, tomorrow, upcoming, unscheduled, history };
  }, [app.agenda, liveNow]);

  const scheduledUpcomingCount =
    groups.today.length + groups.tomorrow.length + groups.upcoming.length;
  const tz = localTimeZoneName();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-5 sm:px-6">
      <div className="mx-auto w-full max-w-[780px] space-y-5">
        {/* Header + Live Reference Clock */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">时间轴与待办</h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              在主对话中直接说「明天早上8点完成计网作业」即可自动纳入时间轴，所有排期均以标准时间戳
              + 本地时区持久化，便于比对时间与后续扩展定时提醒。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void app.refreshAgenda(!app.agendaIncludeHistory)}
              className="rounded-lg border border-[var(--line-strong)] bg-[var(--panel)] px-3 py-1.5 text-xs text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]"
            >
              {app.agendaIncludeHistory ? "隐藏已完成" : "包含已完成"}
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

        {/* Live Time Anchor Summary Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--line)] bg-[var(--panel-subtle)] px-4 py-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[var(--success)]" aria-hidden="true" />
            <span className="font-semibold text-[var(--text)]">{formatFullNow(liveNow)}</span>
            <span className="text-[11px] text-[var(--muted)]">{tz}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {groups.overdue.length > 0 ? (
              <span className="rounded-full border border-[var(--danger-line)] bg-[var(--danger-soft)] px-2.5 py-0.5 font-medium text-[var(--danger)]">
                已逾期 {groups.overdue.length}
              </span>
            ) : null}
            <span className="rounded-full border border-[var(--line)] bg-[var(--panel)] px-2.5 py-0.5 text-[var(--text-2)]">
              今日 {groups.today.length}
            </span>
            <span className="rounded-full border border-[var(--line)] bg-[var(--panel)] px-2.5 py-0.5 text-[var(--text-2)]">
              明日及以后 {groups.tomorrow.length + groups.upcoming.length}
            </span>
            <span className="rounded-full border border-[var(--line)] bg-[var(--panel)] px-2.5 py-0.5 text-[var(--muted)]">
              未排期 {groups.unscheduled.length}
            </span>
          </div>
        </div>

        {app.agenda.length === 0 ? (
          <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] py-14 text-center text-xs text-[var(--muted)]">
            <CalendarClock className="mx-auto mb-2.5 h-7 w-7 opacity-50" />
            <p className="text-sm font-medium text-[var(--text)]">时间轴目前为空</p>
            <p className="mt-1">
              回到主对话直接输入「明天早上写计网作业」或「周五下午3点前提交报告」，会自动解析时间并排入此处。
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Vertical Timeline Rail with Live NOW Anchor */}
            <section aria-label="时间轴" className="relative ml-2 border-l-2 border-[var(--line)]">
              {/* Overdue (above NOW) */}
              {groups.overdue.length > 0 ? (
                <div className="mb-5 space-y-3">
                  <div className="flex items-center gap-1.5 pl-6 text-xs font-semibold text-[var(--danger)]">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>已逾期 ({groups.overdue.length})</span>
                  </div>
                  {groups.overdue.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="overdue"
                    />
                  ))}
                </div>
              ) : null}

              {/* Live NOW anchor divider */}
              <div className="relative my-4 flex items-center pl-6">
                <span
                  aria-hidden="true"
                  className="absolute -left-[8px] h-3.5 w-3.5 rounded-full border-2 border-[var(--bg)] bg-[var(--accent)]"
                />
                <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-[11px] font-semibold text-white">
                  现在 · {formatClock(liveNow)}
                </span>
                <div className="ml-2 h-px flex-1 bg-[var(--accent-line)]" />
              </div>

              {/* Today */}
              {groups.today.length > 0 ? (
                <div className="mb-5 space-y-3">
                  <div className="pl-6 text-xs font-semibold text-[var(--text-2)]">
                    今天 ({groups.today.length})
                  </div>
                  {groups.today.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="scheduled"
                    />
                  ))}
                </div>
              ) : null}

              {/* Tomorrow */}
              {groups.tomorrow.length > 0 ? (
                <div className="mb-5 space-y-3">
                  <div className="pl-6 text-xs font-semibold text-[var(--text-2)]">
                    明天 ({groups.tomorrow.length})
                  </div>
                  {groups.tomorrow.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="scheduled"
                    />
                  ))}
                </div>
              ) : null}

              {/* Upcoming */}
              {groups.upcoming.length > 0 ? (
                <div className="mb-5 space-y-3">
                  <div className="pl-6 text-xs font-semibold text-[var(--text-2)]">
                    后续排期 ({groups.upcoming.length})
                  </div>
                  {groups.upcoming.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="scheduled"
                    />
                  ))}
                </div>
              ) : null}

              {scheduledUpcomingCount === 0 ? (
                <div className="py-2 pl-6 text-xs text-[var(--muted)]">接下来暂无已排期待办。</div>
              ) : null}
            </section>

            {/* Unscheduled todos */}
            {groups.unscheduled.length > 0 ? (
              <section aria-label="未排期待办" className="space-y-3">
                <div className="text-xs font-semibold text-[var(--muted)]">
                  未排期 · 随时待办 ({groups.unscheduled.length})
                </div>
                <div className="ml-2 space-y-3 border-l-2 border-dashed border-[var(--line)]">
                  {groups.unscheduled.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="unscheduled"
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {/* Completed / Cancelled history */}
            {groups.history.length > 0 ? (
              <section aria-label="已完成与已取消" className="space-y-3">
                <div className="text-xs font-semibold text-[var(--muted)]">
                  已完成 / 已取消 ({groups.history.length})
                </div>
                <div className="ml-2 space-y-3 border-l-2 border-[var(--line)]">
                  {groups.history.map((todo) => (
                    <TimelineTodoItem
                      key={todo.id}
                      todo={todo}
                      now={liveNow}
                      app={app}
                      variant="history"
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
