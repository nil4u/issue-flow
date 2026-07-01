import { useEffect, useMemo, useState } from "react"
import { AlertCircle } from "lucide-react"

import { LoginPage } from "@/components/login-page"
import { RepoSidebar } from "@/components/repo-sidebar"
import { RepoWorkspace } from "@/components/repo-workspace"
import { UserSettings } from "@/components/user-settings"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"
import { parseWorkspaceRoute, sameWorkspaceRoute, workspaceRoutePath, type WorkspaceRoute } from "@/app-route"
import {
  API_BASE_URL,
  api,
  mergeProjectInstallStatus,
  ownerOf,
  type AgentrixDefaults,
  type GitLabProject,
  type GitLabUser,
  type GitServer,
  type InstallCheck,
  type RecordRow,
  type Repository,
  type SessionState,
  type UserSession,
  type WorkspaceTab,
} from "@/issue-flow-model"

function AppShell() {
  return (
    <TooltipProvider>
      <Dashboard />
    </TooltipProvider>
  )
}

function Dashboard() {
  const [route, setRoute] = useState<WorkspaceRoute>(() => parseWorkspaceRoute())
  const [gitServers, setGitServers] = useState<GitServer[]>([])
  const [selectedGitServerId, setSelectedGitServerId] = useState(() => route.gitServerId)
  const [userSession, setUserSession] = useState<UserSession>({ authenticated: false })
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [projects, setProjects] = useState<GitLabProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState(() => route.projectId)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => route.tab)
  const [filter, setFilter] = useState("")
  const [owner, setOwner] = useState("all")
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [agentrixDefaults, setAgentrixDefaults] = useState<AgentrixDefaults>()
  const [installCheck, setInstallCheck] = useState<InstallCheck>()
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installMessage, setInstallMessage] = useState("")
  const [deliveries, setDeliveries] = useState<RecordRow[]>([])
  const [runs, setRuns] = useState<RecordRow[]>([])
  const [pendingGitServerId, setPendingGitServerId] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem("issue-flow.sidebarCollapsed") === "1"
  })

  const selectedGitServer = gitServers.find((server) => server.id === selectedGitServerId)
  const currentSession = sessions[selectedGitServerId]
  const currentUser = currentSession?.authenticated ? currentSession.user : undefined
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedRepo = selectedProject?.installed
    ? repositories.find((repo) => repo.id === selectedProject.installedRepoId || repo.projectPath === selectedProject.pathWithNamespace)
    : undefined

  const owners = useMemo(() => {
    return Array.from(new Set(projects.map(ownerOf).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [projects])

  const filteredProjects = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return projects
      .filter((project) => owner === "all" || ownerOf(project) === owner)
      .filter((project) => !q || project.pathWithNamespace.toLowerCase().includes(q))
      .sort((a, b) => a.pathWithNamespace.localeCompare(b.pathWithNamespace))
  }, [filter, owner, projects])

  function applyRoute(normalized: WorkspaceRoute, mode: "push" | "replace" = "push") {
    const path = workspaceRoutePath(normalized)
    const currentPath = `${window.location.pathname}${window.location.search}`
    if (path !== currentPath) {
      window.history[mode === "replace" ? "replaceState" : "pushState"](null, "", path)
    }
    setRoute(normalized)
  }

  function navigateWorkspace(next: Partial<WorkspaceRoute>, mode: "push" | "replace" = "push") {
    applyRoute({
      view: "repos",
      gitServerId: next.gitServerId || "",
      projectId: next.projectId || "",
      tab: next.projectId ? next.tab || "overview" : "overview",
      settingsSection: "account",
    }, mode)
  }

  function navigateUserSettings(mode: "push" | "replace" = "push") {
    applyRoute({
      view: "settings",
      gitServerId: "",
      projectId: "",
      tab: "overview",
      settingsSection: "account",
    }, mode)
  }

  async function loadGitServers() {
    const body = await api<{ gitServers: GitServer[] }>("/api/git-servers")
    const servers = body.gitServers || []
    setGitServers(servers)
    setSelectedGitServerId((current) => {
      if (current && servers.some((server) => server.id === current)) return current
      if (route.gitServerId && servers.some((server) => server.id === route.gitServerId)) return route.gitServerId
      return servers[0]?.id || ""
    })
    return servers
  }

  async function loadUserSession() {
    const body = await api<UserSession>("/api/user/session")
    setUserSession(body)
    return body
  }

  async function loadRepositories() {
    const body = await api<{ repositories: Repository[] }>("/api/repositories")
    const repos = body.repositories || []
    setRepositories(repos)
    return repos
  }

  async function loadSession(gitServerId: string) {
    if (!gitServerId) return { authenticated: false }
    const body = await api<{ authenticated: boolean; user?: GitLabUser; gitServer?: { id?: string; baseUrl?: string } }>(
      `/api/session?gitServerId=${encodeURIComponent(gitServerId)}`
    )
    const state = body.authenticated
      ? { authenticated: true, user: body.user, gitServer: body.gitServer }
      : { authenticated: false }
    setSessions((current) => ({ ...current, [gitServerId]: state }))
    return state
  }

  async function loadAgentrixDefaults(gitServerId = selectedGitServerId) {
    if (!gitServerId) return setAgentrixDefaults(undefined)
    const body = await api<{ config: AgentrixDefaults }>(`/api/user/agentrix-config?gitServerId=${encodeURIComponent(gitServerId)}`)
    setAgentrixDefaults(body.config)
  }

  async function loadProjects(gitServerId = selectedGitServerId, repos = repositories) {
    if (!gitServerId) return setProjects([])
    setLoadingProjects(true)
    try {
      const body = await api<{ projects: GitLabProject[] }>(`/api/gitlab/projects?gitServerId=${encodeURIComponent(gitServerId)}`)
      const nextProjects = mergeProjectInstallStatus(body.projects || [], repos, gitServerId)
      setProjects(nextProjects)
      const currentRoute = parseWorkspaceRoute()
      setSelectedProjectId((current) => {
        if (currentRoute.gitServerId === gitServerId && currentRoute.projectId && nextProjects.some((project) => project.id === currentRoute.projectId)) {
          return currentRoute.projectId
        }
        if (current && nextProjects.some((project) => project.id === current)) return current
        return nextProjects[0]?.id || ""
      })
      setLoadError("")
    } catch (error) {
      setProjects([])
      setSelectedProjectId("")
      setLoadError((error as Error).message)
    } finally {
      setLoadingProjects(false)
    }
  }

  async function refreshGitServer(gitServerId = selectedGitServerId) {
    if (!gitServerId) return
    const session = await loadSession(gitServerId)
    if (!session.authenticated) {
      setProjects([])
      setAgentrixDefaults(undefined)
      return
    }
    const repos = await loadRepositories()
    await Promise.all([loadAgentrixDefaults(gitServerId), loadProjects(gitServerId, repos)])
  }

  async function loadActivity(repoId?: string) {
    if (!repoId) {
      setDeliveries([])
      setRuns([])
      return
    }
    const [deliveryBody, runBody] = await Promise.all([
      api<{ deliveries: RecordRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/deliveries`),
      api<{ runs: RecordRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/runs`),
    ])
    setDeliveries(deliveryBody.deliveries || [])
    setRuns(runBody.runs || [])
  }

  async function runInstallCheck(extra: Record<string, unknown> = {}) {
    if (!selectedProject || !selectedGitServerId) return
    setChecking(true)
    setInstallMessage("")
    try {
      const body = await api<InstallCheck>("/api/gitlab/install-check", {
        method: "POST",
        body: JSON.stringify({
          gitServerId: selectedGitServerId,
          projectId: selectedProject.id,
          ...extra,
        }),
      })
      setInstallCheck(body)
      setLoadError("")
      return body
    } catch (error) {
      setLoadError((error as Error).message)
    } finally {
      setChecking(false)
    }
  }

  async function installProject(input: Record<string, unknown>) {
    if (!selectedProject) return
    setInstalling(true)
    setInstallMessage("正在配置 API 项并创建安装 MR...")
    try {
      const body = await api<{ pendingMergeRequest?: { iid?: string; webUrl?: string } }>("/api/gitlab/install", {
        method: "POST",
        body: JSON.stringify({
          gitServerId: selectedGitServerId,
          projectId: selectedProject.id,
          repoChangeMode: "merge_request",
          ...input,
        }),
      })
      const mr = body.pendingMergeRequest
      setInstallMessage(mr?.webUrl ? `已创建安装 MR !${mr.iid || ""}` : "安装已完成")
      await refreshGitServer(selectedGitServerId)
      await runInstallCheck()
    } catch (error) {
      setInstallMessage(installErrorMessage(error))
    } finally {
      setInstalling(false)
    }
  }

  function loginGitLab(gitServerId = selectedGitServerId) {
    if (!gitServerId) return setLoadError("请先选择 Git server")
    const returnTo = `${window.location.pathname}${window.location.search}`
    window.location.href = `${API_BASE_URL}/api/auth/gitlab/start?gitServerId=${encodeURIComponent(gitServerId)}&returnTo=${encodeURIComponent(returnTo)}`
  }

  function connectGitServerAccount(gitServerId: string) {
    const server = gitServers.find((item) => item.id === gitServerId)
    if (!server) return
    if (server.type !== "gitlab") {
      setLoadError(`${server.name || server.id} 暂未支持网页 OAuth 关联`)
      return
    }
    setPendingGitServerId(gitServerId)
    loginGitLab(gitServerId)
  }

  async function logoutAll() {
    await api("/api/user/logout", { method: "POST" })
    setUserSession({ authenticated: false })
    setSessions({})
    setProjects([])
    setSelectedProjectId("")
    setPendingGitServerId("")
  }

  function updateSidebarCollapsed(next: boolean) {
    setSidebarCollapsed(next)
    window.localStorage.setItem("issue-flow.sidebarCollapsed", next ? "1" : "0")
  }

  function selectGitServer(gitServerId: string) {
    setSelectedGitServerId(gitServerId)
    setSelectedProjectId("")
    setActiveTab("overview")
    setOwner("all")
    setInstallCheck(undefined)
    setInstallMessage("")
    navigateWorkspace({ gitServerId, projectId: "", tab: "overview" })
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId)
    setActiveTab("overview")
    setInstallCheck(undefined)
    setInstallMessage("")
    const nextOwner = ownerOf(projects.find((project) => project.id === projectId))
    if (nextOwner) setOwner(nextOwner)
    navigateWorkspace({ gitServerId: selectedGitServerId, projectId, tab: "overview" })
  }

  function selectTab(tab: WorkspaceTab) {
    setActiveTab(tab)
    setInstallCheck(undefined)
    setInstallMessage("")
    if (selectedGitServerId && selectedProjectId) {
      navigateWorkspace({ gitServerId: selectedGitServerId, projectId: selectedProjectId, tab }, "replace")
    }
  }

  function openUserSettings() {
    setInstallCheck(undefined)
    setInstallMessage("")
    navigateUserSettings()
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("code") && params.get("state")) {
      window.location.replace(`${API_BASE_URL}/api/auth/gitlab/callback?${params.toString()}`)
      return
    }
    Promise.all([loadGitServers(), loadUserSession(), loadRepositories()]).catch((error) => {
      setLoadError((error as Error).message)
    })
  }, [])

  useEffect(() => {
    function handlePopState() {
      const next = parseWorkspaceRoute()
      setRoute(next)
      if (next.view === "repos") {
        setSelectedGitServerId(next.gitServerId || gitServers[0]?.id || "")
        setSelectedProjectId(next.projectId || "")
        setActiveTab(next.tab)
      }
      setInstallCheck(undefined)
      setInstallMessage("")
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [gitServers])

  useEffect(() => {
    if (!selectedGitServerId || !userSession.authenticated) return
    setOwner("all")
    setInstallCheck(undefined)
    void refreshGitServer(selectedGitServerId)
  }, [selectedGitServerId, userSession.authenticated])

  useEffect(() => {
    setInstallCheck(undefined)
    setInstallMessage("")
  }, [selectedProjectId])

  useEffect(() => {
    const nextRoute = {
      view: "repos" as const,
      gitServerId: selectedGitServerId,
      projectId: selectedProjectId,
      tab: selectedProjectId ? activeTab : "overview",
      settingsSection: "account" as const,
    }
    if (route.view !== "repos" || !userSession.authenticated || !selectedGitServerId || sameWorkspaceRoute(route, nextRoute)) return
    navigateWorkspace(nextRoute, "replace")
  }, [activeTab, route, selectedGitServerId, selectedProjectId, userSession.authenticated])

  useEffect(() => {
    const nextOwner = ownerOf(selectedProject)
    if (nextOwner) setOwner(nextOwner)
  }, [selectedProject?.id])

  useEffect(() => {
    if (activeTab !== "settings" || !selectedGitServerId || !userSession.authenticated) return
    void loadAgentrixDefaults(selectedGitServerId).catch((error) => {
      setLoadError((error as Error).message)
    })
  }, [activeTab, selectedGitServerId, userSession.authenticated])

  useEffect(() => {
    void loadActivity(selectedRepo?.id)
  }, [selectedRepo?.id])

  if (!userSession.authenticated) {
    return (
      <LoginPage
        gitServers={gitServers}
        loadError={loadError}
        onLogin={loginGitLab}
        onReload={() => Promise.all([loadGitServers(), loadUserSession()])}
      />
    )
  }

  return (
    <main className={`issue-app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <RepoSidebar
        collapsed={sidebarCollapsed}
        gitServers={gitServers}
        selectedGitServerId={selectedGitServerId}
        selectedGitServer={selectedGitServer}
        user={userSession.user}
        currentUser={currentUser}
        projects={filteredProjects}
        selectedProjectId={selectedProjectId}
        owner={owner}
        owners={owners}
        filter={filter}
        loading={loadingProjects}
        onSelectGitServer={selectGitServer}
        onOwner={setOwner}
        onFilter={setFilter}
        onSelectProject={selectProject}
        onLoginCurrent={() => loginGitLab(selectedGitServerId)}
        onRefresh={refreshGitServer}
        onLogout={logoutAll}
        onOpenUserSettings={openUserSettings}
        onCollapsedChange={updateSidebarCollapsed}
      />

      <section className="workspace-surface">
        {loadError && (
          <Alert className="app-alert">
            <AlertCircle className="size-4" />
            <AlertTitle>无法加载</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        {route.view === "settings" ? (
          <UserSettings
            userSession={userSession}
            gitServers={gitServers}
            pendingGitServerId={pendingGitServerId}
            onConnectGitServer={connectGitServerAccount}
          />
        ) : (
          <RepoWorkspace
            tab={activeTab}
            onTab={selectTab}
            gitServer={selectedGitServer}
            user={currentUser}
            project={selectedProject}
            repository={selectedRepo}
            defaults={agentrixDefaults}
            installCheck={installCheck}
            checking={checking}
            installing={installing}
            installMessage={installMessage}
            deliveries={deliveries}
            runs={runs}
            onLogin={() => loginGitLab(selectedGitServerId)}
            onCheck={runInstallCheck}
            onInstall={installProject}
          />
        )}
      </section>
    </main>
  )
}

function installErrorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : ""
  if (code === "git_server_webhook_secret_required") {
    return "Git server 缺少启动期 webhook secret，请在服务配置里设置后重启。"
  }
  return code || "安装失败"
}

export default AppShell
