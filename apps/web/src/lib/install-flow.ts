import { api, API_BASE_URL, type InstallCheck, type InstallCheckProgress, type InstallStep } from "@/issue-flow-model"

export const installCheckProgressSteps: InstallCheckProgress["steps"] = [
  { id: "permissions", label: "Permissions", status: "pending" },
  { id: "webhook", label: "Webhook", status: "pending" },
  { id: "variables", label: "Variables", status: "pending" },
  { id: "runners", label: "GitLab Runner", status: "pending" },
  { id: "plugins", label: "Plugins", status: "pending" },
]

export const pluginInstallProgressSteps: InstallCheckProgress["steps"] = [
  { id: "clone", label: "克隆仓库", status: "pending" },
  { id: "install", label: "安装文件", status: "pending" },
  { id: "commit", label: "提交变更", status: "pending" },
  { id: "mr", label: "发起 MR", status: "pending" },
]

export function mergeInstallCheck(current: InstallCheck | undefined, next: InstallCheck): InstallCheck {
  const byId = new Map<string, InstallStep>()
  for (const step of current?.steps || []) byId.set(step.id, step)
  for (const step of next.steps || []) byId.set(step.id, step)
  const steps = Array.from(byId.values())
  return {
    ...current,
    ...next,
    steps,
    installable: steps.every((step) => step.status !== "blocked" && step.status !== "needs_input"),
  }
}

export async function streamInstallPlugin(
  input: { gitServerId: string; projectId: string },
  onEvent: (event: string, data: unknown) => void
): Promise<InstallCheck> {
  const response = await fetch(`${API_BASE_URL}/api/gitlab/install-plugin/stream`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`)
  }

  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ""
  let complete: InstallCheck | undefined

  function handleChunk(chunk: string) {
    buffer += chunk
    let boundary = buffer.indexOf("\n\n")
    while (boundary >= 0) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = raw.match(/^event:\s*(.+)$/m)?.[1] || "message"
      const dataText = raw.match(/^data:\s*(.+)$/m)?.[1] || "{}"
      const data = JSON.parse(dataText)
      if (event === "complete") complete = data as InstallCheck
      if (event === "error") {
        const error = new Error(String(data?.error || "install_plugin_failed"))
        ;(error as Error & { body?: unknown }).body = data
        throw error
      }
      onEvent(event, data)
      boundary = buffer.indexOf("\n\n")
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    handleChunk(decoder.decode(value, { stream: true }))
  }
  handleChunk(decoder.decode())
  if (!complete) throw new Error("install_plugin_stream_incomplete")
  return complete
}

export async function requestInstallPlugin(input: { gitServerId: string; projectId: string }) {
  return api<InstallCheck>("/api/gitlab/install-plugin", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function isStreamConnectionError(error: unknown) {
  if (!(error instanceof Error)) return false
  if ("body" in error) return false
  return error.name === "TypeError" || /failed to fetch|networkerror|fetch failed/i.test(error.message)
}

export function pluginInstallProgressFromEvent(
  current: InstallCheckProgress,
  operationLabel: string,
  data: unknown
): InstallCheckProgress {
  const step = data as {
    id?: string
    label?: string
    status?: InstallCheckProgress["steps"][number]["status"]
    detail?: string
    mergeRequest?: { webUrl?: string }
  }
  return {
    ...current,
    open: true,
    title: `正在${operationLabel} issue-flow`,
    detail: step.detail || current.detail,
    actionHref: step.mergeRequest?.webUrl || current.actionHref,
    actionLabel: step.mergeRequest?.webUrl ? "去合并" : current.actionLabel,
    steps: current.steps.map((item) => item.id === step.id ? {
      ...item,
      label: step.label || item.label,
      status: step.status || item.status,
    } : item),
  }
}

export function pluginInstallCompleteProgress(
  current: InstallCheckProgress,
  body: InstallCheck,
  operationLabel: string
): InstallCheckProgress {
  const pendingMergeRequest = streamPendingMergeRequest(body)
  return {
    ...current,
    open: true,
    title: pendingMergeRequest?.webUrl ? "MR 已创建" : `${operationLabel}完成`,
    detail: pendingMergeRequest?.webUrl ? "合并 MR 后，issue-flow 会刷新安装状态。" : "没有需要提交的变更。",
    actionHref: pendingMergeRequest?.webUrl || current.actionHref,
    actionLabel: pendingMergeRequest?.webUrl ? "去合并" : current.actionLabel,
    steps: current.steps.map((step) => ({
      ...step,
      status: step.status === "running" || pendingMergeRequest?.webUrl ? "passed" : step.status,
    })),
  }
}

export function streamPendingMergeRequest(body: InstallCheck) {
  const payload = body as InstallCheck & {
    pendingMergeRequest?: { webUrl?: string }
    plugin?: { pendingMergeRequest?: { webUrl?: string } }
  }
  return payload.pendingMergeRequest || payload.plugin?.pendingMergeRequest
}
