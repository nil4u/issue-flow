import { useEffect, useState } from "react"
import { toast } from "sonner"

import { parseWorkspaceRoute, sameWorkspaceRoute, setupRoute, userSettingsRoute, workspaceRoutePath, type WorkspaceRoute } from "@/app-route"
import {
  api,
  ownerOf,
  repositoryToProject,
  type AgentrixDefaults,
  type GitLabProject,
  type GitLabUser,
  type GitServer,
  type InstallCheck,
  type InstallStep,
  type InstallConflictDecision,
  type InstallConflictPlan,
  type InstallCheckProgress,
  type ProjectAccess,
  type Repository,
  type SessionState,
  type SetupStatus,
  type UserSession,
  type WorkspaceTab,
} from "@/issue-flow-model"
import { useIssuesState } from "@/hooks/use-issues-state"
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

function hasPendingAutoVariables(step?: InstallStep) {
  return Boolean(step?.variables?.some((variable) => {
    const status = String(variable.status || "")
    return status === "pending_auto"
      || status === "needs_action" && Boolean(variable.autoWritable ?? variable.writable)
  }))
}

function variableBlockers(step?: InstallStep) {
  return (step?.variables || []).filter((variable) => {
    const status = String(variable.status || "")
    return Boolean(variable.blocker)
      || status === "manual_required"
      || status === "failed"
      || status === "needs_input"
  })
}

function variableBlockerDetail(step?: InstallStep) {
  const blockers = variableBlockers(step)
  if (!blockers.length) return step?.detail || ""
  return blockers
    .map((variable) => variable.detail || `${variable.key} 需要人工处理`)
    .join("；")
}

function hasFailedVariables(step?: InstallStep) {
  return Boolean(step?.variables?.some((variable) => String(variable.status || "") === "failed"))
}

export function useDashboardController() {
  const [route, setRoute] = useState<WorkspaceRoute>(() => parseWorkspaceRoute())
  const [booting, setBooting] = useState(true)
  const [setupStatus, setSetupStatus] = useState<SetupStatus>()
  const [loadingLoginState, setLoadingLoginState] = useState(true)
  const [initializingSetup, setInitializingSetup] = useState(false)
  const [gitServers, setGitServers] = useState<GitServer[]>([])
  const [selectedGitServerId, setSelectedGitServerId] = useState(() => route.gitServerId)
  const [userSession, setUserSession] = useState<UserSession>({ authenticated: false })
  const [sessions, setSessions] = useState<Record<string, SessionState>>({})
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repositoryDetails, setRepositoryDetails] = useState<Record<string, Repository>>({})
  const [loadingRepositoryDetails, setLoadingRepositoryDetails] = useState(false)
  const [projects, setProjects] = useState<GitLabProject[]>([])
  const [repoPage, setRepoPage] = useState(1)
  const [repoHasMore, setRepoHasMore] = useState(false)
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState(() => route.projectId)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => route.tab)
  const [filter, setFilter] = useState("")
  const [owner, setOwner] = useState("all")
  const [owners, setOwners] = useState<string[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectLoadingLabel, setProjectLoadingLabel] = useState("")
  const [agentrixDefaults, setAgentrixDefaults] = useState<AgentrixDefaults>()
  const [installCheck, setInstallCheck] = useState<InstallCheck>()
  const [installConflictPlan, setInstallConflictPlan] = useState<InstallConflictPlan>()
  const [checkProgress, setCheckProgress] = useState<InstallCheckProgress>({
    open: false,
    steps: installCheckProgressSteps,
  })
  const [projectAccess, setProjectAccess] = useState<ProjectAccess>()
  const [loadingProjectAccess, setLoadingProjectAccess] = useState(false)
  const [checking, setChecking] = useState(false)
  const {
    issues,
    loadingIssues,
    loadIssues,
    syncIssues: syncRepoIssues,
    hasAutoSynced,
    markAutoSynced,
  } = useIssuesState()
  const [pendingGitServerId, setPendingGitServerId] = useState("")
  const [savingGitServerId, setSavingGitServerId] = useState("")
  const [deletingGitServerId, setDeletingGitServerId] = useState("")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem("issue-flow.sidebarCollapsed") === "1"
  })
  const selectedGitServer = gitServers.find((server) => server.id === selectedGitServerId)
  const currentSession = sessions[selectedGitServerId]
  const currentUser = currentSession?.authenticated ? currentSession.user : undefined
  const selectedProject = projects.find((project) => (
    project.id === selectedProjectId
    && (!project.gitServerId || project.gitServerId === selectedGitServerId)
  ))
  const selectedRepoSummary = selectedProject
    ? repositories.find((repo) => (
      (!selectedProject.gitServerId || repo.gitServerId === selectedProject.gitServerId)
      && (
        repo.id === selectedProject.id
        || String(repo.projectId || "") === String(selectedProject.id)
        || repo.projectPath === selectedProject.pathWithNamespace
      )
    ))
    : undefined
  const selectedRepo = selectedRepoSummary ? repositoryDetails[selectedRepoSummary.id] || selectedRepoSummary : undefined
  const pendingPluginMergeRequestHref = selectedRepo?.settings?.plugins?.items?.find((item) => item.key === "issue-flow")?.pendingMergeRequest?.webUrl || ""
  const filteredProjects = projects

  function mergeRepositories(current: Repository[], next: Repository[]) {
    const merged = new Map(current.map((repo) => [repo.id, repo]))
    for (const repo of next) merged.set(repo.id, repo)
    return Array.from(merged.values())
  }

  function rememberRepositoryDetail(repository?: Repository | null) {
    if (!repository?.id) return
    setRepositoryDetails((current) => ({ ...current, [repository.id]: repository }))
  }

  function applyInstallCheck(current: InstallCheck | undefined, next: InstallCheck) {
    const merged = mergeInstallCheck(current, next)
    rememberRepositoryDetail(next.repository)
    setInstallCheck(merged)
    return merged
  }

  function resetRepositoryState() {
    setRepositories([])
    setRepositoryDetails({})
    setProjects([])
    setOwners([])
    setRepoPage(1)
    setRepoHasMore(false)
  }

  function updateOwner(nextOwner: string) {
    if (owner === nextOwner) return
    setFilter("")
    setOwner(nextOwner)
  }

  function updateFilter(nextFilter: string) {
    setFilter(nextFilter)
    if (nextFilter.trim() && owner !== "all") setOwner("all")
  }

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
  function navigateUserSettings(settingsSection: WorkspaceRoute["settingsSection"] = "account", mode: "push" | "replace" = "push") {
    applyRoute({ ...userSettingsRoute, settingsSection }, mode)
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

  async function saveGitServer(input: GitServer) {
    setSavingGitServerId(input.id || "new")
    try {
      const body = await api<{ gitServer: GitServer }>("/api/git-servers", {
        method: "POST",
        body: JSON.stringify(input),
      })
      const servers = await loadGitServers()
      if (!selectedGitServerId && body.gitServer?.id) {
        setSelectedGitServerId(body.gitServer.id)
      }
      toast.success("Git server 已保存")
      return servers
    } catch (error) {
      notifyError(error, "保存 Git server 失败")
      throw error
    } finally {
      setSavingGitServerId("")
    }
  }

  async function deleteGitServer(gitServerId: string) {
    setDeletingGitServerId(gitServerId)
    try {
      await api(`/api/git-servers/${encodeURIComponent(gitServerId)}`, { method: "DELETE" })
      const servers = await loadGitServers()
      if (selectedGitServerId === gitServerId) {
        const nextId = servers.find((server) => server.id !== gitServerId)?.id || servers[0]?.id || ""
        setSelectedGitServerId(nextId)
        setSelectedProjectId("")
        setRepositories([])
        setProjects([])
      }
      toast.success("Git server 已删除")
      return servers
    } catch (error) {
      notifyError(error, "删除 Git server 失败")
      throw error
    } finally {
      setDeletingGitServerId("")
    }
  }

  async function loadUserSession() {
    const body = await api<UserSession>("/api/user/session")
    setUserSession(body)
    setSessions(Object.fromEntries((body.accounts || [])
      .filter((account) => account.session?.gitServerId || account.gitServer?.id || account.account?.gitServerId)
      .map((account) => {
        const gitServerId = account.session?.gitServerId || account.gitServer?.id || account.account?.gitServerId || ""
        return [gitServerId, {
          authenticated: Boolean(account.session),
          user: account.user,
          gitServer: account.gitServer,
          session: account.session,
        }]
      })))
    return body
  }
  async function loadSetupStatus() {
    const body = await api<SetupStatus>("/api/setup/status")
    setSetupStatus(body)
    return body
  }

  async function loadLoginState() {
    setLoadingLoginState(true)
    return Promise.all([loadGitServers(), loadUserSession()]).finally(() => setLoadingLoginState(false))
  }

  async function loadRepositories(gitServerId = selectedGitServerId, options: { page?: number; append?: boolean; includeSelectedProject?: boolean; fallbackProject?: "first" | "none" } = {}) {
    const q = filter.trim()
    const searchAllServers = Boolean(q)
    const scopeGitServerId = searchAllServers ? "" : gitServerId
    if (!scopeGitServerId && !searchAllServers) {
      resetRepositoryState()
      return []
    }
    const page = options.page || 1
    const params = new URLSearchParams({ page: String(page), perPage: "50" })
    if (scopeGitServerId) params.set("gitServerId", scopeGitServerId)
    if (options.includeSelectedProject && selectedProjectId && !searchAllServers) params.set("selectedProjectId", selectedProjectId)
    if (q) params.set("q", q)
    if (!q && owner !== "all") params.set("owner", owner)
    const body = await api<{ repositories: Repository[]; owners?: string[]; page?: number; hasMore?: boolean }>(`/api/repositories?${params.toString()}`)
    const repos = body.repositories || []
    const nextRepos = options.append ? mergeRepositories(repositories, repos) : repos
    setRepositories(nextRepos)
    if (!options.append) {
      const nextRepoIds = new Set(nextRepos.map((repo) => repo.id))
      setRepositoryDetails((current) => Object.fromEntries(Object.entries(current).filter(([repoId]) => nextRepoIds.has(repoId))))
    }
    if (body.owners) setOwners(body.owners)
    setRepoPage(body.page || page)
    setRepoHasMore(Boolean(body.hasMore))
    const nextProjects = nextRepos.map(repositoryToProject)
    setProjects(nextProjects)
    const currentRoute = parseWorkspaceRoute()
    setSelectedProjectId((current) => {
      if (currentRoute.gitServerId === scopeGitServerId && currentRoute.projectId && nextProjects.some((project) => (
        project.id === currentRoute.projectId && project.gitServerId === currentRoute.gitServerId
      ))) {
        return currentRoute.projectId
      }
      if (current && nextProjects.some((project) => (
        project.id === current && project.gitServerId === gitServerId
      ))) return current
      if (options.fallbackProject === "none") return ""
      return nextProjects[0]?.id || ""
    })
    return nextRepos
  }

  async function loadMoreRepositories() {
    if ((!selectedGitServerId && !filter.trim()) || loadingProjects || loadingMoreProjects || !repoHasMore) return
    setLoadingMoreProjects(true)
    try {
      await loadRepositories(filter.trim() ? "" : selectedGitServerId, { page: repoPage + 1, append: true })
    } catch (error) {
      notifyError(error, "加载更多仓库失败")
    } finally {
      setLoadingMoreProjects(false)
    }
  }

  async function loadRepositoryDetail(repoId?: string) {
    if (!repoId) return undefined
    setLoadingRepositoryDetails(true)
    try {
      const body = await api<{ repository: Repository }>(`/api/repositories/${encodeURIComponent(repoId)}`)
      if (body.repository?.id) {
        setRepositoryDetails((current) => ({ ...current, [body.repository.id]: body.repository }))
      }
      return body.repository
    } finally {
      setLoadingRepositoryDetails(false)
    }
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
    // 身份来自 console session,gitServerId 仅作兼容参数传递,后端已忽略。
    const params = gitServerId ? `?gitServerId=${encodeURIComponent(gitServerId)}` : ""
    const body = await api<{ config: AgentrixDefaults }>(`/api/user/agentrix-config${params}`)
    setAgentrixDefaults(body.config)
  }

  async function syncGitServer(gitServerId = selectedGitServerId) {
    if (!gitServerId) return
    setLoadingProjects(true)
    setProjectLoadingLabel("同步仓库...")
    try {
      const session = await loadSession(gitServerId)
      if (!session.authenticated) {
        resetRepositoryState()
        setAgentrixDefaults(undefined)
        return
      }
      await api<{ projects: GitLabProject[] }>("/api/gitlab/projects", {
        method: "POST",
        body: JSON.stringify({ gitServerId }),
      })
      await Promise.all([loadAgentrixDefaults(gitServerId), loadRepositories(gitServerId, { includeSelectedProject: true })])
    } catch (error) {
      notifyError(error, "同步仓库失败")
    } finally {
      setLoadingProjects(false)
      setProjectLoadingLabel("")
    }
  }

  async function loadGitServerState(gitServerId = selectedGitServerId) {
    if (!gitServerId) return
    setLoadingProjects(true)
    setProjectLoadingLabel("加载仓库...")
    try {
      const session = await loadSession(gitServerId)
      if (!session.authenticated) {
        resetRepositoryState()
        setAgentrixDefaults(undefined)
        return
      }
      await loadRepositories(gitServerId, { includeSelectedProject: true })
    } catch (error) {
      notifyError(error, "加载仓库失败")
    } finally {
      setLoadingProjects(false)
      setProjectLoadingLabel("")
    }
  }

  async function syncIssues() {
    await syncRepoIssues(selectedRepo?.id)
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

  async function runInstallCheck(input: Record<string, unknown> = {}) {
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
    setInstallCheck(undefined)
    setCheckProgress(startProgress)
    setChecking(true)
    let nextCheck: InstallCheck | undefined
    let interrupted = false
    try {
      for (const checkType of ["permissions", "webhook", "variables", "runners", "plugins"]) {
        setCheckProgressStep(checkType, "running", "正在检查")
        let body = await checkInstallStep(checkType, input)
        let checkedStep = body.steps.find((step) => step.id === checkType)
        if (checkType === "variables") {
          if (hasPendingAutoVariables(checkedStep)) {
            setCheckProgressStep(checkType, "running", "正在自动写入")
            nextCheck = applyInstallCheck(nextCheck, body)
            const fixed = await autoConfigureInstallStep(checkType, input)
            nextCheck = applyInstallCheck(nextCheck, fixed)
            const fixedStep = fixed.steps.find((step) => step.id === checkType)
            if (hasFailedVariables(fixedStep)) {
              body = fixed
              checkedStep = fixedStep
            } else {
              body = await checkInstallStep(checkType, input)
              checkedStep = body.steps.find((step) => step.id === checkType)
            }
          }
          const needsManual = variableBlockers(checkedStep).length > 0 || checkedStep?.status === "failed"
          setCheckProgress((current) => ({
            ...current,
            title: needsManual ? "需要人工处理" : current.title,
            detail: needsManual ? variableBlockerDetail(checkedStep) : current.detail,
            steps: current.steps.map((step) => ({
              ...step,
              status: step.id === checkType ? needsManual ? "failed" : "passed" : step.status,
            })),
          }))
          if (needsManual) {
            nextCheck = applyInstallCheck(nextCheck, body)
            interrupted = true
            break
          }
          nextCheck = applyInstallCheck(nextCheck, body)
          continue
        }
        nextCheck = applyInstallCheck(nextCheck, body)
        if (checkedStep && checkedStep.status !== "passed" && canAutoConfigureStep(checkType)) {
          setCheckProgressStep(checkType, "running", "自动配置")
          const fixed = await autoConfigureInstallStep(checkType, input)
          nextCheck = applyInstallCheck(nextCheck, fixed)
          body = await checkInstallStep(checkType, input)
          nextCheck = applyInstallCheck(nextCheck, body)
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
      await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
      setCheckProgress((current) => ({
        ...current,
        open: true,
        title: interrupted ? current.title : "检查完成",
        detail: interrupted ? current.detail : "",
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

  async function checkInstallStep(checkType: string, input: Record<string, unknown> = {}) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    return api<InstallCheck>("/api/gitlab/install-check", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        checkType,
        ...input,
      }),
    })
  }

  function canAutoConfigureStep(checkType: string) {
    return ["permissions", "webhook", "variables", "runners"].includes(checkType)
  }

  async function autoConfigureInstallStep(checkType: string, input: Record<string, unknown> = {}) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    const paths: Record<string, string> = {
      permissions: "/api/gitlab/install-permission",
      webhook: "/api/gitlab/install-webhook",
      variables: "/api/gitlab/install-variable",
      runners: "/api/gitlab/install-runner",
    }
    const path = paths[checkType] || ""
    if (!path) throw new Error("install_step_not_auto_configurable")
    return api<InstallCheck>(path, {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        ...input,
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
      const nextCheck = applyInstallCheck(installCheck, body)
      await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
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
      const nextCheck = applyInstallCheck(installCheck, body)
      await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
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
      const nextCheck = applyInstallCheck(installCheck, await autoConfigureInstallStep("runners"))
      await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
      return nextCheck
    } catch (error) { notifyError(error, "配置 GitLab Runner 失败") } finally { setChecking(false) }
  }

  async function installPlugin(decisions?: InstallConflictDecision) {
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
        decisions,
      }, (event, data) => {
        if (event !== "progress") return
        setCheckProgress((current) => pluginInstallProgressFromEvent(current, operationLabel, data))
      })
      if (body.kind === "conflicts") {
        setInstallConflictPlan(body.plan)
        setCheckProgress((current) => ({
          ...current,
          open: false,
          title: "需要确认文件冲突",
          detail: `${body.plan.conflicts.length} 个冲突需要处理。`,
        }))
        return
      }
      setInstallConflictPlan(undefined)
      return await finishPluginInstall(body.body, operationLabel)
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
            decisions,
          })
          if (body.kind === "conflicts") {
            setInstallConflictPlan(body.plan)
            setCheckProgress((current) => ({
              ...current,
              open: false,
              title: "需要确认文件冲突",
              detail: `${body.plan.conflicts.length} 个冲突需要处理。`,
            }))
            return
          }
          setInstallConflictPlan(undefined)
          return await finishPluginInstall(body.body, operationLabel)
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
    const nextCheck = applyInstallCheck(installCheck, body)
    await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
    setCheckProgress((current) => pluginInstallCompleteProgress(current, body, operationLabel))
    return nextCheck
  }
  async function confirmInstallConflicts(decision: InstallConflictDecision) {
    return installPlugin(decision)
  }
  function cancelInstallConflicts() {
    setInstallConflictPlan(undefined)
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
      resetRepositoryState()
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
    resetRepositoryState()
    setActiveTab("overview")
    updateOwner("all")
    setFilter("")
    setInstallCheck(undefined)
    setProjectAccess(undefined)
    navigateWorkspace({ gitServerId, projectId: "", tab: "overview" })
  }

  function selectProject(projectId: string, projectGitServerId = selectedGitServerId) {
    const project = projects.find((item) => (
      item.id === projectId
      && (!projectGitServerId || !item.gitServerId || item.gitServerId === projectGitServerId)
    ))
    const nextGitServerId = project?.gitServerId || projectGitServerId
    if (nextGitServerId && nextGitServerId !== selectedGitServerId) setSelectedGitServerId(nextGitServerId)
    setSelectedProjectId(projectId)
    setActiveTab("overview")
    setInstallCheck(undefined)
    setProjectAccess(undefined)
    const nextOwner = ownerOf(project)
    if (nextOwner) updateOwner(nextOwner)
    navigateWorkspace({ gitServerId: nextGitServerId, projectId, tab: "overview" })
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
        if (status.needsSetup) return applyRoute(setupRoute, "replace")
      } catch (error) {
        setLoadingLoginState(false)
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
    if (booting || !setupStatus || setupStatus.needsSetup) return
    void loadLoginState().catch((error) => notifyError(error, "加载登录状态失败"))
  }, [booting, setupStatus?.needsSetup])

  useEffect(() => {
    if (!selectedGitServerId || !userSession.authenticated) return
    updateOwner("all")
    setInstallCheck(undefined)
    setProjectAccess(undefined)
    void loadGitServerState(selectedGitServerId)
  }, [selectedGitServerId, userSession.authenticated])

  useEffect(() => {
    setInstallCheck(undefined)
    setInstallConflictPlan(undefined)
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
    if (nextOwner) updateOwner(nextOwner)
  }, [selectedProject?.id])

  useEffect(() => {
    if ((!selectedGitServerId && !filter.trim()) || !userSession.authenticated) return
    void loadRepositories(filter.trim() ? "" : selectedGitServerId, { fallbackProject: "none" }).catch((error) => notifyError(error, "加载仓库失败"))
  }, [filter, owner])

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
    if (activeTab === "issues" || !selectedGitServerId || !userSession.authenticated) return
    if (!selectedRepoSummary?.id || repositoryDetails[selectedRepoSummary.id]?.settings) return
    void loadRepositoryDetail(selectedRepoSummary.id).catch((error) => notifyError(error, "加载仓库详情失败"))
  }, [activeTab, selectedGitServerId, selectedRepoSummary?.id, userSession.authenticated, repositoryDetails])

  useEffect(() => {
    if (activeTab !== "settings" || !selectedGitServerId || !selectedProject || !pendingPluginMergeRequestHref) return
    void (async () => {
      const body = await checkInstallStep("plugins")
      applyInstallCheck(installCheck, body)
      await loadRepositories(selectedGitServerId, { includeSelectedProject: true })
    })().catch((error) => notifyError(error, "刷新 MR 状态失败"))
  }, [activeTab, selectedGitServerId, selectedProject?.id, pendingPluginMergeRequestHref])

  useEffect(() => {
    const repoId = selectedRepo?.id
    void loadIssues(repoId).then((nextIssues) => {
      if (!repoId || activeTab !== "issues" || nextIssues.length > 0 || hasAutoSynced(repoId)) return
      markAutoSynced(repoId)
      return syncRepoIssues(repoId)
    }).catch((error) => {
      notifyError(error, "加载 issues 失败")
    })
  }, [activeTab, selectedRepo?.id, loadIssues, syncRepoIssues, hasAutoSynced, markAutoSynced])

  async function reloadLoginState() {
    try {
      const status = await loadSetupStatus()
      if (status.needsSetup) return applyRoute(setupRoute, "replace")
      await loadLoginState()
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
    loadingLoginState,
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
      loadingMore: loadingMoreProjects,
      hasMore: repoHasMore,
      loadingLabel: projectLoadingLabel,
      onSelectGitServer: selectGitServer,
      onOwner: updateOwner,
      onFilter: updateFilter,
      onLoadMore: loadMoreRepositories,
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
      activeSection: route.settingsSection,
      pendingGitServerId,
      savingGitServerId,
      deletingGitServerId,
      onSelectSection: (section: WorkspaceRoute["settingsSection"]) => navigateUserSettings(section),
      onConnectGitServer: connectGitServerAccount,
      onSaveGitServer: saveGitServer,
      onDeleteGitServer: deleteGitServer,
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
      installConflictPlan,
      checking,
      projectAccess,
      loadingProjectAccess,
      loadingRepositoryDetails,
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
      onConfirmInstallConflicts: confirmInstallConflicts,
      onCancelInstallConflicts: cancelInstallConflicts,
    },
  }
}
