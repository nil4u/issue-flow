import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { api, type GitLabProject, type Repository, type ProjectAccess, type InstallCheck,
  type InstallStep, type InstallCheckProgress, type InstallConflictDecision, type InstallConflictPlan,
  type GroupVariableDecision, type GroupVariablePrompt } from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"
import { installProgressSteps, type InstallationPlan } from "@/lib/installation-plan"
import {
  isStreamConnectionError,
  mergeInstallCheck,
  pluginInstallCompleteProgress,
  pluginInstallProgressSteps,
  pluginInstallProgressFromEvent,
  requestInstallPlugin,
  streamInstallPlugin,
} from "@/lib/install-flow"

function hasPendingAutoVariables(step?: InstallStep) {
  return Boolean(step?.variables?.some((variable) => {
    const status = String(variable.status || "")
    return status === "pending_auto"
      || status === "needs_action" && Boolean(variable.autoWritable ?? variable.writable)
      || status === "unverified" && Boolean(variable.autoWritable ?? variable.writable)
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

function unverifiedVariables(step?: InstallStep) {
  return (step?.variables || []).filter((variable) => String(variable.status || "") === "unverified")
}

function variableWarningDetail(step?: InstallStep) {
  const warnings = unverifiedVariables(step)
  return warnings.length
    ? warnings.map((variable) => variable.detail || `${variable.key} 无法验证`).join("；")
    : ""
}

function groupAccessForbiddenAutoVariables(step?: InstallStep) {
  return (step?.variables || []).filter((variable) => {
    const status = String(variable.status || "")
    return status === "unverified"
      && Boolean(variable.groupAccessForbidden ?? variable.unverified)
      && Boolean(variable.autoWritable ?? variable.writable)
      && !variable.manualRequired
      && !variable.needsInput
  })
}

type InstallationOptions = {
  selectedProject?: GitLabProject
  selectedGitServerId: string
  selectedRepo?: Repository
  projectAccess?: ProjectAccess
  rememberRepositoryDetail: (repository?: Repository | null) => void
  reloadRepositories: () => Promise<unknown>
}

export function useInstallation({ selectedProject, selectedGitServerId, selectedRepo, projectAccess, rememberRepositoryDetail, reloadRepositories }: InstallationOptions) {
  const [installCheck, setInstallCheck] = useState<InstallCheck>()
  const [installConflictPlan, setInstallConflictPlan] = useState<InstallConflictPlan>()
  const [groupVariablePrompt, setGroupVariablePrompt] = useState<GroupVariablePrompt>()
  const [checkProgress, setCheckProgress] = useState<InstallCheckProgress>({
    open: false,
    steps: [],
  })
  const groupVariablePromptResolver = useRef<((decision: GroupVariableDecision) => void) | undefined>(undefined)
  const installCheckController = useRef<AbortController | undefined>(undefined)
  const [checking, setChecking] = useState(false)

  useEffect(() => () => {
    installCheckController.current?.abort()
    groupVariablePromptResolver.current?.("skip")
  }, [selectedGitServerId, selectedProject?.id])

  function applyInstallCheck(current: InstallCheck | undefined, next: InstallCheck) {
    const merged = mergeInstallCheck(current, next)
    rememberRepositoryDetail(next.repository)
    setInstallCheck((existing) => mergeInstallCheck(existing, next))
    return merged
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
      steps: [],
    }
    setInstallCheck(undefined)
    setCheckProgress(startProgress)
    setChecking(true)
    installCheckController.current?.abort()
    const controller = new AbortController()
    installCheckController.current = controller
    let nextCheck: InstallCheck | undefined
    let interrupted = false
    const warnings: string[] = []
    try {
      const plan = await api<InstallationPlan>("/api/installation/plan", {
        method: "POST",
        body: JSON.stringify({ gitServerId: selectedGitServerId }),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setCheckProgress((current) => ({ ...current, steps: installProgressSteps(plan) }))
      for (const definition of plan.steps) {
        const checkType = definition.id
        setCheckProgressStep(checkType, "running", "正在检查")
        let body = await checkInstallStep(checkType, input, controller.signal)
        let checkedStep = body.steps.find((step) => step.id === checkType)
        if (checkType === "variables") {
          if (hasPendingAutoVariables(checkedStep)) {
            const needsDecision = groupAccessForbiddenAutoVariables(checkedStep)
            let shouldAutoConfigure = true
            if (needsDecision.length) {
              nextCheck = applyInstallCheck(nextCheck, body)
              const decision = await requestGroupVariableDecision(needsDecision)
              if (controller.signal.aborted) return
              shouldAutoConfigure = decision === "install_project"
            }
            if (shouldAutoConfigure) {
              setCheckProgressStep(checkType, "running", "正在自动写入")
              nextCheck = applyInstallCheck(nextCheck, body)
              const fixed = await autoConfigureInstallStep(checkType, input, controller.signal)
              nextCheck = applyInstallCheck(nextCheck, fixed)
              const fixedStep = fixed.steps.find((step) => step.id === checkType)
              if (hasFailedVariables(fixedStep)) {
                body = fixed
                checkedStep = fixedStep
              } else {
                body = await checkInstallStep(checkType, input, controller.signal)
                checkedStep = body.steps.find((step) => step.id === checkType)
              }
            }
          }
          const needsManual = variableBlockers(checkedStep).length > 0 || checkedStep?.status === "failed"
          const warningDetail = variableWarningDetail(checkedStep)
          const hasWarnings = Boolean(warningDetail)
          const progressStatus = needsManual ? "failed" : hasWarnings ? "warning" : "passed"
          if (hasWarnings) warnings.push(warningDetail)
          setCheckProgress((current) => ({
            ...current,
            title: needsManual ? "需要人工处理" : current.title,
            detail: needsManual
              ? variableBlockerDetail(checkedStep)
              : warningDetail || current.detail,
            steps: current.steps.map((step) => ({
              ...step,
              status: step.id === checkType ? progressStatus : step.status,
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
        if (checkedStep && checkedStep.status !== "passed" && definition.configurable) {
          setCheckProgressStep(checkType, "running", "自动配置")
          const fixed = await autoConfigureInstallStep(checkType, input, controller.signal)
          nextCheck = applyInstallCheck(nextCheck, fixed)
          body = await checkInstallStep(checkType, input, controller.signal)
          nextCheck = applyInstallCheck(nextCheck, body)
          checkedStep = body.steps.find((step) => step.id === checkType)
        }
        const needsManual = Boolean(checkedStep && checkedStep.status !== "passed")
        setCheckProgress((current) => ({
          ...current,
          title: needsManual ? "需要人工处理" : current.title,
          detail: needsManual ? checkedStep?.detail || "该配置项需要人工处理" : current.detail,
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
      if (controller.signal.aborted) return
      await reloadRepositories()
      if (controller.signal.aborted) return
      setCheckProgress((current) => ({
        ...current,
        open: true,
        title: interrupted ? current.title : warnings.length ? "检查完成，有配置项未验证" : "检查完成",
        detail: interrupted ? current.detail : warnings.join("；"),
      }))
      return nextCheck
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return
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
      groupVariablePromptResolver.current = undefined
      setGroupVariablePrompt(undefined)
      if (installCheckController.current === controller) {
        installCheckController.current = undefined
        setChecking(false)
      }
    }
  }

  async function requestGroupVariableDecision(variables: GroupVariablePrompt["variables"]) {
    return new Promise<GroupVariableDecision>((resolve) => {
      groupVariablePromptResolver.current = resolve
      setGroupVariablePrompt({ variables })
      setCheckProgress((current) => ({
        ...current,
        open: false,
        title: "发现无法验证的 group 变量",
        detail: "当前账号无权读取上级 group 变量。你可以继续写入到当前 Project，或跳过并继续检查后续配置。",
        steps: current.steps.map((step) => ({
          ...step,
          status: step.id === "variables" ? "warning" : step.status,
        })),
      }))
    })
  }

  function resolveGroupVariablePrompt(decision: GroupVariableDecision) {
    const resolve = groupVariablePromptResolver.current
    groupVariablePromptResolver.current = undefined
    setGroupVariablePrompt(undefined)
    resolve?.(decision)
  }

  async function checkInstallStep(checkType: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    return api<InstallCheck>("/api/installation/check", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        checkType,
        ...input,
      }),
      signal,
    })
  }

  async function autoConfigureInstallStep(checkType: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
    if (!selectedProject || !selectedGitServerId) throw new Error("project_required")
    return api<InstallCheck>("/api/installation/configure", {
      method: "POST",
      body: JSON.stringify({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        checkType,
        ...input,
      }),
      signal,
    })
  }

  function setCheckProgressStep(checkType: string, status: InstallCheckProgress["steps"][number]["status"], title: string) {
    setCheckProgress((current) => ({
      ...current,
      open: true,
      title,
      detail: current.steps.find((step) => step.id === checkType)?.label || "",
      steps: current.steps.map((step) => ({
        ...step,
        status: step.id === checkType ? status : step.status,
      })),
    }))
  }

  function closeCheckProgress() {
    if (groupVariablePromptResolver.current) {
      resolveGroupVariablePrompt("skip")
    }
    setCheckProgress((current) => ({ ...current, open: false }))
    installCheckController.current?.abort()
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
      const body = await autoConfigureInstallStep("variables", { key, ...input })
      const nextCheck = applyInstallCheck(installCheck, body)
      await reloadRepositories()
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
      const body = await autoConfigureInstallStep("webhook", input)
      const nextCheck = applyInstallCheck(installCheck, body)
      await reloadRepositories()
      return nextCheck
    } catch (error) {
      notifyError(error, "配置 webhook 失败")
    } finally {
      setChecking(false)
    }
  }

  async function setInstallLabels() {
    if (!selectedProject || !selectedGitServerId) return
    if (projectAccess && !projectAccess.canManage) {
      toast.warning("权限不足", {
        description: `当前角色 ${projectAccess.role || "-"} 仅可查看，不能更新 labels。`,
      })
      return
    }
    setChecking(true)
    try {
      return applyInstallCheck(installCheck, await autoConfigureInstallStep("labels"))
    } catch (error) {
      notifyError(error, "更新 Labels 失败")
    } finally {
      setChecking(false)
    }
  }

  async function setInstallRunner() {
    if (!selectedProject || !selectedGitServerId) return
    setChecking(true)
    try {
      const nextCheck = applyInstallCheck(installCheck, await autoConfigureInstallStep("runners"))
      await reloadRepositories()
      return nextCheck
    } catch (error) { notifyError(error, "配置 GitLab Runner 失败") } finally { setChecking(false) }
  }

  async function installPlugin(input: { commitMessage?: string; decisions?: InstallConflictDecision } = {}) {
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
      steps: pluginInstallProgressSteps.map((step) => ({ ...step, label: selectedRepo?.provider === "github" && step.id === "mr" ? "发起 PR" : step.label })),
    })
    try {
      const body = await streamInstallPlugin({
        gitServerId: selectedGitServerId,
        projectId: selectedProject.id,
        commitMessage: input.commitMessage?.trim() || undefined,
        decisions: input.decisions,
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
            detail: "流式连接中断，正在读取最新合并请求状态。",
          }))
          const body = await requestInstallPlugin({
            gitServerId: selectedGitServerId,
            projectId: selectedProject.id,
            commitMessage: input.commitMessage?.trim() || undefined,
            decisions: input.decisions,
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
    await reloadRepositories()
    setCheckProgress((current) => pluginInstallCompleteProgress(current, body, operationLabel))
    return nextCheck
  }
  async function confirmInstallConflicts(decision: InstallConflictDecision, commitMessage?: string) {
    return installPlugin({ decisions: decision, commitMessage })
  }
  function cancelInstallConflicts() {
    setInstallConflictPlan(undefined)
  }

  return { installCheck, setInstallCheck, installConflictPlan, setInstallConflictPlan, groupVariablePrompt, checkProgress, checking, applyInstallCheck, checkInstallStep, runInstallCheck, closeCheckProgress, resolveGroupVariablePrompt, setInstallVariable, setInstallWebhook, setInstallLabels, setInstallRunner, installPlugin, confirmInstallConflicts, cancelInstallConflicts }
}
