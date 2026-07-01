import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { LoginPage } from "@/components/login-page"
import { RepoSidebar } from "@/components/repo-sidebar"
import { RepoWorkspace } from "@/components/repo-workspace"
import { UserSettings } from "@/components/user-settings"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { parseWorkspaceRoute, sameWorkspaceRoute, workspaceRoutePath, type WorkspaceRoute } from "@/app-route"
import {
  API_BASE_URL,
  api,
  ownerOf,
  repositoryToProject,
  type AgentrixDefaults,
  type GitLabProject,
  type GitLabUser,
  type GitServer,
  type GitEventRow,
  type InstallCheck,
  type InstallStep,
  type ProjectAccess,
  type Repository,
  type SessionState,
  type UserSession,
  type WorkspaceTab,
} from "@/issue-flow-model"

function mergeInstallCheck(current: InstallCheck | undefined, next: InstallCheck): InstallCheck {
  const byId = new Map<string, InstallStep>()
  for (const step of current?.steps || []) byId.set(step.id, step)
  for (const step of next.steps || []) byId.set(step.id, step)
  return {
    ...current,
    ...next,
    steps: Array.from(byId.values()),
    installable: Array.from(byId.values()).every((step) => step.status !== "blocked" && step.status !== "needs_input"),
  }
}

function AppShell() {
  return (
    <TooltipProvider>
      <Dashboard />
      <Toaster position="top-center" closeButton visibleToasts={3} />
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
  const [agentrixDefaults, setAgentrixDefaults] = useState<AgentrixDefaults>()
  const [installCheck, setInstallCheck] = useState<InstallCheck>()
  const [projectAccess, setProjectAccess] = useState<ProjectAccess>()
  const [loadingProjectAccess, setLoadingProjectAccess] = useState(false)
  const [checking, setChecking] = useState(false)
  const [gitEvents, setGitEvents] = useState<GitEventRow[]>([])
  const [pendingGitServerId, setPendingGitServerId] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem("issue-flow.sidebarCollapsed") === "1"
  })

  const selectedGitServer = gitServers.find((server) => server.id === selectedGitServerId)
  const currentSession = sessions[selectedGitServerId]
  const currentUser = currentSession?.authenticated ? currentSession.user : undefined
  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedRepo = selectedProject
    ? repositories.find((repo) => (
      repo.id === selectedProject.id
      || String(repo.projectId || "") === String(selectedProject.id)
      || repo.projectPath === selectedProject.pathWithNamespace
    ))
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

  async function loadRepositories(gitServerId = selectedGitServerId) {
    if (!gitServerId) {
      setRepositories([])
      setProjects([])
      return []
    }
    const body = await api<{ repositories: Repository[] }>(`/api/repositories?gitServerId=${encodeURIComponent(gitServerId)}`)
    const repos = body.repositories || []
    setRepositories(repos)
    const nextProjects = repos.map(repositoryToProject)
    setProjects(nextProjects)
    const currentRoute = parseWorkspaceRoute()
    setSelectedProjectId((current) => {
      if (currentRoute.gitServerId === gitServerId && currentRoute.projectId && nextProjects.some((project) => project.id === currentRoute.projectId)) {
        return currentRoute.projectId
      }
      if (current && nextProjects.some((project) => project.id === current)) return current
      return nextProjects[0]?.id || ""
    })
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

  async function syncGitServer(gitServerId = selectedGitServerId) {
    if (!gitServerId) return
    setLoadingProjects(true)
    try {
      const session = await loadSession(gitServerId)
      if (!session.authenticated) {
        setRepositories([])
        setProjects([])
        setAgentrixDefaults(undefined)
        return
      }
      await api<{ projects: GitLabProject[] }>("/api/gitlab/projects", {
        method: "POST",
        body: JSON.stringify({ gitServerId }),
      })
      await Promise.all([loadAgentrixDefaults(gitServerId), loadRepositories(gitServerId)])
    } catch (error) {
      notifyError(error, "同步仓库失败")
    } finally {
      setLoadingProjects(false)
    }
  }

  async function loadGitServerState(gitServerId = selectedGitServerId) {
    if (!gitServerId) return
    setLoadingProjects(true)
    try {
      const session = await loadSession(gitServerId)
      if (!session.authenticated) {
        setRepositories([])
        setProjects([])
        setAgentrixDefaults(undefined)
        return
      }
      await Promise.all([loadAgentrixDefaults(gitServerId), loadRepositories(gitServerId)])
    } catch (error) {
      notifyError(error, "加载仓库失败")
    } finally {
      setLoadingProjects(false)
    }
  }

  async function loadActivity(repoId?: string) {
    if (!repoId) {
      setGitEvents([])
      return
    }
    const eventBody = await api<{ gitEvents: GitEventRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/git-events`)
    setGitEvents(eventBody.gitEvents || [])
  }

  async function loadProjectAccess(project = selectedProject, gitServerId = selectedGitServerId) {
    if (!project || !gitServerId) {
      setProjectAccess(undefined)
      return undefined
    }
    setLoadingProjectAccess(true)
    try {
      const body = await api<{ access: ProjectAccess }>("/api/gitlab/project-role", {
        method: "POST",
        body: JSON.stringify({
          gitServerId,
          projectId: project.id,
        }),
      })
      setProjectAccess(body.access)
      return body.access
    } catch (error) {
      setProjectAccess(undefined)
      notifyError(error, "读取权限失败")
    } finally {
      setLoadingProjectAccess(false)
    }
  }

  async function runInstallCheck() {
    if (!selectedProject || !selectedGitServerId) return
    if (projectAccess && !projectAccess.canManage) {
      toast.warning("权限不足", {
        description: `当前角色 ${projectAccess.role || "-"} 仅可查看，不能执行检查。`,
      })
      return
    }
    setChecking(true)
    let nextCheck = installCheck
    try {
      for (const checkType of ["variables", "webhook"]) {
        const body = await api<InstallCheck>("/api/gitlab/install-check", {
          method: "POST",
          body: JSON.stringify({
            gitServerId: selectedGitServerId,
            projectId: selectedProject.id,
            checkType,
          }),
        })
        nextCheck = mergeInstallCheck(nextCheck, body)
        setInstallCheck(nextCheck)
      }
      await loadRepositories(selectedGitServerId)
      return nextCheck
    } catch (error) {
      notifyError(error, "检查失败")
    } finally {
      setChecking(false)
    }
  }

  async function setInstallVariable(key: string, input: Record<string, unknown>) {
    if (!selectedProject || !selectedGitServerId) return
    if (projectAccess && !projectAccess.canManage) {
      toast.warning("权限不足", {
        description: `当前角色 ${projectAccess.role || "-"} 仅可查看，不能修改变量。`,
      })
      return
    }
    setChecking(true)
    try {
      const body = await api<InstallCheck>("/api/gitlab/install-variable", {
        method: "POST",
        body: JSON.stringify({
          gitServerId: selectedGitServerId,
          projectId: selectedProject.id,
          key,
          ...input,
        }),
      })
      const nextCheck = mergeInstallCheck(installCheck, body)
      setInstallCheck(nextCheck)
      await loadRepositories(selectedGitServerId)
      return nextCheck
    } catch (error) {
      notifyError(error, "设置变量失败")
    } finally {
      setChecking(false)
    }
  }

  async function setInstallWebhook(input: Record<string, unknown> = {}) {
    if (!selectedProject || !selectedGitServerId) return
    if (projectAccess && !projectAccess.canManage) {
      toast.warning("权限不足", {
        description: `当前角色 ${projectAccess.role || "-"} 仅可查看，不能配置 webhook。`,
      })
      return
    }
    setChecking(true)
    try {
      const body = await api<InstallCheck>("/api/gitlab/install-webhook", {
        method: "POST",
        body: JSON.stringify({
          gitServerId: selectedGitServerId,
          projectId: selectedProject.id,
          ...input,
        }),
      })
      const nextCheck = mergeInstallCheck(installCheck, body)
      setInstallCheck(nextCheck)
      await loadRepositories(selectedGitServerId)
      return nextCheck
    } catch (error) {
      notifyError(error, "配置 webhook 失败")
    } finally {
      setChecking(false)
    }
  }

  function loginGitLab(gitServerId = selectedGitServerId) {
    if (!gitServerId) {
      toast.warning("请先选择 Git server")
      return
    }
    const returnTo = `${window.location.pathname}${window.location.search}`
    window.location.href = `${API_BASE_URL}/api/auth/gitlab/start?gitServerId=${encodeURIComponent(gitServerId)}&returnTo=${encodeURIComponent(returnTo)}`
  }

  function connectGitServerAccount(gitServerId: string) {
    const server = gitServers.find((item) => item.id === gitServerId)
    if (!server) return
    if (server.type !== "gitlab") {
      toast.warning("暂不支持关联", {
        description: `${server.name || server.id} 暂未支持网页 OAuth 关联`,
      })
      return
    }
    setPendingGitServerId(gitServerId)
    loginGitLab(gitServerId)
  }

  async function logoutAll() {
    try {
      await api("/api/user/logout", { method: "POST" })
      setUserSession({ authenticated: false })
      setSessions({})
      setProjects([])
      setSelectedProjectId("")
      setPendingGitServerId("")
    } catch (error) {
      notifyError(error, "退出失败")
    }
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
    setProjectAccess(undefined)
    navigateWorkspace({ gitServerId, projectId: "", tab: "overview" })
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId)
    setActiveTab("overview")
    setInstallCheck(undefined)
    setProjectAccess(undefined)
    const nextOwner = ownerOf(projects.find((project) => project.id === projectId))
    if (nextOwner) setOwner(nextOwner)
    navigateWorkspace({ gitServerId: selectedGitServerId, projectId, tab: "overview" })
  }

  function selectTab(tab: WorkspaceTab) {
    setActiveTab(tab)
    setInstallCheck(undefined)
    if (selectedGitServerId && selectedProjectId) {
      navigateWorkspace({ gitServerId: selectedGitServerId, projectId: selectedProjectId, tab }, "replace")
    }
  }

  function openUserSettings() {
    setInstallCheck(undefined)
    navigateUserSettings()
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("code") && params.get("state")) {
      window.location.replace(`${API_BASE_URL}/api/auth/gitlab/callback?${params.toString()}`)
      return
    }
    Promise.all([loadGitServers(), loadUserSession(), loadRepositories()]).catch((error) => {
      notifyError(error, "加载失败")
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
      setProjectAccess(undefined)
    }
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [gitServers])

  useEffect(() => {
    if (!selectedGitServerId || !userSession.authenticated) return
    setOwner("all")
    setInstallCheck(undefined)
    setProjectAccess(undefined)
    void loadGitServerState(selectedGitServerId)
  }, [selectedGitServerId, userSession.authenticated])

  useEffect(() => {
    setInstallCheck(undefined)
    setProjectAccess(undefined)
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
    if (activeTab !== "settings" || !selectedGitServerId || !selectedProject || !userSession.authenticated) return
    void Promise.all([
      loadAgentrixDefaults(selectedGitServerId),
      loadProjectAccess(selectedProject, selectedGitServerId),
    ]).catch((error) => {
      notifyError(error, "加载设置失败")
    })
  }, [activeTab, selectedGitServerId, selectedProject?.id, userSession.authenticated])

  useEffect(() => {
    void loadActivity(selectedRepo?.id).catch((error) => {
      notifyError(error, "加载活动失败")
    })
  }, [selectedRepo?.id])

  async function reloadLoginState() {
    try {
      await Promise.all([loadGitServers(), loadUserSession()])
    } catch (error) {
      notifyError(error, "重新加载失败")
    }
  }

  if (!userSession.authenticated) {
    return (
      <LoginPage
        gitServers={gitServers}
        onLogin={loginGitLab}
        onReload={reloadLoginState}
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
        onRefresh={syncGitServer}
        onLogout={logoutAll}
        onOpenUserSettings={openUserSettings}
        onCollapsedChange={updateSidebarCollapsed}
      />

      <section className="workspace-surface">
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
            projectAccess={projectAccess}
            loadingProjectAccess={loadingProjectAccess}
            gitEvents={gitEvents}
            onLogin={() => loginGitLab(selectedGitServerId)}
            onCheck={runInstallCheck}
            onSetVariable={setInstallVariable}
            onSetWebhook={setInstallWebhook}
          />
        )}
      </section>
    </main>
  )
}

function notifyError(error: unknown, title = "操作失败") {
  toast.error(title, {
    description: errorMessage(error),
  })
}

function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : ""
  const body = error && typeof error === "object" && "body" in error
    ? (error as { body?: { detail?: string; message?: string; error?: string } }).body
    : undefined
  if (code === "git_server_webhook_secret_required") {
    return "Git server 缺少启动期 webhook secret，请在服务配置里设置后重启。"
  }
  if (code === "gitlab_project_permission_required") {
    return "当前账号没有维护者或所有者权限，不能执行这个操作。"
  }
  if (code === "gitlab_login_required") {
    return "当前 Git server 授权已失效，请重新连接后再试。"
  }
  if (code === "repository_not_found") {
    return "本地还没有这个仓库记录，请先同步仓库列表。"
  }
  if (code === "Not Found" && body?.message?.startsWith("Route ")) {
    return "接口不存在，API 服务可能还没重启到最新代码。"
  }
  return body?.detail || body?.message || body?.error || code || "请稍后重试。"
}

export default AppShell
