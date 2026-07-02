import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { parseWorkspaceRoute, sameWorkspaceRoute, setupRoute, userSettingsRoute, workspaceRoutePath, type WorkspaceRoute } from "@/app-route"
import {
  api,
  ownerOf,
  repositoryToProject,
  type AgentrixDefaults,
  type GitEventRow,
  type GitLabProject,
  type GitLabUser,
  type GitServer,
  type InstallCheck,
  type InstallCheckProgress,
  type IssueRow,
  type ProjectAccess,
  type Repository,
  type SessionState,
  type SetupStatus,
  type UserSession,
  type WorkspaceTab,
} from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"
import {
  installCheckProgressSteps,
  isStreamConnectionError,
  mergeInstallCheck,
  pluginInstallCompleteProgress,
  pluginInstallProgressSteps,
  pluginInstallProgressFromEvent,
  requestInstallPlugin,
  streamInstallPlugin,
} from "@/lib/install-flow"
import { initializeIssueFlowSetup, type SetupInitializeInput } from "@/lib/setup-flow"

export function useDashboardController() {
  const [route, setRoute] = useState<WorkspaceRoute>(() => parseWorkspaceRoute())
  const [booting, setBooting] = useState(true)
  const [setupStatus, setSetupStatus] = useState<SetupStatus>()
  const [initializingSetup, setInitializingSetup] = useState(false)
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
  const [checkProgress, setCheckProgress] = useState<InstallCheckProgress>({
    open: false,
    steps: installCheckProgressSteps,
  })
  const [projectAccess, setProjectAccess] = useState<ProjectAccess>()
  const [loadingProjectAccess, setLoadingProjectAccess] = useState(false)
  const [checking, setChecking] = useState(false)
  const [gitEvents, setGitEvents] = useState<GitEventRow[]>([])
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [loadingIssues, setLoadingIssues] = useState(false)
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
  const pendingPluginMergeRequestHref = selectedRepo?.settings?.plugins?.items?.find((item) => item.key === "issue-flow")?.pendingMergeRequest?.webUrl || ""

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
    applyRoute(userSettingsRoute, mode)
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

  async function loadSetupStatus() {
    const body = await api<SetupStatus>("/api/setup/status")
    setSetupStatus(body)
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

  async function loadIssues(repoId?: string) {
    if (!repoId) {
      setIssues([])
      return
    }
    const body = await api<{ issues: IssueRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/issues`)
    setIssues(body.issues || [])
  }

  async function syncIssues() {
    if (!selectedRepo?.id) return
    setLoadingIssues(true)
    try {
      const body = await api<{ issues: IssueRow[] }>(`/api/repositories/${encodeURIComponent(selectedRepo.id)}/issues/sync`, {
        method: "POST",
      })
      setIssues(body.issues || [])
    } catch (error) {
      notifyError(error, "同步 issues 失败")
    } finally {
      setLoadingIssues(false)
    }
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
    const startProgress: InstallCheckProgress = {
      open: true,
      title: "正在检查",
      detail: "",
      steps: installCheckProgressSteps.map((step) => ({ ...step, status: "pending" })),
    }
    setCheckProgress(startProgress)
    setChecking(true)
    let nextCheck = installCheck
    let interrupted = false
    try {
      for (const checkType of ["permissions", "webhook", "variables", "runners", "plugins"]) {
        setCheckProgressStep(checkType, "running", "正在检查")
        let body = await checkInstallStep(checkType)
        nextCheck = mergeInstallCheck(nextCheck, body)
        setInstallCheck(nextCheck)
        let checkedStep = body.steps.find((step) => step.id === checkType)
        if (checkedStep && checkedStep.status !== "passed" && canAutoConfigureStep(checkType)) {
          setCheckProgressStep(checkType, "running", "自动配置")
          const fixed = await autoConfigureInstallStep(checkType)
          nextCheck = mergeInstallCheck(nextCheck, fixed)
          setInstallCheck(nextCheck)
          body = await checkInstallStep(checkType)
          nextCheck = mergeInstallCheck(nextCheck, body)
          setInstallCheck(nextCheck)
          checkedStep = body.steps.find((step) => step.id === checkType)
        }
        const needsManual = Boolean(checkedStep && checkedStep.status !== "passed")
        setCheckProgress((current) => ({
          ...current,
          title: needsManual ? "需要人工处理" : current.title,
          steps: current.steps.map((step) => ({
            ...step,
            status: step.id === checkType ? needsManual ? "failed" : "passed" : step.status,
          })),
        }))
        if (needsManual) {
          interrupted = true
          break
        }
      }
      await loadRepositories(selectedGitServerId)
      setCheckProgress((current) => ({
        ...current,
        open: true,
        title: interrupted ? current.title : "检查完成",
        detail: "",
      }))
      return nextCheck
    } catch (error) {
      setCheckProgress((current) => ({
        ...current,
        open: true,
        title: "检查失败",
        detail: "",
        steps: current.steps.map((step) => ({
          ...step,
          status: step.status === "running" ? "failed" : step.status,
        })),
      }))
      notifyError(error, "检查失败")
    } finally {
      setChecking(false)
    }
  }

  async function checkInstallStep(checkType: string) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    return api<InstallCheck>("/api/gitlab/install-check", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        checkType,
      }),
    })
  }

  function canAutoConfigureStep(checkType: string) {
    return ["permissions", "webhook", "runners"].includes(checkType)
  }

  async function autoConfigureInstallStep(checkType: string) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    const paths: Record<string, string> = { permissions: "/api/gitlab/install-permission", webhook: "/api/gitlab/install-webhook", runners: "/api/gitlab/install-runner" }
    const path = paths[checkType] || ""
    if (!path) throw new Error("install_step_not_auto_configurable")
    return api<InstallCheck>(path, {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
      }),
    })
  }

  function setCheckProgressStep(checkType: string, status: InstallCheckProgress["steps"][number]["status"], title: string) {
    setCheckProgress((current) => ({
      ...current,
      open: true,
      title,
      detail: installCheckProgressSteps.find((step) => step.id === checkType)?.label || "",
      steps: current.steps.map((step) => ({
        ...step,
        status: step.id === checkType ? status : step.status,
      })),
    }))
  }

  function closeCheckProgress() {
    if (!checking) setCheckProgress((current) => ({ ...current, open: false }))
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
  async function setInstallRunner() {
    if (!selectedProject || !selectedGitServerId) return
    setChecking(true)
    try {
      const nextCheck = mergeInstallCheck(installCheck, await autoConfigureInstallStep("runners"))
      setInstallCheck(nextCheck)
      await loadRepositories(selectedGitServerId)
      return nextCheck
    } catch (error) { notifyError(error, "配置 GitLab Runner 失败") } finally { setChecking(false) }
  }

  async function installPlugin() {
    if (!selectedProject || !selectedGitServerId) return
    if (projectAccess && !projectAccess.canManage) {
      toast.warning("权限不足", {
        description: `当前角色 ${projectAccess.role || "-"} 仅可查看，不能安装 plugin。`,
      })
      return
    }
    const plugin = selectedRepo?.settings?.plugins?.items?.find((item) => item.key === "issue-flow")
    const operationLabel = plugin?.installed ? "升级" : "安装"
    setChecking(true)
    setCheckProgress({
      open: true,
      title: `正在${operationLabel} issue-flow`,
      detail: "",
      steps: pluginInstallProgressSteps.map((step) => ({ ...step })),
    })
    try {
      const body = await streamInstallPlugin({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
      }, (event, data) => {
        if (event !== "progress") return
        setCheckProgress((current) => pluginInstallProgressFromEvent(current, operationLabel, data))
      })
      return await finishPluginInstall(body, operationLabel)
    } catch (error) {
      if (isStreamConnectionError(error)) {
        try {
          setCheckProgress((current) => ({
            ...current,
            open: true,
            title: "正在恢复安装状态",
            detail: "流式连接中断，正在读取最新 MR 状态。",
          }))
          const body = await requestInstallPlugin({
            gitServerId: selectedGitServerId,
            projectId: selectedProject.id,
          })
          return await finishPluginInstall(body, operationLabel)
        } catch (recoverError) {
          notifyError(recoverError, "恢复安装状态失败")
        }
      }
      setCheckProgress((current) => ({
        ...current,
        open: true,
        title: `${operationLabel}失败`,
        steps: current.steps.map((step) => ({
          ...step,
          status: step.status === "running" ? "failed" : step.status,
        })),
      }))
      notifyError(error, "安装 plugin 失败")
    } finally {
      setChecking(false)
    }
  }
  async function finishPluginInstall(body: InstallCheck, operationLabel: string) {
    const nextCheck = mergeInstallCheck(installCheck, body)
    setInstallCheck(nextCheck)
    await loadRepositories(selectedGitServerId)
    setCheckProgress((current) => pluginInstallCompleteProgress(current, body, operationLabel))
    return nextCheck
  }
  async function loginGitLab(gitServerId = selectedGitServerId, options: { returnTo?: string } = {}) {
    if (!gitServerId) {
      toast.warning("请先选择 Git server")
      return
    }
    try {
      const body = await api<{ authorizeUrl: string }>("/api/auth/gitlab/authorize", {
        method: "POST",
        body: JSON.stringify({ gitServerId, returnTo: options.returnTo || `${window.location.pathname}${window.location.search}` }),
      })
      window.location.href = body.authorizeUrl
    } catch (error) {
      notifyError(error, "登录 GitLab 失败")
    }
  }
  async function initializeSetup(input: SetupInitializeInput) {
    setInitializingSetup(true)
    try {
      const result = await initializeIssueFlowSetup(input)
      setSelectedGitServerId(result.gitServer.id)
      window.location.href = result.authorizeUrl
    } catch (error) {
      notifyError(error, "初始化失败")
    } finally {
      setInitializingSetup(false)
    }
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
    void loginGitLab(gitServerId)
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
    ;(async () => {
      try {
        const status = await loadSetupStatus()
        if (status.needsSetup) {
          applyRoute(setupRoute, "replace")
          return
        }
        await Promise.all([loadGitServers(), loadUserSession()])
      } catch (error) {
        notifyError(error, "加载失败")
      } finally {
        setBooting(false)
      }
    })()
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
    if (activeTab !== "settings" || !selectedGitServerId || !selectedProject || !pendingPluginMergeRequestHref) return
    void (async () => {
      const body = await checkInstallStep("plugins")
      setInstallCheck(mergeInstallCheck(installCheck, body))
      await loadRepositories(selectedGitServerId)
    })().catch((error) => notifyError(error, "刷新 MR 状态失败"))
  }, [activeTab, selectedGitServerId, selectedProject?.id, pendingPluginMergeRequestHref])

  useEffect(() => {
    void loadActivity(selectedRepo?.id).catch((error) => {
      notifyError(error, "加载活动失败")
    })
  }, [selectedRepo?.id])

  useEffect(() => {
    void loadIssues(selectedRepo?.id).catch((error) => {
      notifyError(error, "加载 issues 失败")
    })
  }, [selectedRepo?.id])

  async function reloadLoginState() {
    try {
      const status = await loadSetupStatus()
      if (status.needsSetup) {
        applyRoute(setupRoute, "replace")
        return
      }
      await Promise.all([loadGitServers(), loadUserSession()])
    } catch (error) {
      notifyError(error, "重新加载失败")
    }
  }

  return {
    booting,
    setupStatus,
    initializingSetup,
    initializeSetup,
    userSession,
    gitServers,
    loginGitLab,
    reloadLoginState,
    route,
    sidebarCollapsed,
    sidebar: {
      collapsed: sidebarCollapsed,
      gitServers,
      selectedGitServerId,
      selectedGitServer,
      user: userSession.user,
      currentUser,
      projects: filteredProjects,
      selectedProjectId,
      owner,
      owners,
      filter,
      loading: loadingProjects,
      onSelectGitServer: selectGitServer,
      onOwner: setOwner,
      onFilter: setFilter,
      onSelectProject: selectProject,
      onLoginCurrent: () => loginGitLab(selectedGitServerId),
      onRefresh: syncGitServer,
      onLogout: logoutAll,
      onOpenUserSettings: openUserSettings,
      onCollapsedChange: updateSidebarCollapsed,
    },
    userSettings: {
      userSession,
      gitServers,
      pendingGitServerId,
      onConnectGitServer: connectGitServerAccount,
    },
    workspace: {
      tab: activeTab,
      onTab: selectTab,
      gitServer: selectedGitServer,
      user: currentUser,
      project: selectedProject,
      repository: selectedRepo,
      defaults: agentrixDefaults,
      installCheck,
      checkProgress,
      checking,
      projectAccess,
      loadingProjectAccess,
      gitEvents,
      issues,
      loadingIssues,
      onLogin: () => loginGitLab(selectedGitServerId),
      onSyncIssues: syncIssues,
      onCheck: runInstallCheck,
      onCloseCheckProgress: closeCheckProgress,
      onSetVariable: setInstallVariable,
      onSetWebhook: setInstallWebhook,
      onSetRunner: setInstallRunner,
      onInstallPlugin: installPlugin,
    },
  }
}
