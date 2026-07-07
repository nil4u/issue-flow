import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Cloud, Server, Settings, Wrench } from "lucide-react"

import { AgentrixPrivateCloudWizard } from "@/components/agentrix-private-cloud-wizard"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  api,
  type AgentrixCloud,
  type AgentrixResources,
  type GitServer,
  type UserSession,
} from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

export function AgentrixPanel({
  gitServers,
  onConnectGitServer,
  onOpenAccount,
  userSession,
}: {
  gitServers: GitServer[]
  onConnectGitServer: (gitServerId: string) => void
  onOpenAccount: () => void
  userSession: UserSession
}) {
  const gitServerId = useAgentrixContextGitServerId(userSession, gitServers)
  const [resources, setResources] = useState<AgentrixResources>()
  const [deployCloud, setDeployCloud] = useState<AgentrixCloud>()
  const privateClouds = resources?.privateClouds || []
  const localMachines = resources?.localMachines || []

  useEffect(() => {
    if (!gitServerId) return
    void loadResources()
  }, [gitServerId])

  async function loadResources() {
    if (!gitServerId) return
    try {
      const body = await api<AgentrixResources>(`/api/user/agentrix-resources?gitServerId=${encodeURIComponent(gitServerId)}`)
      setResources(body)
    } catch (error) {
      notifyError(error, "加载 Agentrix 资源失败")
    }
  }

  if (!gitServerId) {
    return (
      <section className="settings-content agentrix-panel">
        <div className="agentrix-empty-state">
          <AlertCircle className="size-5" />
          <strong>先关联 Git 账号</strong>
          <span>Agentrix 配置按 issue-flow 用户保存，需要先关联至少一个 GitLab 账号。</span>
        </div>
      </section>
    )
  }

  if (resources && !resources.configured) {
    return (
      <section className="settings-content agentrix-panel">
        <div className="agentrix-empty-state">
          <Settings className="size-5" />
          <strong>先设置 Agentrix API key</strong>
          <span>设置并校验 API key 后，这里会展示你的 private clouds 和 local machines。</span>
          <Button type="button" onClick={onOpenAccount}>去账户设置</Button>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-content agentrix-panel">
      {resources?.error ? (
        <div className="agentrix-inline-alert">
          <AlertCircle className="size-4" />
          <span>{resources.detail || "Agentrix API key 校验失败，请到账户页更新 key。"}</span>
          <Button type="button" size="sm" variant="outline" onClick={onOpenAccount}>更新 key</Button>
        </div>
      ) : null}

      <div className="agentrix-resource-grid">
        <section className="agentrix-resource-section">
          <header>
            <span>
              <strong>Private clouds</strong>
              <small>{privateClouds.length} 个可用 cloud</small>
            </span>
          </header>
          <div className="agentrix-resource-list">
            {privateClouds.map((cloud) => (
              <div className="agentrix-resource-row" key={cloud.id}>
                <span className="account-provider-icon"><Cloud className="size-4" /></span>
                <span className="agentrix-resource-copy">
                  <strong>{cloud.name || cloud.id}</strong>
                  <small>{cloud.id} · {cloud.role || "member"} · 在线 {cloud.onlineMachineCount ?? 0}/{cloud.machineCount ?? 0}</small>
                </span>
                <Button type="button" size="sm" variant="secondary" onClick={() => setDeployCloud(cloud)}>
                  <Wrench className="size-4" />
                  部署
                </Button>
              </div>
            ))}
            {!privateClouds.length && (
              <div className="agentrix-empty-row">还没有 private cloud</div>
            )}
          </div>
        </section>

        <section className="agentrix-resource-section">
          <header>
            <span>
              <strong>Local machines</strong>
              <small>{localMachines.length} 台本地机器</small>
            </span>
          </header>
          <div className="agentrix-resource-list">
            {localMachines.map((machine) => (
              <div className="agentrix-resource-row" key={machine.id}>
                <span className="account-provider-icon"><Server className="size-4" /></span>
                <span className="agentrix-resource-copy">
                  <strong>{machine.id}</strong>
                  <small>{machine.status || "unknown"}{machine.controlPort ? ` · control:${machine.controlPort}` : ""}</small>
                </span>
                <span className={`agentrix-status-dot ${machine.status === "online" ? "online" : ""}`}>{machine.status || "unknown"}</span>
              </div>
            ))}
            {!localMachines.length && (
              <div className="agentrix-empty-row">还没有 local machine</div>
            )}
          </div>
        </section>
      </div>

      <Dialog open={Boolean(deployCloud)} onOpenChange={(open) => {
        if (!open) setDeployCloud(undefined)
      }}>
        <DialogContent className="agentrix-deploy-dialog">
          <DialogHeader>
            <DialogTitle>部署 private cloud runner</DialogTitle>
          </DialogHeader>
          {deployCloud ? (
            <AgentrixPrivateCloudWizard
              cloud={deployCloud}
              gitServers={gitServers}
              onConnectGitServer={onConnectGitServer}
              userSession={userSession}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function useAgentrixContextGitServerId(userSession: UserSession, gitServers: GitServer[]) {
  const gitlabServerIds = useMemo(() => new Set(gitServers.filter((server) => server.type === "gitlab").map((server) => server.id)), [gitServers])
  return (userSession.accounts || [])
    .map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "")
    .find((id) => gitlabServerIds.has(id)) || ""
}
