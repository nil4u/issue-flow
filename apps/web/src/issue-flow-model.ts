import type { ReactNode } from "react"

export const API_BASE_URL = (import.meta.env.VITE_ISSUE_FLOW_API_BASE_URL || "http://127.0.0.1:8788").replace(/\/+$/, "")

export type Repository = {
  id: string
  provider: string
  gitServerId?: string
  baseUrl: string
  projectPath: string
  projectId?: string
  defaultBranch?: string
  installMode?: string
  install?: {
    status?: string
    mode?: string
    bootstrapStatus?: string
    bootstrapCommitId?: string
    bootstrapMergeRequest?: { iid?: string; webUrl?: string }
  }
  automation?: {
    autoDefault?: string
    reviewEnabled?: boolean
    agent?: string
    runnerId?: string
    responseMode?: string
  }
  agentrix?: {
    baseUrl?: string
    runnerId?: string
    apiKeyFingerprint?: string
  }
  webhook?: { secretFingerprint?: string; lastRotatedAt?: string }
  webhookUrl?: string
}

export type GitLabUser = { username: string; name?: string }
export type GitServer = { id: string; type: string; name?: string; baseUrl?: string }

export type GitLabProject = {
  id: string
  name: string
  pathWithNamespace: string
  webUrl?: string
  defaultBranch?: string
  canInstall?: boolean
  installed?: boolean
  installedRepoId?: string
  permissionStatus?: string
}

export type InstallStatus = "passed" | "needs_action" | "needs_input" | "blocked" | "unknown"

export type AgentrixVariable = {
  key: string
  label?: string
  description?: string
  exists?: boolean
  required?: boolean
  writable?: boolean
  masked?: boolean
  status?: InstallStatus
  detail?: string
  needsInput?: boolean
  control?: {
    path: string
    type: "text" | "password" | "select" | "checkbox"
    placeholder?: string
    options?: string[]
  }
}

export type SessionState = {
  authenticated: boolean
  user?: GitLabUser
  gitServer?: { id?: string; baseUrl?: string }
}

export type UserSession = {
  authenticated: boolean
  user?: GitLabUser
  accounts?: Array<{ user?: GitLabUser; gitServer?: GitServer; session?: { gitServerId?: string } }>
}

export type AgentrixDefaults = {
  automation: {
    autoDefault?: string
    reviewEnabled?: boolean
    agent?: string
    runnerId?: string
    responseMode?: string
  }
  agentrix: {
    baseUrl?: string
    runnerId?: string
    apiKeyFingerprint?: string
  }
}

export type InstallStep = {
  id: string
  kind: "auth" | "input" | "api" | "repo"
  label: string
  status: InstallStatus
  detail?: string
  files?: string[]
  missing?: string[]
  inputRequired?: string[]
  variables?: AgentrixVariable[]
  actionCount?: number
}

export type InstallCheck = {
  installable: boolean
  installed?: boolean
  steps: InstallStep[]
  repository?: Repository | null
}

export type RecordRow = {
  id: string
  status?: string
  event?: string
  routeAction?: string
  consumer?: string
  updatedAt?: string
  createdAt?: string
  payloadSummary?: { eventName?: string; objectKind?: string; action?: string; issueIid?: string | number; mergeRequestIid?: string | number }
  resultSummary?: { reason?: string; providerEventName?: string; deliveries?: Array<{ target?: string; status?: string; reason?: string }> }
  error?: { message?: string }
}

export type WorkspaceTab = "overview" | "settings"

export type RepoWorkspaceProps = {
  tab: WorkspaceTab
  onTab: (tab: WorkspaceTab) => void
  gitServer?: GitServer
  user?: GitLabUser
  project?: GitLabProject
  repository?: Repository
  defaults?: AgentrixDefaults
  installCheck?: InstallCheck
  checking: boolean
  installing: boolean
  installMessage: string
  deliveries: RecordRow[]
  runs: RecordRow[]
  onLogin: () => void
  onCheck: (extra?: Record<string, unknown>) => Promise<InstallCheck | undefined>
  onInstall: (input: Record<string, unknown>) => Promise<void>
}

export type EmptyPanelProps = {
  icon: ReactNode
  title: string
  detail: string
  children?: ReactNode
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`)
    ;(error as Error & { body?: unknown }).body = body
    throw error
  }
  return body
}

export function ownerOf(project?: GitLabProject) {
  return project?.pathWithNamespace.split("/")[0] || ""
}

export function formatWhen(value = "") {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value.replace("T", " ").replace(/\.\d+Z$/, "Z")
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}

export function projectStatus(project?: GitLabProject, repo?: Repository) {
  if (!project) return { label: "未选择", tone: "muted" }
  if (repo?.install?.status === "pending_repo_change") return { label: "等待 MR", tone: "warning" }
  if (project.installed || repo) return { label: "已安装", tone: "success" }
  if (project.canInstall) return { label: "可安装", tone: "info" }
  return { label: "无权限", tone: "locked" }
}

export function mergeProjectInstallStatus(projects: GitLabProject[], repositories: Repository[], gitServerId: string) {
  return projects.map((project) => {
    const installedRepo = repositories.find((repo) => (
      (!gitServerId || repo.gitServerId === gitServerId)
      && (String(repo.projectId || "") === String(project.id) || repo.projectPath === project.pathWithNamespace)
    ))
    return installedRepo ? { ...project, installed: true, installedRepoId: installedRepo.id } : project
  })
}
