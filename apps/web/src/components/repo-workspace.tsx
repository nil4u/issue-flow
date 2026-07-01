import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  GitBranch,
  GitMerge,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Webhook,
  Wrench,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { gitlabInstallCheckConfig } from "@/install-check-config"
import type { EmptyPanelProps, GitEventRow, GitLabProject, InstallStep, IssueRow, RepoWorkspaceProps, Repository } from "@/issue-flow-model"
import type { InstallCheckConfigItem } from "@/install-check-config"
import { formatWhen } from "@/issue-flow-model"

export function RepoWorkspace(props: RepoWorkspaceProps) {
  return (
    <div className="workspace-panel">
      <Tabs value={props.tab} onValueChange={(value) => props.onTab(value as RepoWorkspaceProps["tab"])} className="workspace-tabs">
        <div className="workspace-tabbar">
          <TabsList variant="line">
            <TabsTrigger value="overview"><ShieldCheck className="size-4" />Overview</TabsTrigger>
            <TabsTrigger value="issues" disabled={!props.project}><CircleDot className="size-4" />Issues</TabsTrigger>
            <TabsTrigger value="settings" disabled={!props.project}><Wrench className="size-4" />Settings</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewTab {...props} onOpenSettings={() => props.onTab("settings")} />
        </TabsContent>
        <TabsContent value="issues">
          <IssuesBoard {...props} />
        </TabsContent>
        <TabsContent value="settings">
          <InstallConsole {...props} />
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
  gitEvents,
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
  if (!repository || !repository.webhook?.hookId) {
    return (
      <div className="install-empty">
        <div className="install-empty-icon"><Wrench className="size-7" /></div>
        <h2>当前还未安装 issue-flow，去安装</h2>
        <p>安装向导会先检查权限、变量、webhook 和仓库文件，再执行安装。</p>
        <Button onClick={onOpenSettings}><Wrench className="size-4" />去安装</Button>
      </div>
    )
  }
  return (
    <div className="overview-grid">
      <StatusGrid project={project} repository={repository} />
      <ActivityList gitEvents={gitEvents} />
    </div>
  )
}

const issueLanes = [
  { id: "untriaged", title: "No flow", detail: "无 flow:: 标签" },
  { id: "triage", title: "Triage", detail: "flow::triage" },
  { id: "plan", title: "Plan", detail: "flow::plan" },
  { id: "build", title: "Build", detail: "flow::build" },
  { id: "clarify", title: "Clarify", detail: "flow::clarify" },
  { id: "approve", title: "Approve", detail: "flow::approve" },
]

function issueLaneId(issue: IssueRow) {
  const status = String(issue.status || "").toLowerCase()
  const flow = String(issue.currentFlow || "").toLowerCase()
  return issueLanes.some((lane) => lane.id === flow) ? flow : "untriaged"
}

function IssuesBoard({
  gitServer,
  user,
  project,
  repository,
  issues,
  loadingIssues,
  onLogin,
  onSyncIssues,
}: RepoWorkspaceProps) {
  const openIssues = useMemo(() => {
    return (issues || []).filter((issue) => {
      return String(issue.state || "").toLowerCase() === "opened"
    })
  }, [issues])
  const grouped = useMemo(() => {
    const map = new Map(issueLanes.map((lane) => [lane.id, [] as IssueRow[]]))
    for (const issue of openIssues) {
      const lane = issueLaneId(issue)
      map.get(lane)?.push(issue)
    }
    for (const rows of map.values()) {
      rows.sort((a, b) => Number(b.updatedAt ? new Date(b.updatedAt).getTime() : 0) - Number(a.updatedAt ? new Date(a.updatedAt).getTime() : 0))
    }
    return map
  }, [openIssues])

  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) {
    return (
      <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后查看 issue 看板。">
        <Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button>
      </EmptyPanel>
    )
  }
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<CircleDot className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再查看 issue 看板。" />

  return (
    <div className="issue-board">
      <header className="issue-board-toolbar">
        <span aria-hidden="true" />
        <Button type="button" variant="secondary" onClick={() => void onSyncIssues()} disabled={loadingIssues}>
          {loadingIssues ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          同步
        </Button>
      </header>
      <div className="issue-board-lanes">
        {issueLanes.map((lane) => (
          <IssueLane
            key={lane.id}
            title={lane.title}
            detail={lane.detail}
            issues={grouped.get(lane.id) || []}
          />
        ))}
      </div>
    </div>
  )
}

function IssueLane({ title, detail, issues }: { title: string; detail: string; issues: IssueRow[] }) {
  return (
    <section className="issue-lane">
      <header>
        <span>
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        <b>{issues.length}</b>
      </header>
      <div className="issue-lane-list">
        {issues.length === 0 && <div className="issue-lane-empty">暂无 issue</div>}
        {issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}
      </div>
    </section>
  )
}

function IssueCard({ issue }: { issue: IssueRow }) {
  const meta = [
    issue.type ? `type::${issue.type}` : "",
    issue.priority ? `priority::${issue.priority}` : "",
    issue.size ? `size::${issue.size}` : "",
  ].filter(Boolean)
  return (
    <article className="issue-card">
      <header>
        <strong>#{issue.issueNumber}</strong>
        <small>{formatWhen(issue.updatedAt || issue.openedAt || "")}</small>
      </header>
      <p>{issue.title || "-"}</p>
      {meta.length > 0 && (
        <div className="issue-card-labels">
          {meta.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </article>
  )
}

function InstallConsole({
  project,
  repository,
  defaults,
  installCheck,
  checking,
  projectAccess,
  loadingProjectAccess,
  onCheck,
  onSetVariable,
  onSetWebhook,
}: RepoWorkspaceProps) {
  const [installForm, setInstallForm] = useState(() => installFormFromDefaults(defaults))
  const [actionRowId, setActionRowId] = useState("")
  const [editingRow, setEditingRow] = useState<CheckRow>()
  const [editingValue, setEditingValue] = useState("")
  const installInput = useMemo(() => installForm, [installForm])
  const groups = useMemo(() => buildInstallGroups({
    installCheck,
    repository,
  }), [installCheck, repository])
  const canManage = Boolean(projectAccess?.canManage)
  const accessKnown = projectAccess?.accessLevelKnown === true
  const readOnly = !canManage
  const roleText = loadingProjectAccess
    || !projectAccess
    ? "正在读取权限..."
    : canManage
      ? `当前角色 ${projectAccess?.role || "Maintainer"}`
      : accessKnown
        ? `当前角色 ${projectAccess?.role || "No access"}，仅可查看`
        : "权限未知"

  useEffect(() => {
    setInstallForm(installFormFromDefaults(defaults))
  }, [defaults?.agentrix?.runnerId, defaults?.automation?.agent, defaults?.automation?.autoDefault, defaults?.automation?.reviewEnabled])

  async function checkRows() {
    if (!canManage) return
    setActionRowId("all")
    try {
      await onCheck()
    } finally {
      setActionRowId("")
    }
  }

  function openVariableDialog(row: CheckRow) {
    if (!row.variable || !canManage) return
    setEditingRow(row)
    setEditingValue(variableDialogValue(row, installForm))
  }

  async function saveVariable() {
    const row = editingRow
    const variable = row?.variable
    if (!row || !variable?.key || !canManage) return
    await onSetVariable(variable.key, {
      ...installInput,
      value: editingValue,
      scope: variable.scope || variable.environmentScope || "*",
    })
    if (variable.control) {
      setInstallForm((current) => updateFormValue(current, variable.control?.path || "", editingValue))
    }
    setEditingRow(undefined)
    setEditingValue("")
  }

  async function saveWebhook(row: CheckRow) {
    if (row.configItem?.type !== "webhook" || !canManage) return
    setActionRowId(row.id)
    try {
      await onSetWebhook(installInput)
    } finally {
      setActionRowId("")
    }
  }

  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="先从左侧选择一个 repo。" />

  return (
    <div className="install-console">
      <header className="install-console-toolbar">
        <div className="install-console-role">
          {roleText}
        </div>
        {canManage && (
          <div className="install-console-actions">
            <Button type="button" variant="secondary" onClick={() => checkRows()} disabled={checking || loadingProjectAccess}>
              {actionRowId === "all" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              检查全部
            </Button>
          </div>
        )}
      </header>
      <div className="check-table">
        {groups.map((group) => (
          <section className="check-group" key={group.title}>
            <header>
              <strong>{group.title}</strong>
              <span>{group.rows.filter((row) => row.status === "passed").length}/{group.rows.length}</span>
            </header>
            {group.rows.map((row) => (
              <CheckTableRow
                checking={checking && actionRowId === row.id}
                key={row.id}
                row={row}
                onSetVariable={() => openVariableDialog(row)}
                onSaveWebhook={() => saveWebhook(row)}
                readOnly={readOnly}
              />
            ))}
          </section>
        ))}
      </div>
      <VariableSettingsDialog
        row={editingRow}
        value={editingValue}
        saving={checking}
        onOpenChange={(open) => {
          if (open) return
          setEditingRow(undefined)
          setEditingValue("")
        }}
        onValueChange={setEditingValue}
        onSave={saveVariable}
      />
    </div>
  )
}

type CheckStatus = InstallStep["status"]
type CheckKind = InstallStep["kind"] | "local"

type CheckRow = {
  id: string
  title: string
  description: string
  kind: CheckKind
  status: CheckStatus
  detail?: string
  files?: string[]
  missing?: string[]
  inputRequired?: string[]
  variable?: NonNullable<InstallStep["variables"]>[number]
  value?: string
  configItem?: InstallCheckConfigItem
  actionCount?: number
}

type CheckGroup = {
  title: string
  rows: CheckRow[]
}

type InstallForm = {
  automation: {
    autoDefault: string
    reviewEnabled: boolean
    agent: string
    runnerId: string
    responseMode: string
  }
  agentrix: {
    apiKey: string
    baseUrl: string
    runnerId: string
  }
}

function buildInstallGroups({
  installCheck,
  repository,
}: {
  installCheck?: RepoWorkspaceProps["installCheck"]
  repository?: Repository
}): CheckGroup[] {
  const byId = new Map((installCheck?.steps || []).map((step) => [step.id, step]))
  if (!byId.has("webhook")) {
    const hookId = String(repository?.settings?.webhook?.hookId || repository?.webhook?.hookId || "")
    if (hookId) {
      byId.set("webhook", {
        id: "webhook",
        kind: "api",
        label: "GitLab webhook",
        status: "passed",
        detail: "Webhook 已配置",
      })
    }
  }
  const variables = byId.get("variables")?.variables || repository?.settings?.variables?.items || []
  const variableByKey = new Map(variables.map((variable) => [variable.key, variable]))
  const row = (item: InstallCheckConfigItem): CheckRow => {
    if (item.type === "variable") {
      const checkedVariable = variableByKey.get(item.name)
      const cached = Boolean(checkedVariable)
      const exists = checkedVariable?.exists ?? cached
      const status = checkedVariable?.status || (cached ? "passed" : "unknown")
      const variable = {
        key: item.name,
        label: item.name,
        description: item.description,
        ...(checkedVariable || {}),
        exists,
        status: status as CheckStatus,
        control: checkedVariable?.control || item.control,
      }
      return {
        id: item.id,
        title: variable.label || item.name,
        description: item.description,
        kind: "api",
        status: variable.status || "unknown",
        detail: variableDetail(variable, item.description),
        variable,
        configItem: item,
      }
    }
    const step = byId.get(item.id)
    const cachedWebhook = item.type === "webhook" ? repository?.settings?.webhook : undefined
    const cachedWebhookUrl = String(cachedWebhook?.url || "")
    const cachedWebhookHookId = String(cachedWebhook?.hookId || "")
    const fallbackStatus = item.type === "webhook"
      ? cachedWebhookHookId ? "passed" : "needs_action"
      : "unknown"
    return {
      id: item.id,
      title: item.name,
      description: item.description || "",
      kind: item.type === "permission" ? "auth" : item.type === "repo_file" ? "repo" : "api",
      status: step?.status || fallbackStatus,
      detail: step?.detail || (item.type === "webhook" && cachedWebhookHookId ? cachedWebhookUrl : item.type === "webhook" ? "未配置" : undefined),
      value: item.type === "webhook" && cachedWebhookHookId ? cachedWebhookUrl : undefined,
      files: step?.files,
      missing: step?.missing,
      inputRequired: step?.inputRequired,
      configItem: item,
      actionCount: step?.actionCount,
    }
  }
  return gitlabInstallCheckConfig.groups.map((group) => ({
    title: group.title,
    rows: group.items.map(row),
  }))
}

function variableDetail(variable: NonNullable<CheckRow["variable"]>, fallback: string) {
  if (variable.exists) {
    return variable.value || fallback
  }
  return variable.detail || fallback
}

function installFormFromDefaults(defaults?: RepoWorkspaceProps["defaults"]): InstallForm {
  return {
    automation: {
      autoDefault: defaults?.automation?.autoDefault || String(variableDefaultValue("ISSUE_FLOW_AUTO_DEFAULT", "triage")),
      reviewEnabled: defaults?.automation?.reviewEnabled ?? Boolean(variableDefaultValue("ISSUE_FLOW_REVIEW_ENABLED", false)),
      agent: defaults?.automation?.agent || String(variableDefaultValue("AGENTRIX_ISSUE_FLOW_AGENT", "codex")),
      runnerId: defaults?.automation?.runnerId || defaults?.agentrix?.runnerId || "",
      responseMode: "async",
    },
    agentrix: {
      apiKey: "",
      baseUrl: String(variableDefaultValue("AGENTRIX_BASE_URL", "")),
      runnerId: defaults?.agentrix?.runnerId || defaults?.automation?.runnerId || "",
    },
  }
}

function variableDefaultValue(name: string, fallback: string | boolean) {
  const items: InstallCheckConfigItem[] = gitlabInstallCheckConfig.groups.flatMap((group) => [...group.items])
  return items.find((item) => item.type === "variable" && item.name === name)?.defaultValue ?? fallback
}

function formValue(form: InstallForm, path = "") {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined
    return (current as Record<string, unknown>)[segment]
  }, form)
}

function updateFormValue(form: InstallForm, path: string, value: string | boolean): InstallForm {
  const [section, key] = path.split(".")
  if (section !== "automation" && section !== "agentrix") return form
  return {
    ...form,
    [section]: {
      ...form[section],
      [key]: value,
    },
  }
}

function variableDialogValue(row: CheckRow, form: InstallForm) {
  const currentValue = row.variable && !row.variable.masked && !row.variable.hidden
    ? String(row.variable.value || "")
    : ""
  if (currentValue && currentValue !== "*****") return currentValue
  if (row.configItem?.defaultValue !== undefined) return String(row.configItem.defaultValue)
  const control = row.variable?.control
  const formFallback = control ? formValue(form, control.path) : undefined
  return formFallback === undefined ? "" : String(formFallback)
}

function variablePlaceholder(row?: CheckRow) {
  if (!row) return ""
  return row.variable?.control?.placeholder || "填写变量值"
}

function CheckTableRow({
  checking,
  readOnly,
  row,
  onSetVariable,
  onSaveWebhook,
}: {
  checking: boolean
  readOnly: boolean
  row: CheckRow
  onSetVariable: () => void
  onSaveWebhook: () => Promise<void>
}) {
  const canSetVariable = Boolean(row.variable) && !readOnly
  const canSetWebhook = row.configItem?.type === "webhook" && !readOnly
  const statusIcon = row.status === "passed"
    ? <CheckCircle2 className="size-4" />
    : row.status === "unknown"
      ? <CircleDot className="size-4" />
      : <AlertCircle className="size-4" />
  return (
    <div className={`check-table-row ${row.status}`}>
      <div className="check-row-main">
        <span className="check-status-icon">{statusIcon}</span>
        <span className="check-row-copy">
          <strong>{row.title}</strong>
          <small>{row.variable ? row.description : row.detail || row.description}</small>
        </span>
        {row.variable && <VariableValue variable={row.variable} />}
        {!row.variable && row.value && <RowValue value={row.value} />}
        <div className="check-row-actions">
          {canSetVariable && (
            <Button type="button" size="sm" variant="secondary" onClick={onSetVariable}>设置</Button>
          )}
          {canSetWebhook && (
            <Button type="button" size="sm" variant="secondary" onClick={onSaveWebhook} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
              自动配置
            </Button>
          )}
        </div>
      </div>
      {(row.files?.length || row.missing?.length) ? <CheckRowMeta row={row} /> : null}
    </div>
  )
}

function VariableSettingsDialog({
  onOpenChange,
  onSave,
  onValueChange,
  row,
  saving,
  value,
}: {
  onOpenChange: (open: boolean) => void
  onSave: () => Promise<void>
  onValueChange: (value: string) => void
  row?: CheckRow
  saving: boolean
  value: string
}) {
  return (
    <Dialog open={Boolean(row)} onOpenChange={onOpenChange}>
      <DialogContent className="variable-dialog">
        <DialogHeader>
          <DialogTitle>{row?.variable?.key || row?.title || "设置变量"}</DialogTitle>
        </DialogHeader>
        <div className="variable-dialog-body">
          <Textarea
            autoFocus
            aria-label={row?.variable?.key || row?.title || "变量值"}
            className="variable-dialog-input"
            id="variable-value"
            placeholder={variablePlaceholder(row)}
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                void onSave()
              }
            }}
          />
        </div>
        <div className="variable-dialog-actions">
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function VariableValue({ variable }: { variable: NonNullable<CheckRow["variable"]> }) {
  const scope = variable.scope || variable.environmentScope || ""
  const source = variable.source ? `${variable.source}${scope ? `:${scope}` : ""}` : scope
  const value = variable.exists
    ? variable.masked || variable.hidden
      ? "*****"
      : String(variable.value || "-")
    : "未设置"
  return (
    <span className={`check-row-value ${variable.exists ? "" : "muted"}`}>
      <strong>{value}</strong>
      {source && <small>{source}</small>}
    </span>
  )
}

function RowValue({ value }: { value: string }) {
  return (
    <span className="check-row-value">
      <strong>{value}</strong>
    </span>
  )
}

function CheckRowMeta({ row }: { row: CheckRow }) {
  if (row.files?.length) {
    return (
      <details className="check-row-meta">
        <summary>{row.actionCount || row.files.length} 个仓库文件变更</summary>
        <code>{row.files.join("\n")}</code>
      </details>
    )
  }
  if (row.missing?.length) {
    return <div className="check-row-meta chips">{row.missing.map((item) => <code key={item}>{item}</code>)}</div>
  }
  return null
}

function StatusGrid({ project, repository }: { project: GitLabProject; repository: Repository }) {
  return (
    <div className="status-grid">
      <StatusCard icon={<ShieldCheck className="size-4" />} label="Permission" value={project.canInstall === true ? "maintainer" : project.canInstall === false ? "limited" : "unknown"} />
      <StatusCard icon={<GitBranch className="size-4" />} label="Default branch" value={project.defaultBranch || repository.defaultBranch || "-"} />
      <StatusCard icon={<KeyRound className="size-4" />} label="Agentrix key" value={repository.agentrix?.apiKeyFingerprint ? `fingerprint ${repository.agentrix.apiKeyFingerprint}` : "missing"} />
      <StatusCard icon={<Webhook className="size-4" />} label="Webhook" value={repository.webhook?.secretFingerprint ? "configured" : "missing"} />
    </div>
  )
}

function StatusCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="status-card"><span>{icon}{label}</span><strong>{value}</strong></div>
}

function ActivityList({ gitEvents }: { gitEvents: GitEventRow[] }) {
  const rows = gitEvents
    .slice(0, 12)
    .map((row) => ({ ...row, kind: "git_event" }))
  return (
    <section className="activity-section">
      <header className="section-head">
        <h2>最近活动</h2>
        <p>Webhook delivery</p>
      </header>
      <div className="activity-list">
        {rows.length === 0 && <div className="empty-panel compact">暂无活动</div>}
        {rows.map((row) => {
          const title = [row.eventName || row.kind, row.action].filter(Boolean).join(" / ")
          const subject = row.objectType && row.objectId ? `${row.objectType} ${row.objectId}` : row.repositoryFullName || "-"
          return (
            <div className="activity-row" key={`${row.kind}-${row.id}`}>
              <Badge>{row.eventName || "-"}</Badge>
              <span>
                <strong>{title || "-"}</strong>
                <small>{subject} · {formatWhen(row.receivedAt || row.createdAt || "")}</small>
              </span>
              <small>{row.deliveryId || ""}</small>
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
