import type { WorkspaceTab } from "@/issue-flow-model"

export type WorkspaceRoute = {
  gitServerId: string
  projectId: string
  tab: WorkspaceTab
}

const tabs = new Set<WorkspaceTab>(["overview", "settings"])

export function parseWorkspaceRoute(pathname = window.location.pathname, search = window.location.search): WorkspaceRoute {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  const queryTab = new URLSearchParams(search).get("tab")
  const pathTab = parts[3]
  const tab = tabs.has(pathTab as WorkspaceTab)
    ? pathTab as WorkspaceTab
    : tabs.has(queryTab as WorkspaceTab)
      ? queryTab as WorkspaceTab
      : "overview"
  if (parts[0] !== "repos") {
    return { gitServerId: "", projectId: "", tab: "overview" }
  }
  return {
    gitServerId: parts[1] || "",
    projectId: parts[2] || "",
    tab,
  }
}

export function workspaceRoutePath(route: Partial<WorkspaceRoute>) {
  if (!route.gitServerId) return "/repos"
  const server = encodeURIComponent(route.gitServerId)
  if (!route.projectId) return `/repos/${server}`
  const project = encodeURIComponent(route.projectId)
  return route.tab === "settings"
    ? `/repos/${server}/${project}/settings`
    : `/repos/${server}/${project}`
}

export function sameWorkspaceRoute(a: Partial<WorkspaceRoute>, b: Partial<WorkspaceRoute>) {
  return (a.gitServerId || "") === (b.gitServerId || "")
    && (a.projectId || "") === (b.projectId || "")
    && (a.tab || "overview") === (b.tab || "overview")
}
