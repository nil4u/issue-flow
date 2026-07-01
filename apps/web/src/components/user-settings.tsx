import { Check, GitBranch, Link2, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { GitServer, UserGitAccount, UserSession } from "@/issue-flow-model"

export function UserSettings({
  userSession,
  gitServers,
  pendingGitServerId,
  onConnectGitServer,
}: {
  userSession: UserSession
  gitServers: GitServer[]
  pendingGitServerId: string
  onConnectGitServer: (gitServerId: string) => void
}) {
  const accountByServerId = new Map(
    (userSession.accounts || [])
      .filter((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId)
      .map((item) => [item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "", item.account]),
  )
  const user = userSession.user
  const displayName = userDisplayName(user)

  return (
    <div className="settings-panel">
      <header className="settings-titlebar">
        <div className="settings-tabs" role="tablist" aria-label="用户设置">
          <button type="button" className="settings-tab active">账户</button>
        </div>
      </header>

      <div className="settings-body">
        <aside className="settings-nav" aria-label="设置模块">
          <button type="button" className="settings-nav-item active">账户</button>
        </aside>

        <section className="settings-content">
          <div className="account-summary">
            <span className="account-avatar">{displayName.slice(0, 1).toUpperCase() || "U"}</span>
            <span>
              <strong>{displayName}</strong>
              <small>{userEmail(user) || "通过 Git 账号登录 issue-flow"}</small>
            </span>
          </div>

          <div className="account-group">
            <header>
              <strong>关联 Git 账号</strong>
              <span>{connectedCount(accountByServerId, gitServers)} / {gitServers.length}</span>
            </header>
            <div className="account-list">
              {gitServers.map((server) => {
                const account = accountByServerId.get(server.id)
                const connected = Boolean(account)
                const unsupported = server.type !== "gitlab"
                return (
                  <div className="account-row" key={server.id}>
                    <span className="account-provider-icon">{providerIcon(server.type)}</span>
                    <span className="account-row-copy">
                      <strong>{accountTitle(account, server)}</strong>
                      <small>{serverLabel(server, account)}</small>
                    </span>
                    <span className={`account-status ${connected ? "connected" : ""}`}>
                      {connected ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                      {connected ? "已关联" : "未关联"}
                    </span>
                    <Button
                      size="sm"
                      variant={connected ? "outline" : "default"}
                      disabled={pendingGitServerId === server.id || unsupported}
                      onClick={() => onConnectGitServer(server.id)}
                    >
                      {pendingGitServerId === server.id && <Loader2 className="size-4 animate-spin" />}
                      {connected ? "重新关联" : unsupported ? "待支持" : "关联"}
                    </Button>
                  </div>
                )
              })}
              {gitServers.length === 0 && (
                <div className="account-empty">还没有配置 Git server</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function userDisplayName(user: UserSession["user"]) {
  if (!user) return "User"
  if ("username" in user) return user.name || user.username || "User"
  return user.displayName || user.email || "User"
}

function userEmail(user: UserSession["user"]) {
  return user && "email" in user ? user.email || "" : ""
}

function connectedCount(accounts: Map<string, UserGitAccount | undefined>, gitServers: GitServer[]) {
  return gitServers.filter((server) => accounts.has(server.id)).length
}

function providerIcon(type: string) {
  if (type === "github") return <GitBranch className="size-4 rotate-270" />
  return <GitBranch className="size-4" />
}

function accountTitle(account: UserGitAccount | undefined, server: GitServer) {
  return account?.displayName || account?.username || server.name || server.id
}

function serverLabel(server: GitServer, account?: UserGitAccount) {
  const identity = account?.username ? `@${account.username}` : server.type
  return `${server.name || server.id} · ${identity}`
}
