import { ArrowRight, GitBranch } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { GitServer } from "@/issue-flow-model"

export function LoginPage({
  gitServers,
  onLogin,
  onReload,
}: {
  gitServers: GitServer[]
  onLogin: (gitServerId: string) => void
  onReload: () => Promise<unknown>
}) {
  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="login-brand">
          <span className="brand-mark">IF</span>
          <strong>Issue Flow</strong>
          <small>Sign in to continue</small>
        </div>
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
              <GitBranch className="size-4" />
              <span>{server.name || server.id}</span>
              <ArrowRight className="size-4" />
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}
