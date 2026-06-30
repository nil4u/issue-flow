import { useEffect, useState } from "react"
import type { FormEvent, ReactNode } from "react"
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  GitMerge,
  KeyRound,
  Loader2,
  Search,
  ShieldCheck,
  Webhook,
  Wrench,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { EmptyPanelProps, GitLabProject, InstallStep, RecordRow, RepoWorkspaceProps, Repository } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

export function RepoWorkspace(props: RepoWorkspaceProps) {
  return (
    <div className="workspace-panel">
      <Tabs value={props.tab} onValueChange={(value) => props.onTab(value as RepoWorkspaceProps["tab"])} className="workspace-tabs">
        <div className="workspace-tabbar">
          <TabsList variant="line">
            <TabsTrigger value="overview"><ShieldCheck className="size-4" />Overview</TabsTrigger>
            <TabsTrigger value="settings" disabled={!props.project}><Wrench className="size-4" />Settings</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab {...props} onOpenSettings={() => props.onTab("settings")} />
        </TabsContent>
        <TabsContent value="settings">
          <InstallWizard {...props} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function OverviewTab({
  gitServer,
  user,
  project,
  repository,
  deliveries,
  runs,
  onLogin,
  onOpenSettings,
}: RepoWorkspaceProps & { onOpenSettings: () => void }) {
  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) {
    return (
      <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="应用仍保持登录，你可以连接当前 Git server 后同步仓库。">
        <Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button>
      </EmptyPanel>
    )
  }
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository || repository.install?.status === "pending_repo_change") {
    const pendingMr = repository?.install?.bootstrapMergeRequest
    return (
      <div className="install-empty">
        <div className="install-empty-icon"><Wrench className="size-7" /></div>
        <h2>{pendingMr ? "安装 MR 正在等待合并" : "当前还未安装 issue-flow，去安装"}</h2>
        <p>{pendingMr?.webUrl ? `已创建 MR !${pendingMr.iid || ""}，合并后重新同步即可完成仓库文件安装。` : "安装向导会先检查权限、变量、webhook 和仓库文件，再执行安装。"}</p>
        <Button onClick={onOpenSettings}><Wrench className="size-4" />去安装</Button>
      </div>
    )
  }
  return (
    <div className="overview-grid">
      <StatusGrid project={project} repository={repository} />
      <ActivityList deliveries={deliveries} runs={runs} />
    </div>
  )
}

function InstallWizard({
  project,
  repository,
  defaults,
  installCheck,
  checking,
  installing,
  installMessage,
  onCheck,
  onInstall,
}: RepoWorkspaceProps) {
  const [apiKey, setApiKey] = useState("")
  const [runnerId, setRunnerId] = useState(defaults?.agentrix?.runnerId || "")
  const [agent, setAgent] = useState(defaults?.automation?.agent || "codex")
  const [autoDefault, setAutoDefault] = useState(defaults?.automation?.autoDefault || "triage")
  const [reviewEnabled, setReviewEnabled] = useState(Boolean(defaults?.automation?.reviewEnabled))
  const hasSavedKey = Boolean(repository?.agentrix?.apiKeyFingerprint || defaults?.agentrix?.apiKeyFingerprint)
  const passedCount = installCheck?.steps.filter((step) => step.status === "passed").length || 0
  const totalCount = installCheck?.steps.length || 0

  useEffect(() => {
    setRunnerId(defaults?.agentrix?.runnerId || "")
    setAgent(defaults?.automation?.agent || "codex")
    setAutoDefault(defaults?.automation?.autoDefault || "triage")
    setReviewEnabled(Boolean(defaults?.automation?.reviewEnabled))
  }, [defaults?.agentrix?.runnerId, defaults?.automation?.agent, defaults?.automation?.autoDefault, defaults?.automation?.reviewEnabled])

  async function checkWithForm() {
    return onCheck({
      automation: { autoDefault, reviewEnabled, agent, runnerId, responseMode: "async" },
      agentrix: { apiKey, runnerId },
    })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await onInstall({
      automation: { autoDefault, reviewEnabled, agent, runnerId, responseMode: "async" },
      agentrix: { apiKey, runnerId },
    })
  }

  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="先从左侧选择一个 repo。" />

  return (
    <div className="wizard-layout">
      <section className="wizard-section">
        <header className="section-head">
          <h2>安装向导</h2>
          <p>先检查，遇到缺失配置就停下来填；仓库文件变更走分支、commit、push、MR。</p>
        </header>
        <form className="wizard-form" onSubmit={submit}>
          {!hasSavedKey && <Field label="Agentrix API key" value={apiKey} onChange={setApiKey} type="password" required />}
          {hasSavedKey && (
            <div className="key-summary">
              <KeyRound className="size-4" />
              <span>
                <strong>使用已保存 API key</strong>
                <small>fingerprint {repository?.agentrix?.apiKeyFingerprint || defaults?.agentrix?.apiKeyFingerprint}</small>
              </span>
              <Input value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} type="password" placeholder="覆盖 API key" />
            </div>
          )}
          <Field label="Runner ID" value={runnerId} onChange={setRunnerId} />
          <Field label="Agent" value={agent} onChange={setAgent} />
          <div className="field">
            <Label>Auto default</Label>
            <Select value={autoDefault} onValueChange={setAutoDefault}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["off", "triage", "plan", "build"].map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={reviewEnabled} onChange={(event) => setReviewEnabled(event.currentTarget.checked)} />
            <span>
              <strong>启用 PR review</strong>
              <small>写入 ISSUE_FLOW_REVIEW_ENABLED</small>
            </span>
          </label>
          <div className="wizard-actions">
            <Button type="button" variant="secondary" onClick={checkWithForm} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              运行检查
            </Button>
            <Button type="submit" disabled={installing || (!hasSavedKey && !apiKey)}>
              {installing ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
              创建安装 MR
            </Button>
          </div>
          {installMessage && <p className="wizard-message">{installMessage}</p>}
        </form>
      </section>

      <section className="wizard-section">
        <header className="section-head">
          <h2>检查流程</h2>
          <p>{totalCount ? `${passedCount}/${totalCount} 通过` : "等待首次检查"}</p>
        </header>
        <StepList steps={installCheck?.steps || []} />
      </section>
    </div>
  )
}

function StatusGrid({ project, repository }: { project: GitLabProject; repository: Repository }) {
  return (
    <div className="status-grid">
      <StatusCard icon={<CheckCircle2 className="size-4" />} label="Install" value={repository.install?.status || "installed"} />
      <StatusCard icon={<ShieldCheck className="size-4" />} label="Permission" value={project.canInstall ? "maintainer" : "limited"} />
      <StatusCard icon={<GitBranch className="size-4" />} label="Default branch" value={project.defaultBranch || repository.defaultBranch || "-"} />
      <StatusCard icon={<KeyRound className="size-4" />} label="Agentrix key" value={repository.agentrix?.apiKeyFingerprint ? `fingerprint ${repository.agentrix.apiKeyFingerprint}` : "missing"} />
      <StatusCard icon={<Webhook className="size-4" />} label="Webhook" value={repository.webhook?.secretFingerprint ? "configured" : "missing"} />
    </div>
  )
}

function StatusCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="status-card"><span>{icon}{label}</span><strong>{value}</strong></div>
}

function StepList({ steps }: { steps: InstallStep[] }) {
  if (steps.length === 0) return <div className="empty-panel compact">点击“运行检查”开始。</div>
  return (
    <div className="step-list">
      {steps.map((step) => (
        <div className={`step-row ${step.status}`} key={step.id}>
          {step.status === "passed" ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
          <span>
            <strong>{step.label}</strong>
            <small>{step.detail || step.kind}</small>
            {step.files?.length ? <code>{step.files.join(", ")}</code> : null}
          </span>
          <Badge variant="secondary">{step.kind}</Badge>
        </div>
      ))}
    </div>
  )
}

function ActivityList({ deliveries, runs }: { deliveries: RecordRow[]; runs: RecordRow[] }) {
  const rows = [
    ...deliveries.slice(0, 6).map((row) => ({ ...row, kind: "delivery" })),
    ...runs.slice(0, 6).map((row) => ({ ...row, kind: "run" })),
  ].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
  return (
    <section className="activity-section">
      <header className="section-head">
        <h2>最近活动</h2>
        <p>Webhook delivery 与 dispatch run</p>
      </header>
      <div className="activity-list">
        {rows.length === 0 && <div className="empty-panel compact">暂无活动</div>}
        {rows.map((row) => {
          const payload = row.payloadSummary || {}
          const result = row.resultSummary || {}
          const title = [row.event || result.providerEventName || payload.eventName || payload.objectKind || row.kind, payload.action].filter(Boolean).join(" / ")
          const subject = payload.mergeRequestIid ? `MR !${payload.mergeRequestIid}` : payload.issueIid ? `Issue #${payload.issueIid}` : "-"
          return (
            <div className="activity-row" key={`${row.kind}-${row.id}`}>
              <Badge>{row.status || "-"}</Badge>
              <span>
                <strong>{title || "-"}</strong>
                <small>{subject} · {formatWhen(row.updatedAt || row.createdAt || "")}</small>
              </span>
              <small>{result.reason || row.error?.message || row.routeAction || row.consumer || ""}</small>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function EmptyPanel({ icon, title, detail, children }: EmptyPanelProps) {
  return (
    <div className="empty-panel">
      {icon}
      <strong>{title}</strong>
      <span>{detail}</span>
      {children}
    </div>
  )
}

function Field({ label, value, onChange, type, required }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  const id = label.toLowerCase().replace(/\s+/g, "-")
  return (
    <div className="field">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} type={type} required={required} onChange={(event) => onChange(event.currentTarget.value)} />
    </div>
  )
}
