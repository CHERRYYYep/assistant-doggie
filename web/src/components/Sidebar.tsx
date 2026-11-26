import {
  Bot,
  CalendarCheck2,
  FolderKanban,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Target,
  X,
} from "lucide-react";
import type { DoggieAppController, WorkspaceTab } from "../store/useDoggieApp.ts";

type Props = {
  readonly app: DoggieAppController;
};

type NavItem = {
  readonly id: WorkspaceTab;
  readonly label: string;
  readonly icon: typeof MessageSquare;
  readonly badge?: number;
  readonly badgeTone?: "accent" | "warn";
};

export function Sidebar({ app }: Props) {
  const items: readonly NavItem[] = [
    {
      id: "chat",
      label: "主对话",
      icon: MessageSquare,
      ...(app.counts.pendingClarifications > 0
        ? { badge: app.counts.pendingClarifications, badgeTone: "warn" as const }
        : {}),
    },
    {
      id: "memory",
      label: "记忆空间",
      icon: FolderKanban,
      ...(app.counts.buckets > 0 ? { badge: app.counts.buckets } : {}),
    },
    {
      id: "work-items",
      label: "工作目标",
      icon: Target,
      ...(app.counts.activeWorkItems > 0 ? { badge: app.counts.activeWorkItems } : {}),
    },
    {
      id: "agenda",
      label: "待办计划",
      icon: CalendarCheck2,
      ...(app.counts.openTodos > 0 ? { badge: app.counts.openTodos } : {}),
    },
    {
      id: "search",
      label: "检索记忆",
      icon: Search,
    },
    {
      id: "agents",
      label: "Agent 与任务",
      icon: Bot,
      ...(app.counts.pendingApprovals > 0
        ? { badge: app.counts.pendingApprovals, badgeTone: "warn" as const }
        : {}),
    },
  ];

  const handleSelect = (tab: WorkspaceTab) => {
    app.setActiveTab(tab);
    app.setMobileMenuOpen(false);
  };

  const collapsed = app.sidebarCollapsed;

  return (
    <>
      {app.mobileMenuOpen ? (
        <div
          className="fixed inset-0 z-30 bg-black/35 md:hidden"
          onClick={() => app.setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <aside
        aria-label="工作区导航"
        className={[
          "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-[var(--line)] bg-[var(--panel)] transition-[width,transform] duration-150 md:static md:translate-x-0",
          app.mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
          collapsed ? "w-64 md:w-16" : "w-64 md:w-60",
        ].join(" ")}
      >
        <div className="flex h-12 items-center justify-between border-b border-[var(--line)] px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-sm font-bold text-[var(--panel)]">
              d·
            </div>
            {!collapsed ? (
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold leading-tight">Doggie</div>
                <div className="truncate text-[11px] text-[var(--muted)]">个人工作记忆</div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="hidden h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)] md:inline-flex"
            onClick={() => app.setSidebarCollapsed(!collapsed)}
            title={collapsed ? "展开侧栏" : "折叠侧栏"}
            aria-label={collapsed ? "展开侧栏" : "折叠侧栏"}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-subtle)] md:hidden"
            onClick={() => app.setMobileMenuOpen(false)}
            aria-label="关闭导航菜单"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-2.5">
          <button
            type="button"
            onClick={app.clearInputAndFocusChat}
            title="清空输入，回到主对话"
            className={[
              "flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--panel-subtle)] px-3 py-2 text-xs font-medium text-[var(--text)] transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]",
              collapsed ? "md:px-0" : "",
            ].join(" ")}
          >
            <Plus className="h-4 w-4 shrink-0" />
            {!collapsed ? <span>清空输入</span> : null}
          </button>
        </div>

        <nav aria-label="主要功能" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
          {items.map((item) => {
            const Icon = item.icon;
            const current = app.activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={current ? "page" : undefined}
                title={collapsed ? item.label : undefined}
                onClick={() => handleSelect(item.id)}
                className={[
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors",
                  collapsed ? "md:justify-center md:px-0" : "",
                  current
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                    : "text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badge !== undefined ? (
                      <span
                        className={[
                          "rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none",
                          item.badgeTone === "warn"
                            ? "border border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]"
                            : "bg-[var(--panel-subtle)] text-[var(--muted)]",
                        ].join(" ")}
                      >
                        {item.badge}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-[var(--line)] p-3">
          <div
            className={[
              "flex items-center gap-2 text-[11px] text-[var(--muted)]",
              collapsed ? "md:justify-center" : "",
            ].join(" ")}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full bg-[var(--success)]"
              aria-hidden="true"
            />
            {!collapsed ? (
              <div className="min-w-0 truncate">
                <div className="font-medium text-[var(--text-2)]">本地优先</div>
                <div className="truncate text-[10px]">单机 SQLite · 统一入口</div>
              </div>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
