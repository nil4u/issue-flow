import { useEffect, useMemo, useState } from "react"
import { AlertCircle } from "lucide-react"

import { LoginPage } from "@/components/login-page"
import { RepoSidebar } from "@/components/repo-sidebar"
import { RepoWorkspace } from "@/components/repo-workspace"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"
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
  const [gitServers, setGitServers] = useState<GitServer[]>([])
  const [selectedGitServerId, setSelectedGitServerId] = useState("")
  const [userSession, setUserSession] = useState<UserSession>({ authenticated: false })
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [projects, setProjects] = useState<GitLabProject[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview")
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

  async function loadGitServers() {
    const body = await api<{ gitServers: GitServer[] }>("/api/git-servers")
    const servers = body.gitServers || []
    setGitServers(servers)
    setSelectedGitServerId((current) => current || servers[0]?.id || "")
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
      setSelectedProjectId((current) => current && nextProjects.some((project) => project.id === current) ? current : nextProjects[0]?.id || "")
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
      setInstallMessage((error as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  function loginGitLab(gitServerId = selectedGitServerId) {
    if (!gitServerId) return setLoadError("请先选择 Git server")
    window.location.href = `${API_BASE_URL}/api/auth/gitlab/start?gitServerId=${encodeURIComponent(gitServerId)}`
  }

  async function logoutAll() {
    await api("/api/user/logout", { method: "POST" })
    setUserSession({ authenticated: false })
    setSessions({})
    setProjects([])
    setSelectedProjectId("")
  }

  function updateSidebarCollapsed(next: boolean) {
    setSidebarCollapsed(next)
    window.localStorage.setItem("issue-flow.sidebarCollapsed", next ? "1" : "0")
  }

  function selectProject(projectId: string) {
    setSelectedProjectId(projectId)
    const nextOwner = ownerOf(projects.find((project) => project.id === projectId))
    if (nextOwner) setOwner(nextOwner)
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
    if (!selectedGitServerId || !userSession.authenticated) return
    setSelectedProjectId("")
    setOwner("all")
    setInstallCheck(undefined)
    void refreshGitServer(selectedGitServerId)
  }, [selectedGitServerId, userSession.authenticated])

  useEffect(() => {
    setActiveTab("overview")
    setInstallCheck(undefined)
    setInstallMessage("")
  }, [selectedProjectId])

  useEffect(() => {
    void loadActivity(selectedRepo?.id)
  }, [selectedRepo?.id])

  useEffect(() => {
    if (activeTab === "settings" && selectedProject && currentUser) void runInstallCheck()
  }, [activeTab, selectedProject?.id, currentUser?.username])

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
        onSelectGitServer={setSelectedGitServerId}
        onOwner={setOwner}
        onFilter={setFilter}
        onSelectProject={selectProject}
        onLoginCurrent={() => loginGitLab(selectedGitServerId)}
        onRefresh={() => refreshGitServer(selectedGitServerId)}
        onLogout={logoutAll}
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
        <RepoWorkspace
          tab={activeTab}
          onTab={setActiveTab}
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
      </section>
    </main>
  )
}

export default AppShell
