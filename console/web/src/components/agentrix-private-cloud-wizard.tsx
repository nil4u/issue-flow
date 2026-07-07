import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy, KeyRound, Loader2, Server, Terminal } from "lucide-react"
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

type StepId = "git" | "token" | "command"

const stepOrder: StepId[] = ["git", "token", "command"]

const stepMeta: Record<StepId, { title: string; detail: string }> = {
  git: {
    title: "Git server",
    detail: "确认 runner 连接的 GitLab server。",
  },
  token: {
    title: "Bot PAT",
    detail: "使用管理员配置的 Bot PAT。",
  },
  command: {
    title: "Docker 命令",
    detail: "复制后在服务器执行。",
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
  const [step, setStep] = useState<StepId>("git")
  const [config, setConfig] = useState<AgentrixPrivateCloudConfig>()
  const [command, setCommand] = useState("")
  const [generating, setGenerating] = useState(false)
  const connected = Boolean(gitServerId && linkedGitServerIds.has(gitServerId))
  const selectedGitServer = selectableServers.find((server) => server.id === gitServerId)
  const botPatConfigured = Boolean(selectedGitServer?.botPatFingerprint || config?.gitServer?.botPatFingerprint)
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
    try {
      const body = await api<AgentrixPrivateCloudConfig>(`/api/agentrix/private-cloud?gitServerId=${encodeURIComponent(nextGitServerId)}`)
      setConfig(body)
      return body
    } catch (error) {
      notifyError(error, "加载 Agentrix runner 配置失败")
      throw error
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
      toast.success("Docker 命令已生成")
    } catch (error) {
      notifyError(error, "生成 Docker 命令失败")
    } finally {
      setGenerating(false)
    }
  }

  function canGenerateToken() {
    return connected && botPatConfigured && validRunnerId(cloud.id)
  }

  function stepReady(id: StepId) {
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
        </header>

        <div className="agentrix-panel-body">
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
                  <p>需要先配置 GitLab server。</p>
                </div>
              )}
              <ValidationLine ok={connected} text={connected ? "已关联" : "未关联"} />
              {!connected && gitServerId ? (
                <Button type="button" variant="outline" onClick={() => onConnectGitServer(gitServerId)}>
                  <Server className="size-4" />
                  关联
                </Button>
              ) : null}
            </div>
          )}

          {step === "token" && (
            <div className="agentrix-step-body">
              <ValidationLine ok={canGenerateToken()} text={tokenValidationText({ connected, botPatConfigured, token: existingToken })} />
              <Button type="button" disabled={generating || !canGenerateToken()} onClick={() => void generateToken()}>
                {generating ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
                生成命令
              </Button>
            </div>
          )}

          {step === "command" && (
            <div className="agentrix-step-body command-step">
              <Textarea readOnly value={command || ""} />
              <Button type="button" disabled={!command} onClick={() => void copyCommand()}>
                <Copy className="size-4" />
                复制
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

function tokenValidationText({
  connected,
  botPatConfigured,
  token,
}: {
  connected: boolean
  botPatConfigured: boolean
  token?: RunnerGitlabToken
}) {
  if (!connected) return "请先完成前面的步骤。"
  if (!botPatConfigured) return "Git server 未配置 Bot PAT"
  if (!token) return "已配置"
  return "已配置，可重新生成命令"
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
