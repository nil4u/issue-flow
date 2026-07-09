import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft, ChevronRight, CircleAlert, Copy, Loader2, Server } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  api,
  type AgentrixCloud,
  type AgentrixPrivateCloudConfig,
  type GitServer,
  type RunnerGitlabTokenResult,
  type UserSession,
} from "@/issue-flow-model"
import { errorMessage, notifyError } from "@/lib/errors"

type StepId = "git" | "llm" | "author" | "command"
type WizardStatus = "idle" | "checking" | "ready" | "error"
type LlmValidationStatus = "idle" | "checking" | "invalid"

const BOT_PAT_ADMIN_MESSAGE = "Bot PAT 未配置或已失效，请联系管理员处理 Git server 设置。"
const LLM_PROXY_VALIDATE_TIMEOUT_MS = 4000

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
  const [llmProxyBaseUrl, setLlmProxyBaseUrl] = useState("")
  const [llmProxyApiKey, setLlmProxyApiKey] = useState("")
  const [commitAuthorName, setCommitAuthorName] = useState("")
  const [commitAuthorEmail, setCommitAuthorEmail] = useState("")
  const [generating, setGenerating] = useState(false)
  const [status, setStatus] = useState<WizardStatus>("idle")
  const [statusText, setStatusText] = useState("")
  const [llmValidation, setLlmValidation] = useState<{ status: LlmValidationStatus; message: string; key: string }>({
    status: "idle",
    message: "",
    key: "",
  })
  const connected = Boolean(gitServerId && linkedGitServerIds.has(gitServerId))
  const selectedGitServer = selectableServers.find((server) => server.id === gitServerId)

  useEffect(() => {
    if (gitServerId || !selectableServers.length) return
    setGitServerId(firstLinkedServer?.id || selectableServers[0]?.id || "")
  }, [firstLinkedServer?.id, gitServerId, selectableServers])

  useEffect(() => {
    if (!gitServerId) return
    void loadConfig(gitServerId)
  }, [gitServerId])

  async function loadConfig(nextGitServerId = gitServerId, options: { notify?: boolean } = {}) {
    try {
      const body = await api<AgentrixPrivateCloudConfig>(`/api/agentrix/private-cloud?gitServerId=${encodeURIComponent(nextGitServerId)}`)
      setConfig(body)
      hydrateLlmProxy(body)
      hydrateCommitAuthor(body)
      return body
    } catch (error) {
      if (options.notify !== false) notifyError(error, "加载 Agentrix runner 配置失败")
      throw error
    }
  }

  async function confirmGitServer() {
    if (!canConfirmGitServer()) return
    setGenerating(true)
    setStatus("checking")
    setStatusText("正在校验 Bot PAT...")
    try {
      const latestConfig = await loadConfig(gitServerId, { notify: false })
      if (!hasBotPat(latestConfig)) {
        setStatus("error")
        setStatusText(BOT_PAT_ADMIN_MESSAGE)
        return
      }
      const body = await api<{ gitServer?: GitServer; botPat?: { status?: string } }>("/api/agentrix/private-cloud/git-server/validate", {
        method: "POST",
        body: JSON.stringify({
          gitServerId,
        }),
      })
      setConfig((current) => ({
        ...(current || latestConfig),
        gitServer: body.gitServer || latestConfig.gitServer,
      }))
      setStatus("ready")
      setStatusText("")
      setStep("llm")
    } catch (error) {
      if (isBotPatError(error)) {
        setStatus("error")
        setStatusText(BOT_PAT_ADMIN_MESSAGE)
      } else {
        setStatus("error")
        setStatusText(errorMessage(error))
        notifyError(error, "校验 Git server 失败")
      }
    } finally {
      setGenerating(false)
    }
  }

  async function confirmLlmProxy() {
    if (!canConfirmLlmProxy()) return
    setGenerating(true)
    setStatus("checking")
    setStatusText(shouldContinueAfterLlmWarning() ? "" : "正在校验模型服务...")
    try {
      if (!shouldContinueAfterLlmWarning()) {
        setLlmValidation({ status: "checking", message: "", key: llmValidationKey() })
        const validation = await validateLlmProxy()
        if (!validation.valid) {
          setLlmValidation({ status: "invalid", message: validation.message, key: llmValidationKey() })
          setStatus("idle")
          setStatusText("")
          return
        }
        setLlmValidation({ status: "idle", message: "", key: "" })
      }
      setStatus("ready")
      setStatusText("")
      setStep("author")
    } catch (error) {
      setStatus("error")
      setStatusText(errorMessage(error))
      notifyError(error, "校验模型服务失败")
    } finally {
      setGenerating(false)
    }
  }

  async function generateCommand() {
    if (!canGenerateCommand()) return
    setGenerating(true)
    setStatus("checking")
    setStatusText("正在生成 Docker 命令...")
    try {
      setStatusText("正在生成 Docker 命令...")
      const body = await api<RunnerGitlabTokenResult>("/api/agentrix/private-cloud/gitlab-token", {
        method: "POST",
        body: JSON.stringify({
          gitServerId,
          runnerId: cloud.id,
          llmProxyBaseUrl: llmProxyBaseUrl.trim(),
          llmProxyApiKey: llmProxyApiKey.trim(),
          commitAuthor: {
            name: commitAuthorName.trim(),
            email: commitAuthorEmail.trim(),
          },
        }),
      })
      setCommand(body.dockerCommand || "")
      setConfig((current) => mergeTokenConfig(current, body))
      setStatus("ready")
      setStatusText("")
      setStep("command")
      toast.success("Docker 命令已生成")
    } catch (error) {
      if (isBotPatError(error)) {
        setStatus("error")
        setStatusText(BOT_PAT_ADMIN_MESSAGE)
      } else {
        setStatus("error")
        setStatusText(errorMessage(error))
        notifyError(error, "生成 Docker 命令失败")
      }
    } finally {
      setGenerating(false)
    }
  }

  async function validateLlmProxy(): Promise<{ valid: boolean; message: string }> {
    const modelsUrl = llmProxyModelsUrl(llmProxyBaseUrl)
    if (!modelsUrl) {
      return { valid: false, message: "BASE_URL 不是有效的 http(s) 地址。" }
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), LLM_PROXY_VALIDATE_TIMEOUT_MS)
    try {
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${llmProxyApiKey.trim()}`,
        },
        signal: controller.signal,
      })
      if (!response.ok) {
        return { valid: false, message: llmProxyHttpWarning(response.status) }
      }
      const body = await response.json().catch(() => undefined)
      if (!body || typeof body !== "object") {
        return { valid: false, message: "模型服务返回成功，但 /v1/models 响应不是有效 JSON。" }
      }
      return { valid: true, message: "" }
    } catch (error) {
      return { valid: false, message: llmProxyFetchWarning(error) }
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function canConfirmGitServer() {
    return connected && validRunnerId(cloud.id)
  }

  function canConfirmLlmProxy() {
    return canConfirmGitServer() && Boolean(llmProxyBaseUrl.trim() && llmProxyApiKey.trim())
  }

  function canGenerateCommand() {
    return canConfirmLlmProxy() && Boolean(commitAuthorName.trim() && commitAuthorEmail.trim())
  }

  function shouldContinueAfterLlmWarning() {
    return llmValidation.status === "invalid" && llmValidation.key === llmValidationKey()
  }

  function llmValidationKey() {
    return `${llmProxyBaseUrl.trim()}\n${llmProxyApiKey.trim()}`
  }

  function resetLlmValidation() {
    setLlmValidation({ status: "idle", message: "", key: "" })
  }

  function updateLlmProxyBaseUrl(value: string) {
    setLlmProxyBaseUrl(value)
    resetLlmValidation()
  }

  function updateLlmProxyApiKey(value: string) {
    setLlmProxyApiKey(value)
    resetLlmValidation()
  }

  function llmButtonText() {
    if (generating && statusText.includes("校验")) return "校验中"
    return shouldContinueAfterLlmWarning() ? "继续" : "下一步"
  }

  function generateButtonText() {
    if (generating) return "生成中"
    return "生成命令"
  }

  async function copyCommand() {
    if (!command) return
    await navigator.clipboard.writeText(command)
    toast.success("Docker 命令已复制")
  }

  function selectGitServer(nextGitServerId: string) {
    setGitServerId(nextGitServerId)
    setCommand("")
    setCommitAuthorName("")
    setCommitAuthorEmail("")
    goToStep("git")
  }

  function hydrateLlmProxy(body?: AgentrixPrivateCloudConfig) {
    setLlmProxyBaseUrl((current) => current || body?.llmProxy?.baseUrl || "")
    setLlmProxyApiKey((current) => current || body?.llmProxy?.apiKey || "")
  }

  function hydrateCommitAuthor(body?: AgentrixPrivateCloudConfig) {
    setCommitAuthorName((current) => current || body?.gitServer?.commitAuthor?.name || "issue-flow")
    setCommitAuthorEmail((current) => current || body?.gitServer?.commitAuthor?.email || "")
  }

  function hasBotPat(latestConfig?: AgentrixPrivateCloudConfig) {
    const configFingerprint = latestConfig ? latestConfig.gitServer?.botPatFingerprint : config?.gitServer?.botPatFingerprint
    return Boolean(selectedGitServer?.botPatFingerprint || configFingerprint)
  }

  function goToStep(nextStep: StepId) {
    setStep(nextStep)
    setStatus("idle")
    setStatusText("")
  }

  return (
    <div className="agentrix-wizard">
      <section className="agentrix-wizard-panel">
        <header className="agentrix-panel-head">
          <DialogTitle className="agentrix-panel-title">部署 runner - {stepTitle(step)}</DialogTitle>
        </header>

        <div className="agentrix-panel-body">
          {step === "git" && (
            <div className="agentrix-step-body">
              {selectableServers.length ? (
                <label className="setup-field">
                  <span>Git server</span>
                  <select value={gitServerId} onChange={(event) => selectGitServer(event.currentTarget.value)}>
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
              <ValidationLine tone={connected ? "ok" : "error"} text={connected ? "已关联" : "未关联"} />
              {!connected && gitServerId ? (
                <Button type="button" variant="outline" onClick={() => onConnectGitServer(gitServerId)}>
                  <Server className="size-4" />
                  关联
                </Button>
              ) : null}
              {status === "checking" ? (
                <ValidationLine tone="loading" text={statusText} />
              ) : status === "error" && statusText ? (
                <ValidationLine tone="error" text={statusText} />
              ) : null}
            </div>
          )}

          {step === "llm" && (
            <div className="agentrix-step-body">
              <label className="setup-field">
                <span>BASE_URL</span>
                <Input
                  value={llmProxyBaseUrl}
                  onChange={(event) => updateLlmProxyBaseUrl(event.currentTarget.value)}
                  placeholder="模型服务的 baseUrl，例如 https://api.xmz.ai"
                />
              </label>
              <label className="setup-field">
                <span>API_KEY</span>
                <Input
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className="agentrix-secret-input"
                  value={llmProxyApiKey}
                  onChange={(event) => updateLlmProxyApiKey(event.currentTarget.value)}
                  placeholder="模型服务的 API key"
                />
              </label>
              {status === "error" && statusText ? (
                <ValidationLine tone="error" text={statusText} />
              ) : status === "checking" ? (
                <ValidationLine tone="loading" text={statusText} />
              ) : shouldContinueAfterLlmWarning() ? (
                <ValidationLine tone="error" text={`${llmValidation.message} 如果确认无误，也可点击 "继续"。`} />
              ) : null}
            </div>
          )}

          {step === "author" && (
            <div className="agentrix-step-body">
              <label className="setup-field">
                <span>Commit author name</span>
                <Input
                  value={commitAuthorName}
                  onChange={(event) => setCommitAuthorName(event.currentTarget.value)}
                  placeholder="issue-flow"
                />
              </label>
              <label className="setup-field">
                <span>Commit author email</span>
                <Input
                  type="email"
                  value={commitAuthorEmail}
                  onChange={(event) => setCommitAuthorEmail(event.currentTarget.value)}
                  placeholder="issue-flow@example.com"
                />
              </label>
              {status === "error" && statusText ? (
                <ValidationLine tone="error" text={statusText} />
              ) : status === "checking" ? (
                <ValidationLine tone="loading" text={statusText} />
              ) : null}
            </div>
          )}

          {step === "command" && (
            <div className="agentrix-step-body command-step">
              <Textarea readOnly value={command || ""} />
            </div>
          )}
        </div>

        <footer className="agentrix-panel-actions">
          {step === "command" ? (
            <Button type="button" variant="outline" onClick={() => goToStep("author")}>
              <ChevronLeft className="size-4" />
              上一步
            </Button>
          ) : null}
          {step === "author" ? (
            <Button type="button" variant="outline" onClick={() => goToStep("llm")}>
              <ChevronLeft className="size-4" />
              上一步
            </Button>
          ) : null}
          {step === "llm" ? (
            <Button type="button" variant="outline" onClick={() => goToStep("git")}>
              <ChevronLeft className="size-4" />
              上一步
            </Button>
          ) : null}
          {step === "git" ? (
            <Button type="button" className="agentrix-primary-action" disabled={generating || !canConfirmGitServer()} onClick={() => void confirmGitServer()}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : null}
              {generating ? "校验中" : "下一步"}
              {!generating ? <ChevronRight className="size-4" /> : null}
            </Button>
          ) : step === "llm" ? (
            <Button type="button" className="agentrix-primary-action" disabled={generating || !canConfirmLlmProxy()} onClick={() => void confirmLlmProxy()}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : null}
              {llmButtonText()}
              {!generating ? <ChevronRight className="size-4" /> : null}
            </Button>
          ) : step === "author" ? (
            <Button type="button" className="agentrix-primary-action" disabled={generating || !canGenerateCommand()} onClick={() => void generateCommand()}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : null}
              {generateButtonText()}
              {!generating ? <ChevronRight className="size-4" /> : null}
            </Button>
          ) : (
            <Button type="button" className="agentrix-primary-action" disabled={!command} onClick={() => void copyCommand()}>
              <Copy className="size-4" />
              复制
            </Button>
          )}
        </footer>
      </section>
    </div>
  )
}

function stepTitle(step: StepId) {
  if (step === "git") return "确认 Git server"
  if (step === "llm") return "模型服务"
  if (step === "author") return "提交作者"
  return "Docker 命令"
}

function ValidationLine({ tone, text }: { tone: "ok" | "error" | "loading"; text: string }) {
  return (
    <div className={`agentrix-validation ${tone}`}>
      {tone === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : tone === "ok" ? <Check className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      <span>{text}</span>
    </div>
  )
}

function validRunnerId(value = "") {
  return /^cloud-[A-Za-z0-9_-]+$/.test(String(value || "").trim())
}

function llmProxyModelsUrl(baseUrl = "") {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "")
  if (!normalized) return ""
  const suffix = normalized.endsWith("/v1") ? "/models" : "/v1/models"
  try {
    const url = new URL(`${normalized}${suffix}`)
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : ""
  } catch {
    return ""
  }
}

function llmProxyHttpWarning(status: number) {
  if (status === 401 || status === 403) {
    return `模型服务拒绝访问，BASE_URL 或 API_KEY 可能不正确。HTTP ${status}。`
  }
  return `模型服务 /v1/models 返回 HTTP ${status}。`
}

function llmProxyFetchWarning(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "模型服务 /v1/models 校验超时。"
  }
  if (error instanceof Error && error.message) {
    return `无法访问模型服务 /v1/models：${error.message}。`
  }
  return "无法访问模型服务 /v1/models。"
}

function isBotPatError(error: unknown) {
  const code = error instanceof Error ? error.message : ""
  return [
    "runner_gitlab_bot_pat_required",
    "runner_gitlab_bot_pat_invalid",
    "runner_gitlab_bot_pat_validation_failed",
  ].includes(code)
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
