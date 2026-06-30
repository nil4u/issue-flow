import { AlertCircle, ChevronDown, GitBranch, GitMerge } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import type { GitServer } from "@/issue-flow-model"

export function LoginPage({
  gitServers,
  loadError,
  onLogin,
  onReload,
}: {
  gitServers: GitServer[]
  loadError: string
  onLogin: (gitServerId: string) => void
  onReload: () => Promise<unknown>
}) {
  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="brand-row">
          <span className="brand-mark">IF</span>
          <span>
            <strong>Issue Flow</strong>
            <small>Repo installation console</small>
          </span>
        </div>
        <div className="login-copy">
          <h1>选择 Git server 登录</h1>
          <p>登录态属于用户层。登录一个 Git server 后可以进入控制台，再按需连接其他 Git server。</p>
        </div>
        {loadError && (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertTitle>加载失败</AlertTitle>
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        )}
        <div className="login-server-list">
          {gitServers.length === 0 && (
            <div className="empty-panel compact">
              <GitBranch className="size-5" />
              <span>还没有配置 Git server。</span>
              <Button variant="secondary" onClick={() => onReload()}>重新加载</Button>
            </div>
          )}
          {gitServers.map((server) => (
            <button type="button" className="login-server" key={server.id} onClick={() => onLogin(server.id)}>
              <GitMerge className="size-4" />
              <span>
                <strong>{server.name || server.id}</strong>
                <small>{server.baseUrl || server.type}</small>
              </span>
              <ChevronDown className="size-4 rotate-270" />
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}
