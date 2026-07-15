import type { WorkspaceTab } from "@/issue-flow-model"

export type WorkspaceRoute = {
  view: "repos" | "insights" | "settings" | "setup"
  gitServerId: string
  projectId: string
  tab: WorkspaceTab
  settingsSection: "account" | "agentrix" | "git-servers"
}

export type VisualArtifactRoute = {
  gitServerId: string
  projectId: string
  issueNumber: number
  artifactType: "decision" | "plan"
}

const tabs = new Set<WorkspaceTab>(["overview", "issues", "tasks", "settings"])

export function parseVisualArtifactRoute(pathname = window.location.pathname): VisualArtifactRoute | undefined {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  const artifactType = parts[0] === "repos" && parts[3] === "plan" && (parts[5] === "decision" || parts[5] === "plan")
    ? parts[5]
    : undefined
  const issueNumber = Number.parseInt(parts[4] || "", 10)
  if (!artifactType || parts.length !== 6 || !parts[1] || !parts[2] || !Number.isFinite(issueNumber) || issueNumber <= 0) return undefined
  return { gitServerId: parts[1], projectId: parts[2], issueNumber, artifactType }
}

export const setupRoute: WorkspaceRoute = {
  view: "setup",
  gitServerId: "",
  projectId: "",
  tab: "overview",
  settingsSection: "account",
}

export const userSettingsRoute: WorkspaceRoute = {
  view: "settings",
  gitServerId: "",
  projectId: "",
  tab: "overview",
  settingsSection: "account",
}

export const insightsRoute: WorkspaceRoute = {
  view: "insights",
  gitServerId: "",
  projectId: "",
  tab: "overview",
  settingsSection: "account",
}

export const gitServerSettingsRoute: WorkspaceRoute = {
  ...userSettingsRoute,
  settingsSection: "git-servers",
}

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
  if (parts[0] === "settings") {
    if (parts[1] === "git-servers") return gitServerSettingsRoute
    if (parts[1] === "agentrix" || parts[1] === "agentrix-cloud") return { ...userSettingsRoute, settingsSection: "agentrix" }
    return userSettingsRoute
  }
  if (parts[0] === "setup") {
    return setupRoute
  }
  if (parts[0] === "insights") {
    return insightsRoute
  }
  if (parts[0] !== "repos") {
    return {
      view: "repos",
      gitServerId: "",
      projectId: "",
      tab: "overview",
      settingsSection: "account",
    }
  }
  return {
    view: "repos",
    gitServerId: parts[1] || "",
    projectId: parts[2] || "",
    tab,
    settingsSection: "account",
  }
}

export function workspaceRoutePath(route: Partial<WorkspaceRoute>) {
  if (route.view === "setup") return "/setup"
  if (route.view === "insights") return "/insights/installations"
  if (route.view === "settings") {
    if (route.settingsSection === "git-servers") return "/settings/git-servers"
    if (route.settingsSection === "agentrix") return "/settings/agentrix"
    return "/settings/account"
  }
  if (!route.gitServerId) return "/repos"
  const server = encodeURIComponent(route.gitServerId)
  if (!route.projectId) return `/repos/${server}`
  const project = encodeURIComponent(route.projectId)
  if (route.tab === "settings") return `/repos/${server}/${project}/settings`
  if (route.tab === "issues") return `/repos/${server}/${project}/issues`
  if (route.tab === "tasks") return `/repos/${server}/${project}/tasks`
  return `/repos/${server}/${project}`
}

export function sameWorkspaceRoute(a: Partial<WorkspaceRoute>, b: Partial<WorkspaceRoute>) {
  return (a.view || "repos") === (b.view || "repos")
    && (a.gitServerId || "") === (b.gitServerId || "")
    && (a.projectId || "") === (b.projectId || "")
    && (a.tab || "overview") === (b.tab || "overview")
    && (a.settingsSection || "account") === (b.settingsSection || "account")
}
