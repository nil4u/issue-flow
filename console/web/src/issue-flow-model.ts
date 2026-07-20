import type { ReactNode } from "react"

export const API_BASE_URL = (
  import.meta.env.ISSUE_FLOW_WEB_API_BASE_URL
  || import.meta.env.ISSUE_FLOW_BASE_URL
  || window.location.origin
).replace(/\/+$/, "")

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
    permissions?: { items?: AdminPermission[]; checkedAt?: string }
    variables?: { items?: AgentrixVariable[]; checkedAt?: string }
    webhook?: Record<string, unknown>
    plugins?: { items?: PluginInstall[]; checkedAt?: string }
    runners?: { items?: GitRunnerSetting[]; checkedAt?: string }
  }
}

export type GitLabUser = { username: string; name?: string; avatarUrl?: string }
export type GitServer = {
  id: string
  type: string
  name?: string
  baseUrl?: string
  apiUrl?: string
  tokenAuth?: string
  oauth?: {
    clientId?: string
    clientSecret?: string
    clientSecretFingerprint?: string
    scopes?: string
  }
  webhook?: {
    secret?: string
    secretFingerprint?: string
  }
  commitAuthor?: {
    name?: string
    email?: string
  }
  agentrixGitServerId?: string
  adminPat?: string
  adminPatFingerprint?: string
  botPat?: string
  botPatFingerprint?: string
  createdAt?: string
  updatedAt?: string
}

export type SetupStatus = {
  initialized: boolean
  needsSetup: boolean
  state: "uninitialized" | "configured" | "broken"
  setupCodeConfigured?: boolean
  missing?: string[]
  gitServers?: GitServer[]
}

export type IssueFlowUser = {
  id: string
  displayName?: string
  email?: string
  avatarUrl?: string
  role?: string
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
  gitServerId?: string
  owner?: string
  webUrl?: string
  defaultBranch?: string
  canInstall?: boolean
  permissionStatus?: string
}

export type MergeRequestUser = {
  id: string
  username: string
  name: string
  avatarUrl: string
  url: string
}

export type MergeRequestSummary = {
  id: string
  number: number
  title: string
  body: string
  bodyHtml?: string
  state: string
  draft: boolean
  merged: boolean
  author: MergeRequestUser
  sourceBranch: string
  targetBranch: string
  headSha: string
  webUrl: string
  labels: string[]
  commentsCount: number
  commitsCount: number
  changedFilesCount: number
  additions: number
  deletions: number
  createdAt: string
  updatedAt: string
  mergedAt: string
  closedAt: string
  sourceIssueNumber: number
  previewable: boolean
  mergeable?: boolean | null
  mergeStatus?: string
  approvedBy?: MergeRequestUser[]
  diffRefs?: { baseSha: string; startSha: string; headSha: string }
}

export type MergeRequestFile = {
  path: string
  oldPath: string
  status: string
  additions: number
  deletions: number
  patch: string
  truncated: boolean
}

export type MergeRequestComment = {
  id: string
  type: "comment" | "review" | "inline"
  body: string
  bodyHtml?: string
  state: string
  author: MergeRequestUser
  path: string
  oldPath: string
  line: number
  side: string
  createdAt: string
  resolved: boolean
}

export type MergeRequestDetail = {
  mergeRequest: MergeRequestSummary
  files: MergeRequestFile[]
  comments: MergeRequestComment[]
  repository: { id: string; fullName: string; provider: string; webUrl: string }
}

export type InstallStatus = "passed" | "needs_action" | "needs_input" | "blocked" | "unknown" | "failed"
export type VariableInstallStatus = "unchecked" | "passed" | "pending_auto" | "manual_required" | "failed"

export type AgentrixVariable = {
  key: string
  label?: string
  description?: string
  value?: string
  exists?: boolean
  required?: boolean
  writable?: boolean
  autoWritable?: boolean
  masked?: boolean
  source?: string
  groupPath?: string
  scope?: string
  environmentScope?: string
  variableType?: string
  protected?: boolean
  raw?: boolean
  hidden?: boolean
  status?: VariableInstallStatus
  detail?: string
  needsInput?: boolean
  manualRequired?: boolean
  blocker?: boolean
  control?: {
    path: string
    type: "text" | "password" | "select" | "checkbox"
    placeholder?: string
    options?: string[]
  }
}

export type PluginInstall = {
  key: string
  source?: string
  manifestPath?: string
  installed?: boolean
  installedVersion?: string
  latestVersion?: string
  targetVersion?: string
  manifestVersion?: number
  provider?: string
  runtime?: string
  status?: InstallStatus
  needsUpgrade?: boolean
  manifestInvalid?: boolean
  detail?: string
  pendingMergeRequest?: {
    id?: string
    iid?: string
    webUrl?: string
    sourceBranch?: string
    targetBranch?: string
  }
}

export type AdminPermission = {
  key: string
  source?: string
  userId?: string
  username?: string
  name?: string
  email?: string
  avatarUrl?: string
  accessLevel?: number
  role?: string
  canManage?: boolean
  memberUrl?: string
}

export type GitRunnerSetting = {
  key: string
  source?: string
  runnerId?: string
  name?: string
  description?: string
  shortToken?: string
  runnerType?: string
  gitlabStatus?: string
  active?: boolean
  paused?: boolean
  tagList?: string[]
  status?: InstallStatus
  detail?: string
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
    checkedAt?: string
    user?: AgentrixUserProfile
  }
}

export type AgentrixUserProfile = {
  id?: string
  username?: string
  email?: string
  avatar?: string
  role?: string
  createdAt?: string
}

export type RunnerGitlabToken = {
  id: string
  userId?: string
  gitServerId: string
  runnerId: string
  gitlabUserId?: string
  gitlabUsername?: string
  gitlabTokenId?: string
  tokenFingerprint?: string
  scopes?: string[]
  source?: string
  expiresAt?: string
  revokedAt?: string
  createdAt?: string
  updatedAt?: string
}

export type UserGitPat = {
  gitServerId: string
  gitServerName?: string
  gitlabUserId?: string
  gitlabUsername?: string
  tokenFingerprint?: string
  scopes?: string[]
  requiredScopes?: string[]
  status?: "missing" | "valid" | "invalid" | string
  checkedAt?: string
  expiresAt?: string
  createUrl?: string
}

export type AgentrixPrivateCloudConfig = {
  agentrix: {
    serverUrl: string
    webappUrl: string
    cliImage?: string
  }
  llmProxy: {
    baseUrl: string
    apiKey?: string
  }
  gitServer?: GitServer
  defaults?: AgentrixDefaults
  runnerGitlabTokens?: RunnerGitlabToken[]
  gitPat?: UserGitPat
}

export type RunnerGitlabTokenResult = AgentrixPrivateCloudConfig & {
  runnerGitlabToken: RunnerGitlabToken
  commitAuthor?: {
    name?: string
    email?: string
  }
  cloudAuthToken?: string
  dockerCommand?: string
}

export type AgentrixCloud = {
  id: string
  name?: string
  type?: string
  status?: string
  role?: string
  userStatus?: string
  machineCount?: number
  onlineMachineCount?: number
  memberCount?: number
  maxMachineCount?: number
  maxMemberCount?: number
  createdAt?: string
  updatedAt?: string
}

export type AgentrixCloudMachine = {
  id: string
  cloudId?: string
  deviceId?: string
  status?: string
  metadata?: string | null
  cliVersion?: string
  createdAt?: string
  updatedAt?: string
}

export type AgentrixLocalMachine = {
  id: string
  owner?: string
  status?: string
  metadata?: string | null
  cliVersion?: string
  approval?: string
  controlPort?: number | null
  createdAt?: string
  updatedAt?: string
}

export type AgentrixResources = {
  configured: boolean
  error?: string
  detail?: string
  agentrix: AgentrixDefaults["agentrix"]
  privateClouds: AgentrixCloud[]
  clouds?: AgentrixCloud[]
  localMachines: AgentrixLocalMachine[]
  entitlement?: {
    enabled?: boolean
    maxPrivateClouds?: number
    maxMachinesPerPrivateCloud?: number
    maxPrivateCloudMembers?: number
    currentPrivateCloudCount?: number
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
  blockers?: string[]
  variables?: AgentrixVariable[]
  plugins?: PluginInstall[]
  permissions?: AdminPermission[]
  runners?: GitRunnerSetting[]
  memberUrl?: string
  actionCount?: number
  value?: string
  valueHref?: string
}

export type InstallCheck = {
  installable: boolean
  steps: InstallStep[]
  repository?: Repository | null
}

export type InstallConflictAction = "overwrite" | "keep" | "remove" | "forget" | "use_proposed" | "keep_current"

export type InstallConflict = {
  id: string
  category: "gitlab_ci" | "user_customizations" | "managed" | "stale"
  path: string
  mode: "managed" | "customizable"
  kind: "desired" | "stale"
  reason: string
  defaultAction: InstallConflictAction
  allowedActions: InstallConflictAction[]
  currentHash?: string
  newHash?: string
  currentContent?: string
  proposedContent?: string
  message?: string
}

export type InstallConflictPlan = {
  fingerprint: string
  conflicts: InstallConflict[]
}

export type InstallConflictDecision = {
  fingerprint: string
  actions: Record<string, InstallConflictAction>
}

export type InstallCheckProgress = {
  open: boolean
  title?: string
  detail?: string
  actionHref?: string
  actionLabel?: string
  steps: Array<{
    id: string
    label: string
    status: "pending" | "running" | "passed" | "failed"
  }>
}

export type ProjectAccess = {
  accessLevel?: number
  accessLevelKnown?: boolean
  role?: string
  canManage?: boolean
}

export type IssueRow = {
  id: string
  gitServerId?: string
  repositoryId?: string
  repositoryFullName?: string
  issueId: string
  issueNumber: number
  createdByTaskId?: string
  title: string
  state?: "opened" | "closed" | string
  type?: string
  priority?: string
  size?: string
  automation?: string
  status: "active" | "done" | "drop" | "suspend" | string
  flow?: string
  currentFlow?: string
  turnsCount?: number
  agentTimeSharePct?: number
  openedAt?: string
  closedAt?: string
  updatedAt?: string
}

export type ReviewablePlanArtifact = {
  issueNumber: number
  type: "decision" | "plan"
  format: "json" | "markdown"
  mergeRequestNumber?: number
}

export type DashboardVariable = {
  id: string
  name: string
  type: "time_range" | "select" | "multi_select" | string
  defaultValue?: unknown
  querySql?: string
  position?: number
}

export type DashboardPanelPosition = { x?: number; y?: number; w?: number; h?: number }

export type DashboardPanel = {
  id: string
  title: string
  querySql: string
  chartType: "stat" | "line" | "bar" | "stacked_bar" | "stacked_bar_with_lines" | "table" | string
  xField?: string
  yFields?: string[]
  y2Fields?: string[]
  seriesField?: string
  stackField?: string
  visualConfig?: Record<string, unknown>
  drillQuerySql?: string
  drillConfig?: {
    kind?: string
    params?: string[]
    xParam?: string
    seriesParam?: string
  }
  position?: DashboardPanelPosition
  refreshInterval?: number
}

export type DashboardView = {
  id: string
  name: string
  slug: string
  description?: string
  isSystem?: boolean
  variables: DashboardVariable[]
  panels: DashboardPanel[]
}

export type MetricsQueryResult = {
  columns: Array<{ name: string; type: string }>
  rows: Array<Record<string, unknown>>
  truncated?: boolean
}

export type TaskRow = {
  id: string
  taskId: string
  issueNumber: number
  action: string
  agent: string
  model: string
  turns: number
  executionMs: number
  status: string
  queuedAt: string
  startedAt: string
  finishedAt: string
  updatedAt: string
}

export type TaskPage = {
  tasks: TaskRow[]
  agentrixBaseUrl: string
  page: number
  perPage: number
  total: number
  hasMore: boolean
}

export type InstalledAutomation = {
  id: string
  gitServerId: string
  projectId: string
  projectPath: string
  name: string
  webUrl: string
  provider: string
  serverName: string
  plugin: {
    key: string
    installedVersion: string
    latestVersion: string
    status: string
    detail: string
    needsUpgrade: boolean
    checkedAt: string
  }
  tasks: {
    total: number
    active: number
    failed: number
    succeeded: number
    lastTaskAt: string
    lastSuccessAt: string
    lastFailureAt: string
    latest?: {
      taskId: string
      issueNumber: number
      action: string
      status: string
      updatedAt: string
    }
  }
}

export type InstalledAutomationPage = {
  installations: InstalledAutomation[]
  page: number
  perPage: number
  total: number
  hasMore: boolean
}

export type WorkspaceTab = "overview" | "issues" | "merge-requests" | "tasks" | "settings"

export type RepoWorkspaceProps = {
  tab: WorkspaceTab
  onTab: (tab: WorkspaceTab) => void
  gitServer?: GitServer
  user?: GitLabUser
  project?: GitLabProject
  repository?: Repository
  defaults?: AgentrixDefaults
  installCheck?: InstallCheck
  checkProgress?: InstallCheckProgress
  installConflictPlan?: InstallConflictPlan
  checking: boolean
  projectAccess?: ProjectAccess
  loadingProjectAccess?: boolean
  loadingRepositoryDetails?: boolean
  issues: IssueRow[]
  loadingIssues?: boolean
  onLogin: () => void
  onSyncIssues: () => Promise<void>
  onCheck: (input?: Record<string, unknown>) => Promise<InstallCheck | undefined>
  onCloseCheckProgress: () => void
  onSetVariable: (key: string, input: Record<string, unknown>) => Promise<InstallCheck | undefined>
  onSetWebhook: (input?: Record<string, unknown>) => Promise<InstallCheck | undefined>
  onSetRunner: () => Promise<InstallCheck | undefined>
  onInstallPlugin: () => Promise<InstallCheck | undefined>
  onConfirmInstallConflicts: (decision: InstallConflictDecision) => Promise<InstallCheck | undefined>
  onCancelInstallConflicts: () => void
}

export type EmptyPanelProps = {
  icon: ReactNode
  title: string
  detail: string
  children?: ReactNode
}

type ApiRequestInit = RequestInit & {
  timeoutMs?: number
}

const DEFAULT_API_TIMEOUT_MS = 60_000

export async function api<T = any>(path: string, options: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, signal, ...requestOptions } = options
  const controller = new AbortController()
  let timedOut = false
  let timeoutId: number | undefined
  const abortFromCaller = () => controller.abort(signal?.reason)

  if (signal?.aborted) {
    controller.abort(signal.reason)
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true })
  }
  if (timeoutMs > 0) {
    timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...requestOptions,
      credentials: "include",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(requestOptions.headers || {}),
      },
    })
  } catch (error) {
    if (timedOut) {
      throw new Error("request_timeout")
    }
    throw error
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId)
    signal?.removeEventListener("abort", abortFromCaller)
  }

  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`)
    ;(error as Error & { body?: unknown }).body = body
    throw error
  }
  return body
}

export function ownerOf(project?: GitLabProject) {
  return project?.owner || project?.pathWithNamespace.split("/")[0] || ""
}

export function repositoryToProject(repository: Repository): GitLabProject {
  const fullName = repository.fullName || repository.projectPath || ""
  const parts = fullName.split("/").filter(Boolean)
  return {
    id: repository.projectId || repository.serverRepoId || repository.id,
    name: repository.name || parts[parts.length - 1] || fullName,
    pathWithNamespace: fullName,
    gitServerId: repository.gitServerId,
    owner: repository.owner || parts[0] || "",
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
