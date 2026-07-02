import { toast } from "sonner"

export function notifyError(error: unknown, title = "操作失败") {
  toast.error(title, {
    description: errorMessage(error),
  })
}

export function errorMessage(error: unknown) {
  const code = error instanceof Error ? error.message : ""
  const body = error && typeof error === "object" && "body" in error
    ? (error as { body?: { detail?: unknown; message?: unknown; error?: unknown } }).body
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
  if (code === "setup_code_invalid") {
    return "Setup code 不正确。"
  }
  if (code === "setup_code_not_configured") {
    return "服务端缺少 ISSUE_FLOW_SETUP_CODE，请配置后重启。"
  }
  if (code === "setup_already_initialized") {
    return "系统已经完成初始化。"
  }
  if (code === "Not Found" && typeof body?.message === "string" && body.message.startsWith("Route ")) {
    return "接口不存在，API 服务可能还没重启到最新代码。"
  }
  return firstErrorText(body?.detail, body?.message, body?.error, code) || "请稍后重试。"
}

function firstErrorText(...values: unknown[]) {
  for (const value of values) {
    const text = errorText(value)
    if (text) return text
  }
  return ""
}

function errorText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value instanceof Error) return value.message
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join(", ")
  if (typeof value === "object") {
    const item = value as { message?: unknown; code?: unknown; error?: unknown; detail?: unknown }
    const message = firstErrorText(item.message, item.detail, item.error)
    const code = errorText(item.code)
    if (code && message) return `${code}: ${message}`
    return message || code || JSON.stringify(value)
  }
  return String(value)
}
