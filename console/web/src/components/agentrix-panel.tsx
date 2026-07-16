import { useEffect, useMemo, useState } from "react"
import { AlertCircle, ChevronDown, Cloud, Loader2, Server, Settings, Wrench } from "lucide-react"

import { AgentrixPrivateCloudWizard } from "@/components/agentrix-private-cloud-wizard"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import {
  api,
  type AgentrixCloud,
  type AgentrixCloudMachine,
  type AgentrixLocalMachine,
  type AgentrixResources,
  type GitServer,
  type UserSession,
} from "@/issue-flow-model"
import { machineCliVersion } from "@/lib/agentrix-machines"
import { notifyError } from "@/lib/errors"

type CloudMachineState = {
  loading?: boolean
  loaded?: boolean
  error?: boolean
  machines: AgentrixCloudMachine[]
}

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
  const [expandedCloudId, setExpandedCloudId] = useState("")
  const [cloudMachines, setCloudMachines] = useState<Record<string, CloudMachineState>>({})
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

  async function toggleCloud(cloudId: string) {
    if (expandedCloudId === cloudId) {
      setExpandedCloudId("")
      return
    }
    setExpandedCloudId(cloudId)
    if (cloudMachines[cloudId]?.loaded || cloudMachines[cloudId]?.loading) return

    await loadCloudMachines(cloudId)
  }

  async function loadCloudMachines(cloudId: string) {
    setCloudMachines((current) => ({ ...current, [cloudId]: { machines: [], loading: true } }))
    try {
      const body = await api<{ machines: AgentrixCloudMachine[] }>(`/api/user/agentrix-resources/clouds/${encodeURIComponent(cloudId)}/machines`)
      setCloudMachines((current) => ({
        ...current,
        [cloudId]: { machines: body.machines || [], loaded: true },
      }))
    } catch (error) {
      setCloudMachines((current) => ({ ...current, [cloudId]: { machines: [], error: true } }))
      notifyError(error, "加载 Cloud machines 失败")
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
            {privateClouds.map((cloud) => {
              const expanded = expandedCloudId === cloud.id
              const machineState = cloudMachines[cloud.id]
              return (
                <div className={`agentrix-cloud-group ${expanded ? "expanded" : ""}`} key={cloud.id}>
                  <div className="agentrix-resource-row agentrix-cloud-row">
                    <button type="button" className="agentrix-cloud-trigger" aria-expanded={expanded} onClick={() => toggleCloud(cloud.id)}>
                      <span className="account-provider-icon"><Cloud className="size-4" /></span>
                      <span className="agentrix-resource-copy">
                        <strong>{cloud.name || cloud.id}</strong>
                        <small>{cloud.id} · {cloud.role || "member"} · 在线 {cloud.onlineMachineCount ?? 0}/{cloud.machineCount ?? 0}</small>
                      </span>
                      <ChevronDown className={`size-4 agentrix-cloud-chevron ${expanded ? "expanded" : ""}`} />
                    </button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setDeployCloud(cloud)}>
                      <Wrench className="size-4" />
                      部署
                    </Button>
                  </div>
                  {expanded && (
                    <div className="agentrix-cloud-machines">
                      {machineState?.loading ? (
                        <div className="agentrix-empty-row"><Loader2 className="size-4 animate-spin" />正在加载 machines</div>
                      ) : machineState?.error ? (
                        <button type="button" className="agentrix-empty-row agentrix-retry-row" onClick={() => loadCloudMachines(cloud.id)}>加载失败，点击重试</button>
                      ) : machineState?.machines.length ? (
                        machineState.machines.map((machine) => <MachineRow key={machine.id} machine={machine} />)
                      ) : (
                        <div className="agentrix-empty-row">这个 cloud 还没有 machine</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
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
              <MachineRow key={machine.id} machine={machine} local />
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

function MachineRow({ machine, local = false }: { machine: AgentrixCloudMachine | AgentrixLocalMachine; local?: boolean }) {
  const version = machineCliVersion(machine)
  const deviceId = "deviceId" in machine ? machine.deviceId : undefined
  const controlPort = "controlPort" in machine ? machine.controlPort : undefined
  return (
    <div className={`agentrix-resource-row agentrix-machine-row ${local ? "" : "cloud"}`}>
      <span className="account-provider-icon"><Server className="size-4" /></span>
      <span className="agentrix-resource-copy">
        <strong>{deviceId || machine.id}</strong>
        <small>CLI {version ? `v${version.replace(/^v/, "")}` : "unknown"}{controlPort ? ` · control:${controlPort}` : ""}</small>
      </span>
      <span className={`agentrix-status-dot ${machine.status === "online" ? "online" : ""}`}>{machine.status || "unknown"}</span>
    </div>
  )
}

function useAgentrixContextGitServerId(userSession: UserSession, gitServers: GitServer[]) {
  const gitlabServerIds = useMemo(() => new Set(gitServers.filter((server) => server.type === "gitlab").map((server) => server.id)), [gitServers])
  return (userSession.accounts || [])
    .map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || "")
    .find((id) => gitlabServerIds.has(id)) || ""
}
