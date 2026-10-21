export const SESSION_EXPIRED_EVENT = "issue-flow:session-expired"

// 只有 Console 会话失效（login_required）才回到登录页；Git provider 凭据失效由各账号提示处理。
export function isConsoleSessionExpired(status: number, body: unknown) {
  return status === 401 && Boolean(body) && typeof body === "object" && (body as { error?: unknown }).error === "login_required"
}

export function notifyIfConsoleSessionExpired(status: number, body: unknown) {
  if (isConsoleSessionExpired(status, body)) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
}
