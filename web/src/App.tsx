import { Menu, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { AgentsView } from "./components/AgentsView.tsx";
import { AgendaView } from "./components/AgendaView.tsx";
import { ChatView } from "./components/ChatView.tsx";
import { ContextInspector } from "./components/ContextInspector.tsx";
import { MemoryView } from "./components/MemoryView.tsx";
import { SearchView } from "./components/SearchView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkItemsView } from "./components/WorkItemsView.tsx";
import { useDoggieApp, type WorkspaceTab } from "./store/useDoggieApp.ts";

const TAB_TITLES: Record<WorkspaceTab, string> = {
  chat: "主对话",
  memory: "记忆空间",
  "work-items": "工作目标",
  agenda: "待办计划",
  search: "检索记忆",
  agents: "Agent 与任务",
};

export function App() {
  const app = useDoggieApp();
  const pendingTotal = app.counts.pendingClarifications + app.counts.pendingApprovals;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <Sidebar app={app} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Compact 48px single-row top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--panel)] px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => app.setMobileMenuOpen(true)}
              aria-label="打开导航菜单"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-2)] hover:bg-[var(--panel-subtle)] md:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <h1 className="truncate text-sm font-semibold text-[var(--text)]">
              {TAB_TITLES[app.activeTab]}
            </h1>
            {app.activeTab === "chat" && !app.mainMode ? (
              <span className="rounded-full border border-[var(--warn-line)] bg-[var(--warn-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--warn)]">
                旧聊天模式
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {pendingTotal > 0 ? (
              <button
                type="button"
                onClick={app.openPendingInspector}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--warn-line)] bg-[var(--warn-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--warn)] hover:opacity-90"
              >
                <span>待决 {pendingTotal}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => app.setInspectorOpen(!app.inspectorOpen)}
              aria-label={app.inspectorOpen ? "收起检视抽屉" : "打开检视抽屉"}
              className={[
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors",
                app.inspectorOpen
                  ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--line)] bg-[var(--panel)] text-[var(--text-2)] hover:bg-[var(--panel-subtle)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {app.inspectorOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">检视</span>
            </button>
          </div>
        </header>

        {/* Shared status / warning banner */}
        {app.status !== null ? (
          <div
            role="status"
            aria-live="polite"
            className={[
              "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs",
              app.status.tone === "warning"
                ? "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]"
                : app.status.tone === "danger"
                  ? "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]"
                  : app.status.tone === "success"
                    ? "border-[var(--success-line)] bg-[var(--success-soft)] text-[var(--success)]"
                    : "border-[var(--line)] bg-[var(--panel-subtle)] text-[var(--text-2)]",
            ].join(" ")}
          >
            <span className="min-w-0 flex-1">{app.status.text}</span>
            <button
              type="button"
              onClick={app.clearBanner}
              aria-label="关闭提示"
              className="rounded p-0.5 hover:bg-black/5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main
            id="workspace-content"
            tabIndex={-1}
            className="flex min-w-0 flex-1 flex-col overflow-hidden"
          >
            {app.activeTab === "chat" ? <ChatView app={app} /> : null}
            {app.activeTab === "memory" ? <MemoryView app={app} /> : null}
            {app.activeTab === "work-items" ? <WorkItemsView app={app} /> : null}
            {app.activeTab === "agenda" ? <AgendaView app={app} /> : null}
            {app.activeTab === "search" ? <SearchView app={app} /> : null}
            {app.activeTab === "agents" ? <AgentsView app={app} /> : null}
          </main>

          <ContextInspector app={app} />
        </div>
      </div>
    </div>
  );
}
