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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { gitlabInstallCheckConfig } from "@/install-check-config"
import type { EmptyPanelProps, GitLabProject, InstallStep, RecordRow, RepoWorkspaceProps, Repository } from "@/issue-flow-model"
import type { InstallCheckConfigItem } from "@/install-check-config"
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
      <ActivityList deliveries={deliveries} runs={runs} />
    </div>
  )
}

function InstallConsole({
  project,
  repository,
  defaults,
  installCheck,
  checking,
  installing,
  installMessage,
  projectAccess,
  loadingProjectAccess,
  onCheck,
  onSetVariable,
  onInstall,
}: RepoWorkspaceProps) {
  const [installForm, setInstallForm] = useState(() => installFormFromDefaults(defaults))
  const [expandedRowId, setExpandedRowId] = useState("")
  const [checkingRowId, setCheckingRowId] = useState("")
  const installInput = useMemo(() => installForm, [installForm])
  const groups = useMemo(() => buildInstallGroups({
    installCheck,
    repository,
  }), [installCheck, repository])
  const rows = groups.flatMap((group) => group.rows)
  const canManage = Boolean(projectAccess?.canManage)
  const accessKnown = projectAccess?.accessLevelKnown === true
  const readOnly = !canManage
  const roleText = loadingProjectAccess
    ? "正在读取权限..."
    : canManage
      ? `当前角色 ${projectAccess?.role || "Maintainer"}`
      : accessKnown
        ? `当前角色 ${projectAccess?.role || "No access"}，仅可查看`
        : "权限未知"
  const checkedRows = rows
  const checkedCount = checkedRows.filter((row) => row.status !== "unknown").length
  const repoChangeCount = checkedRows.filter((row) => row.kind === "repo" && row.status === "needs_action").length
  const hasInputBlocker = checkedRows.some((row) => rowNeedsInput(row, installForm))
  const canRunInstall = Boolean(project && installCheck && canManage) && !checking && !installing && checkedCount > 0 && !hasInputBlocker
  const repairLabel = repoChangeCount > 0 ? "应用配置并创建 MR" : "自动修复可修复项"

  useEffect(() => {
    setInstallForm(installFormFromDefaults(defaults))
  }, [defaults?.agentrix?.runnerId, defaults?.automation?.agent, defaults?.automation?.autoDefault, defaults?.automation?.reviewEnabled])

  async function checkRows(rowId = "all") {
    if (!canManage) return
    setCheckingRowId(rowId)
    try {
      const row = rows.find((item) => item.id === rowId)
      await onCheck({
        ...installInput,
        ...(row ? { checkType: row.checkType } : { checkTypes: ["variables", "webhook"] }),
      })
    } finally {
      setCheckingRowId("")
    }
  }

  async function saveVariable(row: CheckRow) {
    if (!row.variable?.key || !canManage) return
    await onSetVariable(row.variable.key, {
      ...installInput,
      value: variableSaveValue(row, installForm),
      scope: row.variable.scope || row.variable.environmentScope || "*",
    })
    setExpandedRowId("")
  }

  async function runInstallPlan() {
    await onInstall(installInput)
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
              {checkingRowId === "all" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              检查全部
            </Button>
            <Button type="button" onClick={runInstallPlan} disabled={!canRunInstall}>
              {installing ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
              {repairLabel}
            </Button>
          </div>
        )}
      </header>
      {installMessage && <p className="install-console-message">{installMessage}</p>}
      <div className="check-table">
        {groups.map((group) => (
          <section className="check-group" key={group.title}>
            <header>
              <strong>{group.title}</strong>
              <span>{group.rows.filter((row) => row.status === "passed").length}/{group.rows.length}</span>
            </header>
            {group.rows.map((row) => (
              <CheckTableRow
                checking={checking && checkingRowId === row.id}
                expanded={expandedRowId === row.id}
                installForm={installForm}
                key={row.id}
                row={row}
                canRunInstall={canRunInstall}
                setExpanded={(expanded) => setExpandedRowId(expanded ? row.id : "")}
                setInstallForm={setInstallForm}
                onCheck={() => checkRows(row.id)}
                onSaveVariable={() => saveVariable(row)}
                onInstall={runInstallPlan}
                installing={installing}
                readOnly={readOnly}
              />
            ))}
          </section>
        ))}
      </div>
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
  checkType: "variables" | "webhook"
  status: CheckStatus
  detail?: string
  files?: string[]
  missing?: string[]
  inputRequired?: string[]
  variable?: NonNullable<InstallStep["variables"]>[number]
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
      const variable = {
        key: item.name,
        label: item.name,
        description: item.description,
        status: "unknown" as CheckStatus,
        ...(checkedVariable || {}),
        control: checkedVariable?.control || item.control,
      }
      return {
        id: item.id,
        title: variable.label || item.name,
        description: item.description,
        kind: "api",
        checkType: "variables",
        status: variable.status || "unknown",
        detail: variableDetail(variable, item.description),
        variable,
        configItem: item,
      }
    }
    const step = byId.get(item.id)
    return {
      id: item.id,
      title: item.name,
      description: item.description || "",
      kind: item.type === "permission" ? "auth" : item.type === "repo_file" ? "repo" : "api",
      checkType: "webhook",
      status: step?.status || "unknown",
      detail: step?.detail,
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

function rowNeedsInput(row: CheckRow, form: InstallForm) {
  if (row.variable?.needsInput && row.variable.control) {
    return !formValue(form, row.variable.control.path)
  }
  return row.status === "needs_input"
}

function variableSaveValue(row: CheckRow, form: InstallForm) {
  const control = row.variable?.control
  const fallback = row.configItem?.defaultValue ?? row.variable?.value ?? ""
  const value = control ? formValue(form, control.path) : fallback
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value ?? "")
}

function CheckTableRow({
  canRunInstall,
  checking,
  expanded,
  installForm,
  installing,
  readOnly,
  row,
  setExpanded,
  setInstallForm,
  onCheck,
  onSaveVariable,
  onInstall,
}: {
  canRunInstall: boolean
  checking: boolean
  expanded: boolean
  installForm: InstallForm
  installing: boolean
  readOnly: boolean
  row: CheckRow
  setExpanded: (expanded: boolean) => void
  setInstallForm: (value: InstallForm | ((current: InstallForm) => InstallForm)) => void
  onCheck: () => Promise<void>
  onSaveVariable: () => Promise<void>
  onInstall: () => Promise<void>
}) {
  const canEdit = Boolean(row.variable?.control)
  const needsInput = rowNeedsInput(row, installForm)
  const canRepair = row.status === "needs_action" && row.kind === "repo"
  const canSetVariable = Boolean(row.variable) && !readOnly
  const statusIcon = row.status === "passed"
    ? <CheckCircle2 className="size-4" />
    : row.status === "unknown"
      ? <CircleDot className="size-4" />
      : <AlertCircle className="size-4" />
  return (
    <div className={`check-table-row ${row.status} ${expanded ? "expanded" : ""}`}>
      <div className="check-row-main">
        <span className="check-status-icon">{statusIcon}</span>
        <span className="check-row-copy">
          <strong>{row.title}</strong>
          <small>{row.variable ? row.description : row.detail || row.description}</small>
        </span>
        {row.variable && <VariableValue variable={row.variable} />}
        <div className="check-row-actions">
          {canSetVariable && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => canEdit || needsInput ? setExpanded(!expanded) : onSaveVariable()}
            >
              {expanded ? "收起" : row.status === "passed" ? "重新设置" : "设置"}
            </Button>
          )}
          {canRepair && <Button type="button" size="sm" variant="secondary" onClick={onInstall} disabled={installing || !canRunInstall}>{row.kind === "repo" ? "创建 MR" : "自动修复"}</Button>}
          {!readOnly && <Button type="button" size="sm" variant="ghost" onClick={onCheck} disabled={checking}>
            {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            检查
          </Button>}
        </div>
      </div>
      {expanded && (
        <CheckRowDetail
          installForm={installForm}
          row={row}
          setInstallForm={setInstallForm}
          onSave={onSaveVariable}
        />
      )}
      {(row.files?.length || row.missing?.length) ? <CheckRowMeta row={row} /> : null}
    </div>
  )
}

function CheckRowDetail({
  installForm,
  onSave,
  row,
  setInstallForm,
}: {
  installForm: InstallForm
  onSave: () => Promise<void>
  row: CheckRow
  setInstallForm: (value: InstallForm | ((current: InstallForm) => InstallForm)) => void
}) {
  const control = row.variable?.control
  if (control) {
    const value = formValue(installForm, control.path)
    return (
      <div className="check-row-detail">
        <Label>{row.variable?.label || row.title}</Label>
        <VariableInput
          control={control}
          value={value}
          onChange={(nextValue) => setInstallForm((current) => updateFormValue(current, control.path, nextValue))}
        />
        <div className="check-row-detail-actions">
          <small>{variableMetaText(row)}</small>
          <Button type="button" size="sm" onClick={onSave}>保存变量</Button>
        </div>
      </div>
    )
  }
  if (row.variable) {
    return (
      <div className="check-row-detail">
        <Label>{row.variable.label || row.title}</Label>
        <Input value={String(row.configItem?.defaultValue ?? row.variable.value ?? "")} readOnly />
        <div className="check-row-detail-actions">
          <small>{variableMetaText(row)}</small>
          <Button type="button" size="sm" onClick={onSave}>{row.status === "passed" ? "重新设置" : "设置"}</Button>
        </div>
      </div>
    )
  }
  return <div className="check-row-detail muted">此项需要在 Git server 配置中维护，保存后重新检查。</div>
}

function variableMetaText(row: CheckRow) {
  const variable = row.variable
  if (!variable) return ""
  const parts = [
    variable.source ? `source: ${variable.source}` : "",
    variable.scope || variable.environmentScope ? `scope: ${variable.scope || variable.environmentScope}` : "",
    variable.variableType ? `type: ${variable.variableType}` : "",
  ].filter(Boolean)
  return parts.join(" · ") || variable.description || variable.key
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

function VariableInput({
  control,
  value,
  onChange,
}: {
  control: NonNullable<NonNullable<InstallStep["variables"]>[number]["control"]>
  value: unknown
  onChange: (value: string | boolean) => void
}) {
  if (control.type === "checkbox") {
    return (
      <label className="inline-check">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.currentTarget.checked)} />
        启用
      </label>
    )
  }
  if (control.type === "select") {
    return (
      <Select value={String(value || "")} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {(control.options || []).map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
        </SelectContent>
      </Select>
    )
  }
  return (
    <Input
      value={String(value || "")}
      onChange={(event) => onChange(event.currentTarget.value)}
      type={control.type}
      placeholder={control.placeholder}
    />
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
