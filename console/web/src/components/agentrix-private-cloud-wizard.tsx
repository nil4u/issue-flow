import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleAlert, Cloud, Copy, KeyRound, Loader2, RefreshCw, Server, Terminal } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  api,
  type AgentrixCloud,
  type AgentrixPrivateCloudConfig,
  type GitServer,
  type RunnerGitlabToken,
  type RunnerGitlabTokenResult,
  type UserSession,
} from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

type StepId = "target" | "git" | "token" | "command"

const stepOrder: StepId[] = ["target", "git", "token", "command"]

const stepMeta: Record<StepId, { title: string; detail: string }> = {
  target: {
    title: "确认 Private Cloud",
    detail: "Cloud ID 和 runner secret 会从 Agentrix 自动读取。",
  },
  git: {
    title: "确认 Git 身份",
    detail: "选择一个已经关联到当前账号的 GitLab server。",
  },
  token: {
    title: "生成 GitLab Token",
    detail: "issue-flow 自动为当前 GitLab 用户生成 runner 专用 token。",
  },
  command: {
    title: "复制 Docker 命令",
    detail: "把命令粘贴到 Linux 服务器执行，runner 会自动注册到 Agentrix。",
  },
}

export function AgentrixPrivateCloudWizard({
  cloud,
  gitServers,
  onConnectGitServer,
  userSession,
}: {
  cloud: AgentrixCloud
  gitServers: GitServer[]
  onConnectGitServer: (gitServerId: string) => void
  userSession: UserSession
}) {
  const linkedGitServerIds = useMemo(() => new Set(
    (userSession.accounts || [])
      .map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "")
      .filter(Boolean),
  ), [userSession.accounts])
  const selectableServers = gitServers.filter((server) => server.type === "gitlab")
  const firstLinkedServer = selectableServers.find((server) => linkedGitServerIds.has(server.id))
  const [gitServerId, setGitServerId] = useState(firstLinkedServer?.id || selectableServers[0]?.id || "")
  const [step, setStep] = useState<StepId>("target")
  const [config, setConfig] = useState<AgentrixPrivateCloudConfig>()
  const [command, setCommand] = useState("")
  const [generating, setGenerating] = useState(false)
  const [loadingConfig, setLoadingConfig] = useState(false)
  const connected = Boolean(gitServerId && linkedGitServerIds.has(gitServerId))
  const existingToken = (config?.runnerGitlabTokens || []).find((token) => token.runnerId === cloud.id)
  const activeIndex = stepOrder.indexOf(step)
  const availableStepIndex = highestAvailableStepIndex()

  useEffect(() => {
    if (gitServerId || !selectableServers.length) return
    setGitServerId(firstLinkedServer?.id || selectableServers[0]?.id || "")
  }, [firstLinkedServer?.id, gitServerId, selectableServers])

  useEffect(() => {
    if (!gitServerId) return
    void loadConfig(gitServerId)
  }, [gitServerId])

  useEffect(() => {
    if (activeIndex <= availableStepIndex) return
    setStep(stepOrder[availableStepIndex])
  }, [activeIndex, availableStepIndex])

  async function loadConfig(nextGitServerId = gitServerId) {
    setLoadingConfig(true)
    try {
      const body = await api<AgentrixPrivateCloudConfig>(`/api/agentrix/private-cloud?gitServerId=${encodeURIComponent(nextGitServerId)}`)
      setConfig(body)
      return body
    } catch (error) {
      notifyError(error, "加载 Agentrix runner 配置失败")
      throw error
    } finally {
      setLoadingConfig(false)
    }
  }

  async function generateToken() {
    if (!canGenerateToken()) return
    setGenerating(true)
    try {
      const body = await api<RunnerGitlabTokenResult>("/api/agentrix/private-cloud/gitlab-token", {
        method: "POST",
        body: JSON.stringify({
          gitServerId,
          runnerId: cloud.id,
        }),
      })
      setCommand(body.dockerCommand || "")
      setConfig((current) => mergeTokenConfig(current, body))
      setStep("command")
      toast.success("GitLab token 已生成")
    } catch (error) {
      notifyError(error, "自动生成 GitLab token 失败")
    } finally {
      setGenerating(false)
    }
  }

  function canGenerateToken() {
    return connected && validRunnerId(cloud.id)
  }

  function stepReady(id: StepId) {
    if (id === "target") return validRunnerId(cloud.id)
    if (id === "git") return connected
    if (id === "token") return Boolean(command)
    if (id === "command") return Boolean(command)
    return false
  }

  function highestAvailableStepIndex() {
    let index = 0
    for (let current = 0; current < stepOrder.length - 1; current += 1) {
      if (!stepReady(stepOrder[current])) break
      index = current + 1
    }
    return index
  }

  function stepStatus(id: StepId, index: number) {
    if (step === id) return "当前步骤"
    if (stepReady(id)) return "已完成"
    if (index <= availableStepIndex) return "可继续"
    return "等待前置步骤"
  }

  function move(delta: number) {
    const targetIndex = Math.min(stepOrder.length - 1, Math.max(0, activeIndex + delta))
    const nextIndex = delta > 0 ? Math.min(targetIndex, availableStepIndex) : targetIndex
    setStep(stepOrder[nextIndex])
  }

  async function copyCommand() {
    if (!command) return
    await navigator.clipboard.writeText(command)
    toast.success("Docker 命令已复制")
  }

  return (
    <div className="agentrix-wizard">
      <aside className="agentrix-wizard-steps" aria-label="Agentrix Private Cloud setup steps">
        <header>
          <span className="account-provider-icon"><Cloud className="size-4" /></span>
          <span>
            <strong>Deploy runner</strong>
            <small>{cloud.name || cloud.id}</small>
          </span>
        </header>
        {stepOrder.map((id, index) => {
          const locked = index > availableStepIndex
          return (
            <button
              type="button"
              key={id}
              className={`agentrix-step ${step === id ? "active" : ""} ${stepReady(id) ? "done" : ""}`}
              disabled={locked}
              aria-current={step === id ? "step" : undefined}
              onClick={() => setStep(id)}
            >
              <span className="agentrix-step-index">{stepReady(id) ? <Check className="size-3.5" /> : index + 1}</span>
              <span>
                <strong>{stepMeta[id].title}</strong>
                <small>{stepStatus(id, index)}</small>
              </span>
            </button>
          )
        })}
      </aside>

      <section className="agentrix-wizard-panel">
        <header className="agentrix-panel-head">
          <span>
            <strong>{stepMeta[step].title}</strong>
            <small>{stepMeta[step].detail}</small>
          </span>
          <Button type="button" size="sm" variant="outline" disabled={!gitServerId || loadingConfig} onClick={() => void loadConfig()}>
            {loadingConfig ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </header>

        <div className="agentrix-panel-body">
          {step === "target" && (
            <div className="agentrix-step-body">
              <div className="agentrix-autofill">
                <span>Cloud</span>
                <strong>{cloud.name || cloud.id}</strong>
                <small>{cloud.role || "member"} · 在线机器 {cloud.onlineMachineCount ?? 0}/{cloud.machineCount ?? 0}</small>
              </div>
              <div className="agentrix-autofill">
                <span>Cloud ID</span>
                <strong>{cloud.id}</strong>
                <small>从 Agentrix private cloud 列表自动带入。</small>
              </div>
              <ValidationLine ok={validRunnerId(cloud.id)} text={validRunnerId(cloud.id) ? "Cloud ID 格式正确。" : "Cloud ID 应该以 cloud- 开头。"} />
            </div>
          )}

          {step === "git" && (
            <div className="agentrix-step-body">
              {selectableServers.length ? (
                <label className="setup-field">
                  <span>Git server</span>
                  <select value={gitServerId} onChange={(event) => { setGitServerId(event.currentTarget.value); setCommand("") }}>
                    {selectableServers.map((server) => (
                      <option key={server.id} value={server.id}>{server.name || server.baseUrl || server.id}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="agentrix-guide">
                  <strong>还没有可用 GitLab server</strong>
                  <p>需要先配置 GitLab server，用户才能为自己的账号启动 runner。</p>
                </div>
              )}
              <ValidationLine ok={connected} text={connected ? "当前账号已关联这个 Git server。" : "当前账号还没有关联这个 Git server。"} />
              {!connected && gitServerId ? (
                <Button type="button" variant="outline" onClick={() => onConnectGitServer(gitServerId)}>
                  <Server className="size-4" />
                  关联 Git server
                </Button>
              ) : null}
            </div>
          )}

          {step === "token" && (
            <div className="agentrix-step-body">
              <div className="agentrix-guide">
                <strong>自动生成 GitLab token</strong>
                <p>issue-flow 会读取已保存的 Agentrix API key 和当前 private cloud secret，再使用 Git server admin PAT 为当前 GitLab 用户创建 runner 专用 token。</p>
              </div>
              <ValidationLine ok={canGenerateToken()} text={canGenerateToken() ? tokenValidationText(existingToken) : "请先完成前面的步骤。"} />
              <Button type="button" disabled={generating || !canGenerateToken()} onClick={() => void generateToken()}>
                {generating ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                自动生成并生成命令
              </Button>
            </div>
          )}

          {step === "command" && (
            <div className="agentrix-step-body command-step">
              <div className="agentrix-guide">
                <strong>复制到 Linux 服务器执行</strong>
                <p>容器启动后会注册到 Agentrix Private Cloud，并把当前 runner 作为 GitLab proxy node 使用。</p>
              </div>
              <Textarea readOnly value={command || ""} />
              <Button type="button" disabled={!command} onClick={() => void copyCommand()}>
                <Copy className="size-4" />
                复制 Docker 命令
              </Button>
            </div>
          )}
        </div>

        <footer className="agentrix-panel-actions">
          <Button type="button" variant="outline" disabled={activeIndex === 0} onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
            上一步
          </Button>
          {step !== "token" && step !== "command" ? (
            <Button type="button" className="agentrix-primary-action" disabled={!stepReady(step)} onClick={() => move(1)}>
              下一步
              <ChevronRight className="size-4" />
            </Button>
          ) : null}
          {step === "token" && command ? (
            <Button type="button" className="agentrix-primary-action" onClick={() => setStep("command")}>
              查看命令
              <Terminal className="size-4" />
            </Button>
          ) : null}
        </footer>
      </section>
    </div>
  )
}

function ValidationLine({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={`agentrix-validation ${ok ? "ok" : ""}`}>
      {ok ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      <span>{text}</span>
    </div>
  )
}

function tokenValidationText(token?: RunnerGitlabToken) {
  if (!token) return "前置输入已通过，可以生成 token。"
  return `已存在 token ${token.tokenFingerprint || token.source || ""}，这次会创建一把新 token。`
}

function validRunnerId(value = "") {
  return /^cloud-[A-Za-z0-9_-]+$/.test(String(value || "").trim())
}

function mergeTokenConfig(current: AgentrixPrivateCloudConfig | undefined, next: RunnerGitlabTokenResult): AgentrixPrivateCloudConfig {
  const token = next.runnerGitlabToken
  const tokens = [
    token,
    ...((current?.runnerGitlabTokens || []).filter((item) => item.id !== token.id && item.runnerId !== token.runnerId)),
  ]
  return {
    ...(current || {}),
    agentrix: next.agentrix || current?.agentrix || { serverUrl: "https://agentrix.xmz.ai", webappUrl: "https://agentrix.xmz.ai" },
    llmProxy: next.llmProxy || current?.llmProxy || { baseUrl: "https://api.xmz.ai" },
    gitServer: next.gitServer || current?.gitServer,
    runnerGitlabTokens: tokens,
  }
}
