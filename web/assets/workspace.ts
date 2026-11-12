/** Local navigation only: switching views retains drafts, forms and loaded results. */
import { workspaceButtons, workspacePanels, workspaceTitle } from "./dom.ts";

export type WorkspaceView = keyof typeof workspacePanels;

const titles: Readonly<Record<WorkspaceView, string>> = {
  chat: "长期对话",
  memory: "记忆空间",
  agenda: "待办计划",
  search: "查询记忆",
  tools: "Agent 与任务",
};

export function activateWorkspace(view: WorkspaceView, focusContent = false): void {
  for (const key of Object.keys(workspacePanels) as WorkspaceView[]) {
    workspacePanels[key].hidden = key !== view;
    if (key === view) workspaceButtons[key].setAttribute("aria-current", "page");
    else workspaceButtons[key].removeAttribute("aria-current");
  }
  workspaceTitle.textContent = titles[view];
  // Close the mobile tool menu after navigating so it cannot cover the page heading.
  workspaceButtons.tools.closest("details")?.removeAttribute("open");
  if (focusContent) {
    workspacePanels[view].setAttribute("tabindex", "-1");
    workspacePanels[view].focus();
  }
}

export function bindWorkspaceNavigation(): void {
  for (const key of Object.keys(workspaceButtons) as WorkspaceView[]) {
    workspaceButtons[key].addEventListener("click", () => activateWorkspace(key, true));
  }
}
