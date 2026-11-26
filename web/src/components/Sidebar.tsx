import {
  CalendarClock,
  FolderKanban,
  Library,
  PanelLeftClose,
  Puzzle,
  Search,
  SquarePen,
  X,
} from "lucide-react";
import type { DoggieAppController, WorkspaceTab } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

type NavItem = {
  readonly id: WorkspaceTab;
  readonly label: string;
  readonly icon: typeof SquarePen;
  readonly badge?: number;
  readonly badgeTone?: "warn" | "neutral";
};

export function Sidebar({ app }: Props) {
  const items: readonly NavItem[] = [
    {
      id: "chat",
      label: "主对话",
      icon: SquarePen,
      ...(app.counts.pendingClarifications > 0
        ? { badge: app.counts.pendingClarifications, badgeTone: "warn" as const }
        : {}),
    },
    {
      id: "agenda",
      label: "时间轴与待办",
      icon: CalendarClock,
      ...(app.counts.openTodos > 0 ? { badge: app.counts.openTodos } : {}),
    },
    {
      id: "memory",
      label: "记忆空间",
      icon: Library,
      ...(app.counts.buckets > 0 ? { badge: app.counts.buckets } : {}),
    },
    {
      id: "work-items",
      label: "工作目标",
      icon: FolderKanban,
      ...(app.counts.activeWorkItems > 0 ? { badge: app.counts.activeWorkItems } : {}),
    },
    {
      id: "agents",
      label: "Agent 与任务",
      icon: Puzzle,
      ...(app.counts.pendingApprovals > 0
        ? { badge: app.counts.pendingApprovals, badgeTone: "warn" as const }
        : {}),
    },
  ];

  const openWorkItems = app.workItems.filter((item) => item.status === "open").slice(0, 4);
  const recentBuckets = app.buckets.slice(0, 8);

  const handleSelect = (tab: WorkspaceTab) => {
    app.setActiveTab(tab);
    app.setMobileMenuOpen(false);
  };

  const collapsed = app.sidebarCollapsed;

  return (
    <>
      {app.mobileMenuOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/45 md:hidden"
          onClick={() => app.setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <aside
        aria-label="工作区导航"
        className={[
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--line)] bg-[var(--sidebar-bg)] transition-[width,transform] duration-150 md:static",
          app.mobileMenuOpen ? "w-[260px] translate-x-0" : "-translate-x-full",
          collapsed ? "md:w-0 md:overflow-hidden md:border-r-0" : "md:w-[260px] md:translate-x-0",
        ].join(" ")}
      >
        {/* Top brand bar matching ChatGPT web */}
        <div className="flex h-12 shrink-0 items-center justify-between px-3">
          <button
            type="button"
            onClick={app.clearInputAndFocusChat}
            className="rounded-lg px-1.5 py-1 text-[15px] font-semibold tracking-tight text-[var(--text)] hover:bg-[var(--panel-subtle)]"
          >
            Doggie
          </button>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => handleSelect("search")}
              aria-label="检索记忆"
              title="检索记忆"
              className={[
                "inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-2)] transition-colors hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
                app.activeTab === "search" ? "bg-[var(--panel-subtle)] text-[var(--text)]" : "",
              ].join(" ")}
            >
              <Search className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => app.setSidebarCollapsed(true)}
              aria-label="折叠侧栏"
              title="折叠侧栏"
              className="hidden h-8 w-8 items-center justify-center rounded-lg text-[var(--text-2)] transition-colors hover:bg-[var(--panel-subtle)] hover:text-[var(--text)] md:inline-flex"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => app.setMobileMenuOpen(false)}
              aria-label="关闭导航菜单"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-2)] hover:bg-[var(--panel-subtle)] md:hidden"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable nav & quick-access sections */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <nav aria-label="主要功能" className="space-y-0.5">
            {items.map((item) => {
              const Icon = item.icon;
              const current = app.activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={current ? "page" : undefined}
                  onClick={() => handleSelect(item.id)}
                  className={[
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors",
                    current
                      ? "bg-[var(--panel-subtle)] font-medium text-[var(--text)]"
                      : "text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
                  ].join(" ")}
                >
                  <Icon className="h-4 w-4 shrink-0 opacity-85" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.badge !== undefined ? (
                    <span
                      className={[
                        "rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none",
                        item.badgeTone === "warn"
                          ? "border border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]"
                          : "text-[var(--muted)]",
                      ].join(" ")}
                    >
                      {item.badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>

          {/* Active WorkItems ("项目" section in ChatGPT layout) */}
          <div className="mt-5 px-2.5">
            <div className="mb-1.5 text-[11px] font-medium text-[var(--muted)]">
              项目 · 工作目标
            </div>
            {openWorkItems.length === 0 ? (
              <div className="py-1 text-xs text-[var(--muted)]">没有活跃目标</div>
            ) : (
              <div className="-mx-2 space-y-0.5">
                {openWorkItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      app.inspectWorkItem(item.id);
                      app.setMobileMenuOpen(false);
                    }}
                    className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--text-2)] transition-colors hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]"
                  >
                    <span className="truncate">{item.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Recent Memory Buckets ("最近" section in ChatGPT layout) */}
          <div className="mt-5 px-2.5 pb-4">
            <div className="mb-1.5 text-[11px] font-medium text-[var(--muted)]">
              最近 · 记忆主题
            </div>
            {recentBuckets.length === 0 ? (
              <div className="py-1 text-xs text-[var(--muted)]">暂无归档记忆</div>
            ) : (
              <div className="-mx-2 space-y-0.5">
                {recentBuckets.map((bucket) => (
                  <button
                    key={bucket.id}
                    type="button"
                    onClick={() => {
                      void app.openBucketInMemory(bucket.id, true);
                      app.setMobileMenuOpen(false);
                    }}
                    className={[
                      "flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors",
                      app.activeTab === "memory" && app.selectedBucketId === bucket.id
                        ? "bg-[var(--panel-subtle)] font-medium text-[var(--text)]"
                        : "text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
                    ].join(" ")}
                  >
                    <span className="truncate">{bucket.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Bottom local status bar matching ChatGPT account footer */}
        <div className="shrink-0 border-t border-[var(--line)] p-2.5">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
            <div
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--send-bg)] text-xs font-semibold text-[var(--send-text)]"
            >
              D
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-[var(--text)]">Doggie 本地助手</div>
              <div className="flex items-center gap-1.5 truncate text-[11px] text-[var(--muted)]">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                <span>单机 SQLite · 主对话</span>
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
