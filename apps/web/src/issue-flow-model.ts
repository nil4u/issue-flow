import type { ReactNode } from "react"

export const API_BASE_URL = (import.meta.env.VITE_ISSUE_FLOW_API_BASE_URL || "http://127.0.0.1:8788").replace(/\/+$/, "")

export type Repository = {
  id: string
  provider: string
  gitServerId?: string
  serverRepoId?: string
  owner?: string
  name?: string
  fullName?: string
  baseUrl?: string
  projectPath: string
  projectId?: string
  defaultBranch?: string
  url?: string
  webUrl?: string
  installMode?: string
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
  webhook?: {
    hookId?: string
    secretFingerprint?: string
    lastRotatedAt?: string
    bootstrapCommitId?: string
    bootstrapMergeRequest?: { iid?: string; webUrl?: string }
  }
  webhookUrl?: string
  settings?: {
    variables?: { items?: AgentrixVariable[]; checkedAt?: string }
    webhook?: Record<string, unknown>
  }
}

export type GitLabUser = { username: string; name?: string; avatarUrl?: string }
export type GitServer = { id: string; type: string; name?: string; baseUrl?: string }

export type IssueFlowUser = {
  id: string
  displayName?: string
  email?: string
  avatarUrl?: string
  accounts?: UserGitAccount[]
}

export type UserGitAccount = {
  id?: string
  userId?: string
  gitServerId: string
  provider: string
  providerUserId?: string
  username?: string
  displayName?: string
  email?: string
  avatarUrl?: string
  scopes?: string[]
  gitServer?: GitServer
  createdAt?: string
  updatedAt?: string
}

export type GitLabProject = {
  id: string
  name: string
  pathWithNamespace: string
  webUrl?: string
  defaultBranch?: string
  canInstall?: boolean
  permissionStatus?: string
}

export type InstallStatus = "passed" | "needs_action" | "needs_input" | "blocked" | "unknown"

export type AgentrixVariable = {
  key: string
  label?: string
  description?: string
  value?: string
  exists?: boolean
  required?: boolean
  writable?: boolean
  masked?: boolean
  source?: string
  groupPath?: string
  scope?: string
  environmentScope?: string
  variableType?: string
  protected?: boolean
  raw?: boolean
  hidden?: boolean
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
  session?: { userId?: string; gitServerId?: string }
}

export type UserSession = {
  authenticated: boolean
  user?: IssueFlowUser | GitLabUser
  accounts?: Array<{ account?: UserGitAccount; user?: GitLabUser; gitServer?: GitServer; session?: { gitServerId?: string; userId?: string } }>
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
  steps: InstallStep[]
  repository?: Repository | null
}

export type ProjectAccess = {
  accessLevel?: number
  accessLevelKnown?: boolean
  role?: string
  canManage?: boolean
}

export type GitEventRow = {
  id: string
  gitServerId?: string
  repositoryId?: string
  deliveryId?: string
  eventName?: string
  action?: string
  objectType?: string
  objectId?: string
  repositoryFullName?: string
  receivedAt?: string
  updatedAt?: string
  createdAt?: string
  payload?: Record<string, unknown>
  normalizedEvents?: Array<Record<string, unknown>>
}

export type IssueRow = {
  id: string
  gitServerId?: string
  repositoryId?: string
  repositoryFullName?: string
  issueId: string
  issueNumber: number
  title: string
  type?: string
  priority?: string
  size?: string
  automation?: string
  status: "active" | "done" | "drop" | "suspend" | string
  currentFlow?: string
  openedAt?: string
  closedAt?: string
  updatedAt?: string
}

export type WorkspaceTab = "overview" | "issues" | "settings"

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
  projectAccess?: ProjectAccess
  loadingProjectAccess?: boolean
  gitEvents: GitEventRow[]
  issues: IssueRow[]
  loadingIssues?: boolean
  onLogin: () => void
  onSyncIssues: () => Promise<void>
  onCheck: () => Promise<InstallCheck | undefined>
  onSetVariable: (key: string, input: Record<string, unknown>) => Promise<InstallCheck | undefined>
  onSetWebhook: (input?: Record<string, unknown>) => Promise<InstallCheck | undefined>
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

export function repositoryToProject(repository: Repository): GitLabProject {
  const fullName = repository.fullName || repository.projectPath || ""
  const parts = fullName.split("/").filter(Boolean)
  return {
    id: repository.projectId || repository.serverRepoId || repository.id,
    name: repository.name || parts[parts.length - 1] || fullName,
    pathWithNamespace: fullName,
    webUrl: repository.webUrl || repository.url,
    defaultBranch: repository.defaultBranch,
  }
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
  if (repo?.webhook?.hookId) return { label: "已配置", tone: "success" }
  if (project.canInstall) return { label: "可安装", tone: "info" }
  return { label: "无权限", tone: "locked" }
}
