import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  CircleX,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Webhook,
  Wrench,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AgentrixHelpDialog } from "@/components/agentrix-help-dialog"
import { EmptyPanel } from "@/components/empty-panel"
import { GitRunnerValue } from "@/components/git-runner-value"
import { InstallConflictWizard } from "@/components/install-conflict-wizard"
import { IssuesBoard } from "@/components/issues-board"
import { RowValue } from "@/components/row-value"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { VariableSettingsDialog } from "@/components/variable-settings-dialog"
import { gitlabInstallCheckConfig } from "@/install-check-config"
import type { InstallStep, RepoWorkspaceProps, Repository } from "@/issue-flow-model"
import type { InstallCheckConfigItem } from "@/install-check-config"
import type { AgentrixHelpTopicId } from "@/lib/agentrix-help"

const MetricsBoard = lazy(() =>
  import("@/components/metrics-board").then((module) => ({ default: module.MetricsBoard })),
)

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
  loadingRepositoryDetails,
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
  if (repository && !repository.settings && loadingRepositoryDetails) {
    return <EmptyPanel icon={<Loader2 className="size-6 animate-spin" />} title="正在加载仓库详情" detail="正在读取安装状态。" />
  }
  const plugin = repository?.settings?.plugins?.items?.find((item) => item.key === "issue-flow")
  if (!repository || !plugin?.installed) {
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
      <Suspense fallback={<div className="metrics-loading"><Loader2 className="size-4 animate-spin" /> 正在加载度量看板...</div>}>
        <MetricsBoard repository={repository} />
      </Suspense>
    </div>
  )
}

function InstallConsole({
  project,
  repository,
  loadingRepositoryDetails,
  defaults,
  installCheck,
  checkProgress,
  installConflictPlan,
  checking,
  projectAccess,
  loadingProjectAccess,
  onCheck,
  onCloseCheckProgress,
  onConfirmInstallConflicts,
  onCancelInstallConflicts,
  onInstallPlugin,
  onSetVariable,
  onSetRunner,
  onSetWebhook,
}: RepoWorkspaceProps) {
  const [installForm, setInstallForm] = useState(() => installFormFromDefaults(defaults))
  const [actionRowId, setActionRowId] = useState("")
  const [editingRow, setEditingRow] = useState<CheckRow>()
  const [editingValue, setEditingValue] = useState("")
  const [helpTopicId, setHelpTopicId] = useState<AgentrixHelpTopicId>()
  const installInput = useMemo(() => installForm, [installForm])
  const groups = useMemo(() => buildInstallGroups({
    defaults,
    installCheck,
    repository,
  }), [defaults, installCheck, repository])
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

  async function openVariableDialog(row: CheckRow) {
    if (!row.variable || !canManage) return
    if (row.variable.key === "AGENTRIX_API_KEY" && defaults?.agentrix?.apiKeyFingerprint) {
      setActionRowId(row.id)
      try {
        await onSetVariable(row.variable.key, installInput)
      } finally {
        setActionRowId("")
      }
      return
    }
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

  async function saveRunner(row: CheckRow) {
    if (row.configItem?.type !== "git-runner" || !canManage) return
    setActionRowId(row.id)
    try { await onSetRunner() } finally { setActionRowId("") }
  }

  async function installPlugin(row: CheckRow) {
    if (row.configItem?.type !== "plugin" || !canManage) return
    setActionRowId(row.id)
    try {
      await onInstallPlugin()
    } finally {
      setActionRowId("")
    }
  }

  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="先从左侧选择一个 repo。" />
  if (repository && !repository.settings && loadingRepositoryDetails) {
    return <EmptyPanel icon={<Loader2 className="size-6 animate-spin" />} title="正在加载仓库详情" detail="正在读取设置项。" />
  }

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
                onSaveRunner={() => saveRunner(row)}
                onInstallPlugin={() => installPlugin(row)}
                onOpenHelp={setHelpTopicId}
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
        placeholder={variablePlaceholder(editingRow)}
        onSave={saveVariable}
      />
      <AgentrixHelpDialog
        topicId={helpTopicId}
        onOpenChange={(open) => {
          if (!open) setHelpTopicId(undefined)
        }}
      />
      <CheckProgressDialog
        checking={checking}
        progress={checkProgress}
        onClose={onCloseCheckProgress}
      />
      <InstallConflictWizard
        checking={checking}
        plan={installConflictPlan}
        onCancel={onCancelInstallConflicts}
        onConfirm={onConfirmInstallConflicts}
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
  plugin?: NonNullable<InstallStep["plugins"]>[number]
  permission?: NonNullable<InstallStep["permissions"]>[number]
  runner?: NonNullable<InstallStep["runners"]>[number]
  value?: string
  valueHref?: string
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
  defaults,
  installCheck,
  repository,
}: {
  defaults?: RepoWorkspaceProps["defaults"]
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
  const plugins = byId.get("plugins")?.plugins || repository?.settings?.plugins?.items || []
  const pluginByKey = new Map(plugins.map((plugin) => [plugin.key, plugin]))
  const permissions = byId.get("permissions")?.permissions || repository?.settings?.permissions?.items || []
  const permissionByKey = new Map(permissions.map((permission) => [permission.key, permission]))
  const runner = byId.get("runners")?.runners?.[0] || repository?.settings?.runners?.items?.[0]
  const row = (item: InstallCheckConfigItem): CheckRow => {
    if (item.type === "variable") {
      const checkedVariable = variableByKey.get(item.name)
      const cached = Boolean(checkedVariable)
      const exists = checkedVariable?.exists ?? cached
      const status = checkedVariable?.status || (cached ? "passed" : "unknown")
      const accountAgentrixKey = item.name === "AGENTRIX_API_KEY" && Boolean(defaults?.agentrix?.apiKeyFingerprint)
      const variable = {
        key: item.name,
        label: item.name,
        description: accountAgentrixKey && !checkedVariable
          ? "使用账户页已校验的 Agentrix API key 写入 GitLab CI 变量。"
          : item.description,
        ...(checkedVariable || {}),
        exists,
        status: accountAgentrixKey && !checkedVariable ? "needs_action" as CheckStatus : status as CheckStatus,
        control: checkedVariable?.control || item.control,
      }
      return {
        id: item.id,
        title: variable.label || item.name,
        description: item.description,
        kind: "api",
        status: variable.status || "unknown",
        detail: accountAgentrixKey && !checkedVariable
          ? `账户级 key 已校验 ${defaults?.agentrix?.apiKeyFingerprint || ""}`
          : variableDetail(variable, item.description),
        variable,
        configItem: item,
      }
    }
    if (item.type === "permission") {
      const step = byId.get("permissions")
      const permission = permissionByKey.get("admin-pat")
      return {
        id: item.id,
        title: item.name,
        description: item.description || "",
        kind: "auth",
        status: permissionStatus(permission, step?.status),
        detail: step?.detail || permissionDetail(permission),
        value: permissionValue(permission),
        valueHref: permission?.memberUrl || step?.memberUrl,
        permission,
        configItem: item,
      }
    }
    if (item.type === "plugin") {
      const step = byId.get("plugins")
      const plugin = pluginByKey.get(item.name)
      const status = pluginStatus(plugin, step?.status)
      return {
        id: item.id,
        title: item.name,
        description: item.description || "",
        kind: "repo",
        status,
        detail: pluginDetail(plugin),
        value: pluginValue(plugin),
        plugin,
        files: step?.files,
        actionCount: step?.actionCount,
        configItem: item,
      }
    }
    const step = byId.get(item.id)
    const runnerSettingsUrl = item.type === "git-runner" && repository?.webUrl ? `${repository.webUrl.replace(/\/+$/, "")}/-/settings/ci_cd#js-runners-settings` : undefined
    const cachedWebhook = item.type === "webhook" ? repository?.settings?.webhook : undefined
    const cachedWebhookUrl = String(cachedWebhook?.url || "")
    const cachedWebhookHookId = String(cachedWebhook?.hookId || "")
    const runnerStatus = item.type === "git-runner" ? runner?.status as CheckStatus | undefined : undefined
    const runnerValue = item.type === "git-runner" && (step?.status === "passed" || runnerStatus === "passed") ? step?.value || runner?.name || runner?.runnerId : undefined
    const fallbackStatus = item.type === "webhook"
      ? cachedWebhookHookId ? "passed" : "needs_action"
      : runnerStatus || "unknown"
    return {
      id: item.id,
      title: item.name,
      description: item.description || "",
      kind: item.type === "repo_file" ? "repo" : "api",
      status: step?.status || fallbackStatus,
      detail: step?.detail || (item.type === "webhook" && cachedWebhookHookId ? cachedWebhookUrl : item.type === "webhook" ? "未配置" : runner?.detail),
      value: item.type === "webhook" && cachedWebhookHookId ? cachedWebhookUrl : runnerValue,
      valueHref: runnerSettingsUrl,
      runner: item.type === "git-runner" ? runner : undefined,
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

function pluginStatus(plugin?: NonNullable<CheckRow["plugin"]>, fallback?: CheckStatus): CheckStatus {
  if (plugin?.status) return plugin.status
  if (plugin?.pendingMergeRequest?.webUrl) return "needs_action"
  if (plugin?.manifestInvalid) return "needs_action"
  if (plugin?.installed && !plugin.installedVersion) return "needs_action"
  if (plugin?.installed && plugin.needsUpgrade) return "needs_action"
  if (plugin?.installed) return "passed"
  return fallback || "needs_action"
}

function pluginVersionLabel(version?: string) {
  return version ? `v${String(version).replace(/^v/, "")}` : "未知版本"
}

function pluginUpgradeLabel(plugin: NonNullable<CheckRow["plugin"]>) {
  const installed = plugin.installedVersion
    ? String(plugin.installedVersion).replace(/^v/, "")
    : "未知版本"
  const latestVersion = plugin.latestVersion || plugin.targetVersion
  const latest = latestVersion
    ? String(latestVersion).replace(/^v/, "")
    : ""
  return latest ? `${installed} -> ${latest}` : installed
}

function pluginDetail(plugin?: NonNullable<CheckRow["plugin"]>) {
  if (!plugin) return "未安装"
  if (plugin.detail) return plugin.detail
  if (plugin.manifestInvalid) return "manifest 无效"
  if (plugin.pendingMergeRequest?.webUrl) return `MR !${plugin.pendingMergeRequest.iid || ""} 待合并`
  if (plugin.installed && !plugin.installedVersion) return "版本未知，建议升级"
  if (plugin.installed && plugin.needsUpgrade) return pluginUpgradeLabel(plugin)
  if (plugin.installed) return pluginVersionLabel(plugin.installedVersion)
  return "未安装"
}

function pluginValue(plugin?: NonNullable<CheckRow["plugin"]>) {
  if (!plugin) return "未安装"
  if (plugin.pendingMergeRequest?.webUrl) return `!${plugin.pendingMergeRequest.iid || "MR"}`
  if (plugin.installed && plugin.needsUpgrade) return pluginUpgradeLabel(plugin)
  if (plugin.installed && !plugin.installedVersion) return "未知版本"
  if (plugin.installed) return pluginVersionLabel(plugin.installedVersion)
  return "未安装"
}

function permissionStatus(permission?: NonNullable<CheckRow["permission"]>, fallback?: CheckStatus): CheckStatus {
  if (permission?.canManage) return "passed"
  if (permission) return "blocked"
  return fallback || "unknown"
}

function permissionDetail(permission?: NonNullable<CheckRow["permission"]>) {
  if (!permission) return "等待检查"
  if (permission.canManage) return permission.role || "Maintainer"
  const account = permission.name || permission.username || permission.email || "admin PAT 对应账号"
  return `请将 ${account} 加入该 repo 或上级 group，并授予 Maintainer 权限`
}

function permissionValue(permission?: NonNullable<CheckRow["permission"]>) {
  if (!permission) return "未知"
  return permission.role || "No access"
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
  onSaveRunner,
  onInstallPlugin,
  onOpenHelp,
}: {
  checking: boolean
  readOnly: boolean
  row: CheckRow
  onSetVariable: () => void
  onSaveWebhook: () => Promise<void>
  onSaveRunner: () => Promise<void>
  onInstallPlugin: () => Promise<void>
  onOpenHelp: (topicId: AgentrixHelpTopicId) => void
}) {
  const canSetVariable = Boolean(row.variable) && !readOnly
  const canSetWebhook = row.configItem?.type === "webhook" && !readOnly
  const canSetRunner = row.configItem?.type === "git-runner" && !readOnly && row.status !== "passed"
  const canInstallPlugin = row.configItem?.type === "plugin"
    && !readOnly
    && (
      !row.plugin?.installed
      || !row.plugin?.installedVersion
      || Boolean(row.plugin?.needsUpgrade)
      || Boolean(row.plugin?.manifestInvalid)
    )
    && !row.plugin?.pendingMergeRequest?.webUrl
  const canOpenMembers = row.configItem?.type === "permission" && Boolean(row.valueHref) && row.status !== "passed"
  const pendingMergeHref = row.plugin?.pendingMergeRequest?.webUrl || ""
  const showMergeAction = Boolean(pendingMergeHref)
  const showPluginAction = canInstallPlugin && Boolean(row.plugin?.installed && row.plugin.needsUpgrade)
  const pluginActionLabel = row.plugin?.manifestInvalid ? "重新安装" : row.plugin?.installed ? "升级" : "安装"
  const pluginUpgradeValue = showPluginAction && row.plugin ? pluginValue(row.plugin) : ""
  const helpTopicId = row.configItem?.helpTopicId
  const statusIcon = row.status === "passed"
    ? <CheckCircle2 className="size-4" />
    : row.status === "unknown"
      ? <CircleDot className="size-4" />
      : row.status === "blocked" || row.status === "needs_input"
        ? <CircleX className="size-4" />
        : <AlertCircle className="size-4" />
  return (
    <div className={`check-table-row ${row.status}${showPluginAction ? " action-visible" : ""}`}>
      <div className="check-row-main">
        <span className="check-status-icon">{statusIcon}</span>
        <span className="check-row-copy">
          <strong>{row.title}</strong>
          <small>{row.description}</small>
          {helpTopicId && (
            <button type="button" className="check-row-help" onClick={() => onOpenHelp(helpTopicId)}>
              <CircleHelp className="size-3.5" />
              如何获取
            </button>
          )}
        </span>
        {row.variable && <VariableValue variable={row.variable} />}
        {showMergeAction ? (
          <div className="check-row-upgrade">
            <Button asChild size="sm" variant="secondary">
              <a href={pendingMergeHref} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                去合并
              </a>
            </Button>
          </div>
        ) : showPluginAction ? (
          <div className="check-row-upgrade">
            <RowValue value={pluginUpgradeValue} />
            <Button type="button" size="sm" variant="secondary" onClick={onInstallPlugin} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
              {pluginActionLabel}
            </Button>
          </div>
        ) : row.runner && row.status === "passed" ? (
          <GitRunnerValue runner={row.runner} href={row.valueHref} />
        ) : !row.variable && row.value && (
          <RowValue
            value={row.value}
            href={row.valueHref || row.plugin?.pendingMergeRequest?.webUrl}
          />
        )}
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
          {canSetRunner && <Button type="button" size="sm" variant="secondary" onClick={onSaveRunner} disabled={checking}>{checking ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />} 自动配置</Button>}
          {canInstallPlugin && !showPluginAction && (
            <Button type="button" size="sm" variant="secondary" onClick={onInstallPlugin} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
              {pluginActionLabel}
            </Button>
          )}
          {canOpenMembers && (
            <Button asChild size="sm" variant="secondary">
              <a href={row.valueHref} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                成员管理
              </a>
            </Button>
          )}
          {row.configItem?.type === "git-runner" && row.valueHref && (
            <Button asChild size="sm" variant="secondary">
              <a href={row.valueHref} target="_blank" rel="noreferrer"><ExternalLink className="size-4" />Runner 设置</a>
            </Button>
          )}
        </div>
      </div>
      {(row.detail || row.permission || row.files?.length || row.missing?.length) ? <CheckRowMeta row={row} /> : null}
    </div>
  )
}

function CheckProgressDialog({
  checking,
  onClose,
  progress,
}: {
  checking: boolean
  onClose: () => void
  progress?: RepoWorkspaceProps["checkProgress"]
}) {
  const open = Boolean(progress?.open)
  const title = progress?.title || "正在检查"
  const detail = progress?.detail || (checking ? "按顺序检查配置项" : "检查结果已更新")
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}>
      <DialogContent className="check-progress-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="check-progress-body">
          <p>{detail}</p>
          <div className="check-progress-list">
            {(progress?.steps || []).map((step) => (
              <div className={`check-progress-step ${step.status}`} key={step.id}>
                <span className="check-progress-step-icon">
                  {step.status === "running"
                    ? <Loader2 className="size-4 animate-spin" />
                    : step.status === "passed"
                      ? <CheckCircle2 className="size-4" />
                      : step.status === "failed"
                        ? <AlertCircle className="size-4" />
                        : <CircleDot className="size-4" />}
                </span>
                <strong>{step.label}</strong>
              </div>
            ))}
          </div>
        </div>
        {!checking && (
          <div className="check-progress-actions">
            {progress?.actionHref && (
              <Button asChild>
                <a href={progress.actionHref} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  {progress.actionLabel || "打开"}
                </a>
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose}>完成</Button>
          </div>
        )}
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

function CheckRowMeta({ row }: { row: CheckRow }) {
  if (row.status !== "passed" && row.detail) {
    return <div className="check-row-meta warning">{row.detail}</div>
  }
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
