import { useEffect, useMemo, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import {
  CheckCircle2,
  Copy,
  GitBranch,
  GitMerge,
  KeyRound,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Webhook,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const API_BASE_URL = (import.meta.env.VITE_ISSUE_FLOW_API_BASE_URL || "http://127.0.0.1:8788").replace(/\/+$/, "")

type Repository = {
  id: string
  provider: string
  gitServerId?: string
  baseUrl: string
  projectPath: string
  projectId?: string
  defaultBranch?: string
  installMode?: string
  install?: { status?: string; mode?: string }
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
  credentialStatus?: {
    status?: string
    username?: string
    tokenFingerprint?: string
    lastValidatedAt?: string
  }
  webhook?: {
    secretFingerprint?: string
    lastRotatedAt?: string
  }
  webhookUrl?: string
}

type GitLabUser = {
  username: string
  name?: string
}

type GitServer = {
  id: string
  type: string
  name?: string
  baseUrl?: string
}

type GitLabProject = {
  id: string
  name: string
  pathWithNamespace: string
  webUrl?: string
  defaultBranch?: string
  accessLevel?: number
  accessLevelKnown?: boolean
  canInstall?: boolean
  permissionStatus?: string
  installed?: boolean
  installedRepoId?: string
}

type RecordRow = {
  id: string
  consumer?: string
  status?: string
  routeAction?: string
  event?: string
  deliveryId?: string
  deliveryKey?: string
  updatedAt?: string
  createdAt?: string
  payloadSummary?: {
    objectKind?: string
    eventName?: string
    action?: string
    projectPath?: string
    issueIid?: string | number
    mergeRequestIid?: string | number
    noteId?: string | number
    status?: string
  }
  resultSummary?: {
    reason?: string
    runId?: string
    providerEventName?: string
    eventCount?: number
    deliveries?: Array<{ target?: string; status?: string; reason?: string; eventId?: string }>
  }
  error?: { code?: string; message?: string }
}

type SessionBody = {
  authenticated: boolean
  session?: { gitServerId?: string }
  user?: GitLabUser
  gitServer?: { id?: string; baseUrl?: string }
}

type ProjectStatusFilter = "all" | "installed" | "can_install" | "no_permission"

type AgentrixDefaults = {
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

type SessionState = {
  authenticated: boolean
  user?: GitLabUser
  gitServer?: { id?: string; baseUrl?: string }
}

type LoadProjectsOptions = {
  preferInstalled?: boolean
  repositories?: Repository[]
}

async function api(path: string, options: RequestInit = {}) {
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

function statusVariant(status = "") {
  if (["valid", "completed", "ready", "installed", "delivered"].includes(status.toLowerCase())) return "default"
  if (["invalid", "failed", "rejected", "install_failed"].includes(status.toLowerCase())) return "destructive"
  return "secondary"
}

function formatWhen(value = "") {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value.replace("T", " ").replace(/\.\d+Z$/, "Z")
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}

function projectAccess(project?: GitLabProject) {
  if (!project) {
    return { label: "not selected", tone: "muted" }
  }
  if (project.installed) {
    return { label: "installed", tone: "success" }
  }
  if (project.permissionStatus === "unknown" || project.accessLevelKnown === false) {
    return { label: "unknown", tone: "muted" }
  }
  if (project.canInstall) {
    return { label: "can install", tone: "info" }
  }
  return { label: "no permission", tone: "locked" }
}

function preferredProjectId(projects: GitLabProject[], current = "", options: LoadProjectsOptions = {}) {
  const installed = projects.find((project) => project.installed)
  if (options.preferInstalled && installed) {
    return installed.id
  }
  if (current && projects.some((project) => project.id === current)) {
    return current
  }
  return installed?.id || projects[0]?.id || ""
}

function mergeProjectInstallStatus(
  projects: GitLabProject[],
  repositories: Repository[],
  gitServerId: string
) {
  return projects.map((project) => {
    const installedRepo = repositories.find((repo) => (
      (!gitServerId || repo.gitServerId === gitServerId)
      && (
        (project.id && String(repo.projectId || "") === String(project.id))
        || repo.projectPath === project.pathWithNamespace
      )
    ))
    if (!installedRepo) {
      return project
    }
    return {
      ...project,
      installed: true,
      installedRepoId: installedRepo.id,
    }
  })
}

function AppShell() {
  return (
    <TooltipProvider>
      <div className="app-shell">
        <Dashboard />
      </div>
    </TooltipProvider>
  )
}

function Dashboard() {
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [gitServers, setGitServers] = useState<GitServer[]>([])
  const [selectedGitServerId, setSelectedGitServerId] = useState("")
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const [projects, setProjects] = useState<GitLabProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [deliveries, setDeliveries] = useState<RecordRow[]>([])
  const [runs, setRuns] = useState<RecordRow[]>([])
  const [loadError, setLoadError] = useState("")
  const [filter, setFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("all")
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [agentrixDefaults, setAgentrixDefaults] = useState<AgentrixDefaults | undefined>()

  const selectedGitServer = useMemo(
    () => gitServers.find((server) => server.id === selectedGitServerId),
    [gitServers, selectedGitServerId]
  )
  const currentSession = sessions[selectedGitServerId]
  const currentUser = currentSession?.authenticated ? currentSession.user : undefined
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  )
  const selectedRepo = useMemo(() => {
    if (!selectedProject?.installed) return undefined
    return repositories.find((repo) => (
      repo.id === selectedProject.installedRepoId
      || repo.projectPath === selectedProject.pathWithNamespace
    ))
  }, [repositories, selectedProject])

  const filteredProjects = useMemo(() => {
    const text = filter.trim().toLowerCase()
    return projects.filter((project) => {
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "installed" && project.installed)
        || (statusFilter === "can_install" && !project.installed && project.canInstall)
        || (statusFilter === "no_permission" && !project.installed && !project.canInstall)
      const matchesText = !text || project.pathWithNamespace.toLowerCase().includes(text)
      return matchesStatus && matchesText
    })
  }, [filter, projects, statusFilter])

  const projectStats = useMemo(() => ({
    all: projects.length,
    installed: projects.filter((project) => project.installed).length,
    canInstall: projects.filter((project) => !project.installed && project.canInstall).length,
    noPermission: projects.filter((project) => !project.installed && !project.canInstall).length,
  }), [projects])

  async function loadRepositories(nextSelectedProjectId = selectedProjectId) {
    const body = await api("/api/repositories")
    const repos = body.repositories || []
    setRepositories(repos)
    if (nextSelectedProjectId) {
      setSelectedProjectId(nextSelectedProjectId)
    }
    return repos
  }

  async function loadGitServers() {
    const body = await api("/api/git-servers")
    const servers = body.gitServers || []
    setGitServers(servers)
    setSelectedGitServerId((current) => current || servers[0]?.id || "")
    return servers
  }

  async function loadSession(gitServerId: string) {
    if (!gitServerId) return undefined
    const body: SessionBody = await api(`/api/session?gitServerId=${encodeURIComponent(gitServerId)}`)
    const state: SessionState = body.authenticated
      ? { authenticated: true, user: body.user, gitServer: body.gitServer }
      : { authenticated: false }
    setSessions((current) => ({ ...current, [gitServerId]: state }))
    return state
  }

  async function loadAgentrixDefaults(gitServerId = selectedGitServerId) {
    if (!gitServerId) {
      setAgentrixDefaults(undefined)
      return
    }
    const body = await api(`/api/user/agentrix-config?gitServerId=${encodeURIComponent(gitServerId)}`)
    setAgentrixDefaults(body.config)
  }

  async function loadProjects(gitServerId = selectedGitServerId, options: LoadProjectsOptions = {}) {
    if (!gitServerId) {
      setProjects([])
      return
    }
    setLoadingProjects(true)
    try {
      const body = await api(`/api/gitlab/projects?gitServerId=${encodeURIComponent(gitServerId)}`)
      const nextProjects: GitLabProject[] = mergeProjectInstallStatus(
        body.projects || [],
        options.repositories || repositories,
        gitServerId
      )
      if (options.preferInstalled && nextProjects.some((project) => project.installed)) {
        setStatusFilter("installed")
      }
      setProjects(nextProjects)
      setSelectedProjectId((current) => preferredProjectId(nextProjects, current, options))
      setLoadError("")
    } catch (error) {
      setProjects([])
      setSelectedProjectId("")
      setLoadError((error as Error).message)
    } finally {
      setLoadingProjects(false)
    }
  }

  async function refreshGitServer(gitServerId = selectedGitServerId, options: LoadProjectsOptions = {}) {
    if (!gitServerId) return
    const session = await loadSession(gitServerId)
    if (session?.authenticated) {
      const [repos] = await Promise.all([
        loadRepositories(""),
        loadAgentrixDefaults(gitServerId),
      ])
      await loadProjects(gitServerId, { ...options, repositories: repos })
    } else {
      setProjects([])
      setSelectedProjectId("")
      setAgentrixDefaults(undefined)
    }
  }

  async function loadActivity(repoId?: string) {
    if (!repoId) {
      setDeliveries([])
      setRuns([])
      return
    }
    const [deliveryBody, runBody] = await Promise.all([
      api(`/api/repositories/${encodeURIComponent(repoId)}/deliveries`),
      api(`/api/repositories/${encodeURIComponent(repoId)}/runs`),
    ])
    setDeliveries(deliveryBody.deliveries || [])
    setRuns(runBody.runs || [])
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get("code")
    const state = params.get("state")
    if (code && state) {
      window.location.replace(`${API_BASE_URL}/api/auth/gitlab/callback?${params.toString()}`)
      return
    }
    async function initialize() {
      const [servers] = await Promise.all([loadGitServers(), loadRepositories()])
      if (servers.length === 0) {
        setLoadError("请先在后台配置 Git server")
      }
    }
    initialize().catch((error) => {
      setLoadError((error as Error).message)
    })
  }, [])

  useEffect(() => {
    if (!selectedGitServerId) return
    setLoadError("")
    setSelectedProjectId("")
    void refreshGitServer(selectedGitServerId, { preferInstalled: true })
  }, [selectedGitServerId])

  useEffect(() => {
    void loadActivity(selectedRepo?.id)
  }, [selectedRepo?.id])

  function loginGitLab() {
    if (!selectedGitServerId) {
      setLoadError("请先选择 Git server")
      return
    }
    window.location.href = `${API_BASE_URL}/api/auth/gitlab/start?gitServerId=${encodeURIComponent(selectedGitServerId)}`
  }

  async function logoutGitLab() {
    if (!selectedGitServerId) return
    await api("/api/auth/gitlab/logout", {
      method: "POST",
      body: JSON.stringify({ gitServerId: selectedGitServerId }),
    })
    setSessions((current) => ({ ...current, [selectedGitServerId]: { authenticated: false } }))
    setProjects([])
    setSelectedProjectId("")
    setAgentrixDefaults(undefined)
  }

  async function saveAgentrixDefaults(input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: string; runnerId?: string }
  }) {
    const body = await api("/api/user/agentrix-config", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        ...input,
      }),
    })
    setAgentrixDefaults(body.config)
  }

  async function installOrUpgradeProject(input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: FormDataEntryValue | null; runnerId?: FormDataEntryValue | null }
  }) {
    if (!selectedProject) return
    await api("/api/gitlab/install", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        ...input,
      }),
    })
    await refreshGitServer(selectedGitServerId, { preferInstalled: true })
    setSelectedProjectId(selectedProject.id)
  }

  async function copyWebhook() {
    if (selectedRepo?.webhookUrl) {
      await navigator.clipboard.writeText(selectedRepo.webhookUrl)
    }
  }

  return (
    <main className="repo-mode">
      <RepoSidebar
        gitServers={gitServers}
        selectedGitServerId={selectedGitServerId}
        selectedGitServer={selectedGitServer}
        user={currentUser}
        defaults={agentrixDefaults}
        projects={filteredProjects}
        stats={projectStats}
        filter={filter}
        statusFilter={statusFilter}
        selectedProjectId={selectedProjectId}
        loading={loadingProjects}
        onSelectGitServer={setSelectedGitServerId}
        onFilter={setFilter}
        onStatusFilter={setStatusFilter}
        onSelectProject={setSelectedProjectId}
        onLogin={loginGitLab}
        onLogout={logoutGitLab}
        onSaveDefaults={saveAgentrixDefaults}
        onRefresh={() => refreshGitServer(selectedGitServerId)}
      />

      <section className="repo-main">
        {loadError && (
          <Alert className="panel-card">
            <LockKeyhole className="size-4" />
            <AlertTitle>无法加载</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}

        <RepoWorkspace
          gitServer={selectedGitServer}
          user={currentUser}
          project={selectedProject}
          repository={selectedRepo}
          defaults={agentrixDefaults}
          deliveries={deliveries}
          runs={runs}
          onLogin={loginGitLab}
          onInstall={installOrUpgradeProject}
          onCopyWebhook={copyWebhook}
          onRefreshActivity={() => loadActivity(selectedRepo?.id)}
        />
      </section>
    </main>
  )
}

function RepoSidebar({
  gitServers,
  selectedGitServerId,
  selectedGitServer,
  user,
  defaults,
  projects,
  stats,
  filter,
  statusFilter,
  selectedProjectId,
  loading,
  onSelectGitServer,
  onFilter,
  onStatusFilter,
  onSelectProject,
  onLogin,
  onLogout,
  onSaveDefaults,
  onRefresh,
}: {
  gitServers: GitServer[]
  selectedGitServerId: string
  selectedGitServer?: GitServer
  user?: GitLabUser
  defaults?: AgentrixDefaults
  projects: GitLabProject[]
  stats: { all: number; installed: number; canInstall: number; noPermission: number }
  filter: string
  statusFilter: ProjectStatusFilter
  selectedProjectId: string
  loading: boolean
  onSelectGitServer: (gitServerId: string) => void
  onFilter: (value: string) => void
  onStatusFilter: (value: ProjectStatusFilter) => void
  onSelectProject: (projectId: string) => void
  onLogin: () => void
  onLogout: () => void
  onSaveDefaults: (input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: string; runnerId?: string }
  }) => Promise<void>
  onRefresh: () => void
}) {
  return (
    <aside className="repo-sidebar panel-card">
      <div className="sidebar-header">
        <div className="brand-lockup">
          <span className="brand-mark">IF</span>
          <span>
            <strong>Issue Flow</strong>
            <small>{selectedGitServer?.baseUrl || "Git server"}</small>
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary" size="icon" onClick={onRefresh} disabled={!selectedGitServerId || !user}>
              <RefreshCw className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>刷新仓库</TooltipContent>
        </Tooltip>
      </div>

      <div className="sidebar-section">
        <Label>Git server</Label>
        <Select value={selectedGitServerId} onValueChange={onSelectGitServer}>
          <SelectTrigger>
            <SelectValue placeholder="选择 Git server" />
          </SelectTrigger>
          <SelectContent>
            {gitServers.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                {server.name || server.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary" disabled={!selectedGitServerId || !user}>
              <Settings className="size-4" />
              Agentrix 默认配置
            </Button>
          </DialogTrigger>
          <DialogContent className="config-dialog">
            <DialogHeader>
              <DialogTitle>Agentrix 默认配置</DialogTitle>
              <DialogDescription>
                {selectedGitServer?.name || selectedGitServer?.id || "Git server"} 的默认安装配置
              </DialogDescription>
            </DialogHeader>
            <AgentrixDefaultsForm defaults={defaults} onSave={onSaveDefaults} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="server-session">
        <div className={`connection-dot ${user ? "online" : "offline"}`} />
        <span>
          <strong>{user ? user.name || user.username : "未登录"}</strong>
          <small>{user ? user.username : "当前 Git server 需要单独登录"}</small>
        </span>
        {user ? (
          <Button variant="secondary" size="icon" onClick={onLogout}>
            <LogOut className="size-4" />
          </Button>
        ) : (
          <Button onClick={onLogin} disabled={!selectedGitServerId}>
            <GitMerge className="size-4" />
            登录
          </Button>
        )}
      </div>

      <div className="status-tabs">
        <StatusFilterButton active={statusFilter === "all"} onClick={() => onStatusFilter("all")}>
          All <b>{stats.all}</b>
        </StatusFilterButton>
        <StatusFilterButton active={statusFilter === "can_install"} onClick={() => onStatusFilter("can_install")}>
          Can install <b>{stats.canInstall}</b>
        </StatusFilterButton>
        <StatusFilterButton active={statusFilter === "installed"} onClick={() => onStatusFilter("installed")}>
          Installed <b>{stats.installed}</b>
        </StatusFilterButton>
        <StatusFilterButton active={statusFilter === "no_permission"} onClick={() => onStatusFilter("no_permission")}>
          No permission <b>{stats.noPermission}</b>
        </StatusFilterButton>
      </div>

      <div className="search-box">
        <Search className="size-4" />
        <Input
          value={filter}
          onChange={(event) => onFilter(event.currentTarget.value)}
          placeholder="Search repositories"
          disabled={!user}
        />
      </div>

      <ScrollArea className="repo-scroll">
        <div className="project-list">
          {!user && (
            <div className="empty-state compact">
              <LockKeyhole className="size-5" />
              <span>登录后显示该 Git server 下的仓库。</span>
            </div>
          )}
          {user && loading && <div className="project-row muted">Loading repositories...</div>}
          {user && !loading && projects.length === 0 && <div className="project-row muted">没有匹配仓库</div>}
          {projects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              active={project.id === selectedProjectId}
              onSelect={() => onSelectProject(project.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </aside>
  )
}

function StatusFilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button type="button" className={`status-filter ${active ? "active" : ""}`} onClick={onClick}>
      {children}
    </button>
  )
}

function ProjectRow({
  project,
  active,
  onSelect,
}: {
  project: GitLabProject
  active: boolean
  onSelect: () => void
}) {
  const access = projectAccess(project)
  return (
    <button type="button" className={`project-row ${active ? "active" : ""}`} onClick={onSelect}>
      <span className="project-identity">
        <strong>{project.pathWithNamespace}</strong>
        <small>{project.defaultBranch || "default branch unknown"}</small>
      </span>
      <Badge className={`state-badge ${access.tone}`} variant={project.installed ? "default" : project.canInstall ? "secondary" : "outline"}>
        {access.label}
      </Badge>
    </button>
  )
}

function RepoWorkspace({
  gitServer,
  user,
  project,
  repository,
  defaults,
  deliveries,
  runs,
  onLogin,
  onInstall,
  onCopyWebhook,
  onRefreshActivity,
}: {
  gitServer?: GitServer
  user?: GitLabUser
  project?: GitLabProject
  repository?: Repository
  defaults?: AgentrixDefaults
  deliveries: RecordRow[]
  runs: RecordRow[]
  onLogin: () => void
  onInstall: (input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: FormDataEntryValue | null; runnerId?: FormDataEntryValue | null }
  }) => Promise<void>
  onCopyWebhook: () => void
  onRefreshActivity: () => void
}) {
  const access = projectAccess(project)
  return (
    <div className="workspace-panel panel-card">
      <div className="workspace-header">
        <div>
          <Badge className={`state-badge ${access.tone}`} variant="secondary">{access.label}</Badge>
          <h1>{project?.pathWithNamespace || "选择仓库"}</h1>
          <p>{gitServer?.name || gitServer?.id || "No Git server selected"}</p>
        </div>
        <div className="workspace-actions">
          {repository?.webhookUrl && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="icon" onClick={onCopyWebhook}>
                  <Copy className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>复制 webhook URL</TooltipContent>
            </Tooltip>
          )}
          <Button variant="secondary" onClick={onRefreshActivity} disabled={!repository}>
            <RefreshCw className="size-4" />
            刷新
          </Button>
        </div>
      </div>

      <Tabs defaultValue="settings" className="workspace-tabs">
        <TabsList>
          <TabsTrigger value="settings">
            <Settings className="size-4" />
            Settings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="settings">
          {!gitServer ? (
            <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
          ) : !user ? (
            <EmptyPanel icon={<LockKeyhole className="size-6" />} title="需要登录" detail="每个 Git server 都有独立登录态，切换后需要单独授权。">
              <Button onClick={onLogin}>
                <GitMerge className="size-4" />
                登录 GitLab
              </Button>
            </EmptyPanel>
          ) : !project ? (
            <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个代码仓。" />
          ) : (
            <SettingsTab
              project={project}
              repository={repository}
              defaults={defaults}
              deliveries={deliveries}
              runs={runs}
              onInstall={onInstall}
              onCopyWebhook={onCopyWebhook}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

function SettingsTab({
  project,
  repository,
  defaults,
  deliveries,
  runs,
  onInstall,
  onCopyWebhook,
}: {
  project: GitLabProject
  repository?: Repository
  defaults?: AgentrixDefaults
  deliveries: RecordRow[]
  runs: RecordRow[]
  onInstall: (input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: FormDataEntryValue | null; runnerId?: FormDataEntryValue | null }
  }) => Promise<void>
  onCopyWebhook: () => void
}) {
  return (
    <div className="settings-grid">
      <div className="settings-primary">
        <Card className="section-card">
          <CardHeader>
            <CardTitle>安装设置</CardTitle>
            <CardDescription>{project.installed ? "当前仓库配置与升级" : "使用默认配置安装到该仓库"}</CardDescription>
          </CardHeader>
          <CardContent>
            {project.installed || project.canInstall ? (
              <InstallSettingsForm
                project={project}
                repository={repository}
                defaults={defaults}
                onInstall={onInstall}
              />
            ) : (
              <EmptyPanel icon={<LockKeyhole className="size-6" />} title="无安装权限" detail="当前 GitLab token 没有该仓库的安装权限。" />
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="settings-side">
        <StatusGrid project={project} repository={repository} />
        {repository?.webhookUrl && (
          <div className="webhook-box">
            <div>
              <Label>Webhook URL</Label>
              <code>{repository.webhookUrl}</code>
            </div>
            <Button variant="secondary" size="icon" onClick={onCopyWebhook}>
              <Copy className="size-4" />
            </Button>
          </div>
        )}
      </aside>
      <div className="settings-activity">
        <ActivityList deliveries={deliveries} runs={runs} />
      </div>
    </div>
  )
}

function StatusGrid({ project, repository }: { project: GitLabProject; repository?: Repository }) {
  return (
    <div className="status-grid">
      <StatusCard icon={<CheckCircle2 className="size-4" />} label="Install" value={repository?.install?.status || (project.installed ? "installed" : "not installed")} />
      <StatusCard icon={<ShieldCheck className="size-4" />} label="Permission" value={projectAccess(project).label} />
      <StatusCard icon={<GitBranch className="size-4" />} label="Default branch" value={project.defaultBranch || repository?.defaultBranch || "-"} />
      <StatusCard icon={<KeyRound className="size-4" />} label="Agentrix key" value={repository?.agentrix?.apiKeyFingerprint ? `fingerprint ${repository.agentrix.apiKeyFingerprint}` : "default or missing"} />
      <StatusCard icon={<Webhook className="size-4" />} label="Webhook" value={repository?.webhook?.secretFingerprint ? "configured" : "after install"} />
    </div>
  )
}

function StatusCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="status-card">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function AgentrixDefaultsForm({
  defaults,
  onSave,
}: {
  defaults?: AgentrixDefaults
  onSave: (input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: string; runnerId?: string }
  }) => Promise<void>
}) {
  const [reviewEnabled, setReviewEnabled] = useState(Boolean(defaults?.automation?.reviewEnabled))
  const [overrideApiKey, setOverrideApiKey] = useState(false)
  const [status, setStatus] = useState("")

  useEffect(() => {
    setReviewEnabled(Boolean(defaults?.automation?.reviewEnabled))
    setOverrideApiKey(false)
  }, [defaults?.automation?.reviewEnabled, defaults?.agentrix?.apiKeyFingerprint])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const apiKeyInput = form.elements.namedItem("agentrixApiKey") as HTMLInputElement | null
    const data = new FormData(form)
    setStatus("Saving...")
    try {
      await onSave({
        automation: {
          autoDefault: String(data.get("autoDefault") || "triage"),
          reviewEnabled,
          agent: String(data.get("agent") || "codex"),
          runnerId: String(data.get("runnerId") || ""),
        },
        agentrix: {
          apiKey: String(data.get("agentrixApiKey") || ""),
          runnerId: String(data.get("runnerId") || ""),
        },
      })
      if (apiKeyInput) apiKeyInput.value = ""
      setOverrideApiKey(false)
      setStatus("Saved")
    } catch (error) {
      setStatus((error as Error).message)
    }
  }

  return (
    <ConfigForm
      mode="defaults"
      automation={defaults?.automation}
      agentrix={defaults?.agentrix}
      submitLabel="保存默认配置"
      status={status}
      overrideApiKey={overrideApiKey}
      onOverrideApiKey={setOverrideApiKey}
      onSubmit={submit}
    />
  )
}

function InstallSettingsForm({
  project,
  repository,
  defaults,
  onInstall,
}: {
  project: GitLabProject
  repository?: Repository
  defaults?: AgentrixDefaults
  onInstall: (input: {
    automation: AgentrixDefaults["automation"]
    agentrix: { apiKey?: FormDataEntryValue | null; runnerId?: FormDataEntryValue | null }
  }) => Promise<void>
}) {
  const automationConfig = project.installed && repository ? repository.automation : defaults?.automation
  const agentrixConfig = project.installed && repository ? repository.agentrix : defaults?.agentrix
  const [reviewEnabled, setReviewEnabled] = useState(Boolean(automationConfig?.reviewEnabled))
  const [overrideApiKey, setOverrideApiKey] = useState(false)
  const [status, setStatus] = useState("")

  useEffect(() => {
    setReviewEnabled(Boolean(automationConfig?.reviewEnabled))
    setOverrideApiKey(false)
  }, [automationConfig?.reviewEnabled, project.id, repository?.id])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setStatus(project.installed ? "Upgrading..." : "Installing...")
    try {
      await onInstall({
        automation: {
          autoDefault: String(data.get("autoDefault") || "triage"),
          reviewEnabled,
          agent: String(data.get("agent") || "codex"),
          runnerId: String(data.get("runnerId") || ""),
          responseMode: "async",
        },
        agentrix: {
          apiKey: data.get("agentrixApiKey"),
          runnerId: data.get("runnerId"),
        },
      })
      setOverrideApiKey(false)
      setStatus(project.installed ? "Upgraded" : "Installed")
    } catch (error) {
      setStatus((error as Error).message)
    }
  }

  return (
    <ConfigForm
      mode={project.installed ? "repository" : "install"}
      automation={automationConfig}
      agentrix={agentrixConfig}
      submitLabel={project.installed ? "升级" : "安装"}
      status={status}
      overrideApiKey={overrideApiKey}
      onOverrideApiKey={setOverrideApiKey}
      onSubmit={submit}
    />
  )
}

function ConfigForm({
  mode,
  automation,
  agentrix,
  submitLabel,
  status,
  overrideApiKey,
  onOverrideApiKey,
  onSubmit,
}: {
  mode: "defaults" | "repository" | "install"
  automation?: AgentrixDefaults["automation"]
  agentrix?: AgentrixDefaults["agentrix"]
  submitLabel: string
  status: string
  overrideApiKey: boolean
  onOverrideApiKey: (value: boolean) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const apiKeyFingerprint = agentrix?.apiKeyFingerprint || ""
  const hasApiKey = Boolean(apiKeyFingerprint)
  const keyLabel = mode === "repository" ? "当前仓库 API key" : mode === "install" ? "默认 API key" : "默认 API key"

  return (
    <form
      key={`${mode}-${automation?.autoDefault || "triage"}-${automation?.agent || "codex"}-${agentrix?.runnerId || ""}-${apiKeyFingerprint}`}
      className="settings-form"
      onSubmit={onSubmit}
    >
      {hasApiKey ? (
        <div className="key-summary">
          <KeyRound className="size-4" />
          <div>
            <Label>Agentrix API key</Label>
            <strong>使用{keyLabel}</strong>
            <small>fingerprint {apiKeyFingerprint}</small>
          </div>
          <Button type="button" variant="secondary" onClick={() => onOverrideApiKey(!overrideApiKey)}>
            {overrideApiKey ? "取消覆盖" : "覆盖"}
          </Button>
        </div>
      ) : (
        <Field name="agentrixApiKey" label="Agentrix API key" type="password" required wide />
      )}
      {hasApiKey && overrideApiKey && (
        <Field name="agentrixApiKey" label="Override API key" type="password" placeholder="输入新的 Agentrix API key" wide />
      )}
      {hasApiKey && !overrideApiKey && <input type="hidden" name="agentrixApiKey" value="" />}

      <Field name="agent" label="Agent" defaultValue={automation?.agent || "codex"} />
      <Field name="runnerId" label="Runner ID" defaultValue={agentrix?.runnerId || automation?.runnerId || ""} />
      <div className="field">
        <Label>Auto default</Label>
        <Select name="autoDefault" defaultValue={automation?.autoDefault || "triage"}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {["off", "triage", "plan", "build"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="form-footer">
        <span>{status}</span>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  )
}

function ActivityList({ deliveries, runs }: { deliveries: RecordRow[]; runs: RecordRow[] }) {
  const rows = [
    ...deliveries.slice(0, 8).map((row) => ({ ...row, kind: "delivery" })),
    ...runs.slice(0, 8).map((row) => ({ ...row, kind: "run" })),
  ].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
  const deliveredCount = rows.filter((row) => row.status === "delivered" || row.status === "completed").length
  const failedCount = rows.filter((row) => row.status === "failed" || row.status === "rejected").length
  const ignoredCount = rows.filter((row) => row.status === "ignored").length

  return (
    <Card className="section-card">
      <CardHeader>
        <CardTitle>最近活动</CardTitle>
        <CardDescription>Webhook delivery、pipeline trigger 与 dispatch run</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="activity-summary">
          <div>
            <small>Total</small>
            <strong>{rows.length}</strong>
          </div>
          <div>
            <small>Delivered</small>
            <strong>{deliveredCount}</strong>
          </div>
          <div>
            <small>Ignored</small>
            <strong>{ignoredCount}</strong>
          </div>
          <div>
            <small>Failed</small>
            <strong>{failedCount}</strong>
          </div>
        </div>
        <ScrollArea className="activity-scroll">
          <div className="activity-list">
            {rows.length === 0 && <div className="activity-row muted">暂无活动</div>}
            {rows.map((row) => {
              const status = row.status || "-"
              const payload = row.payloadSummary || {}
              const result = row.resultSummary || {}
              const target = result.deliveries?.[0]
              const eventLabel = [
                row.event || result.providerEventName || payload.eventName || payload.objectKind || row.kind,
                payload.action,
              ].filter(Boolean).join(" / ")
              const subject = payload.mergeRequestIid
                ? `MR !${payload.mergeRequestIid}`
                : payload.issueIid
                  ? `Issue #${payload.issueIid}`
                  : payload.noteId
                    ? `Note ${payload.noteId}`
                    : payload.status || ""
              const detail = row.kind === "delivery"
                ? target?.target || row.consumer || row.routeAction || ""
                : result.reason || result.runId || row.routeAction || ""
              return (
                <div className="activity-row" key={`${row.kind}-${row.id}`}>
                  <div className="activity-row-head">
                    <span className="activity-title">
                      <Badge variant={statusVariant(status)}>{status}</Badge>
                      <strong>{eventLabel || "-"}</strong>
                      <time>{formatWhen(row.updatedAt || row.createdAt || "")}</time>
                    </span>
                  </div>
                  <div className="activity-row-grid">
                    <span>
                      <small>Type</small>
                      <strong>{row.kind}</strong>
                    </span>
                    <span>
                      <small>Subject</small>
                      <strong>{subject || "-"}</strong>
                    </span>
                    <span>
                      <small>Target</small>
                      <strong>{detail || "-"}</strong>
                    </span>
                    <span>
                      <small>Result</small>
                      <strong>{target?.reason || row.error?.message || result.reason || target?.status || "-"}</strong>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

function EmptyPanel({ icon, title, detail, children }: { icon: ReactNode; title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      <span>{detail}</span>
      {children}
    </div>
  )
}

function Field({ name, label, wide, ...props }: React.ComponentProps<typeof Input> & { name: string; label: string; wide?: boolean }) {
  return (
    <div className={`field ${wide ? "wide" : ""}`}>
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} {...props} />
    </div>
  )
}

export default AppShell
