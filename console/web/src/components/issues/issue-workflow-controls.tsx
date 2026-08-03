import { useMemo, useState, type ComponentType, type ReactNode } from "react"
import { Bot, Boxes, Check, ChevronDown, CircleDot, Gauge, GitBranch, Loader2, MoreHorizontal, Pause, Play, Ruler, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import type { ProviderIssueLabel } from "@/issue-flow-model"

type WorkflowGroup = "type" | "status" | "flow" | "visualPlan" | "automation" | "priority" | "size"
type WorkflowChanges = Partial<Record<WorkflowGroup, string | null>>
type Option = { value: string; label: string; detail?: string }

const STATUS_OPTIONS: Option[] = [
  { value: "status::active", label: "Active" },
  { value: "status::suspend", label: "Suspend" },
  { value: "status::done", label: "Done" },
  { value: "status::drop", label: "Drop" },
]
const FLOW_OPTIONS: Option[] = [
  { value: "flow::triage", label: "Triage", detail: "等待分类和规范化" },
  { value: "flow::plan", label: "Plan", detail: "等待方案规划" },
  { value: "flow::build", label: "Build", detail: "等待实现" },
  { value: "flow::clarify", label: "Clarify", detail: "等待人工补充信息" },
  { value: "flow::approve", label: "Approve", detail: "等待人工审批" },
]
const AUTOMATION_OPTIONS: Option[] = [
  { value: "__default__", label: "跟随仓库默认" },
  { value: "automation::off", label: "Off" },
  { value: "automation::plan", label: "Plan", detail: "自动推进至 Plan" },
  { value: "automation::build", label: "Build", detail: "自动推进至 Build" },
]
const TYPE_OPTIONS: Option[] = [
  { value: "type::feature", label: "Feature" }, { value: "type::bug", label: "Bug" },
  { value: "type::debt", label: "Debt" }, { value: "type::ops", label: "Ops" },
  { value: "type::docs", label: "Docs" }, { value: "type::optimization", label: "Optimization" },
]
const PRIORITY_OPTIONS: Option[] = [
  { value: "priority::p0", label: "P0", detail: "紧急阻塞" }, { value: "priority::p1", label: "P1", detail: "高优先级" },
  { value: "priority::p2", label: "P2", detail: "普通优先级" }, { value: "priority::p3", label: "P3", detail: "低优先级" },
]
const SIZE_OPTIONS: Option[] = [
  { value: "size::XS", label: "XS", detail: "权重 0.5" }, { value: "size::S", label: "S", detail: "权重 1" },
  { value: "size::M", label: "M", detail: "权重 2" }, { value: "size::L", label: "L", detail: "权重 3" },
  { value: "size::XL", label: "XL", detail: "权重 5" },
]

export function IssueWorkflowControls({ labels, canEdit, busyGroup, headerAction, children, onChange }: { labels: ProviderIssueLabel[]; canEdit: boolean; busyGroup: string; headerAction?: ReactNode; children?: ReactNode; onChange: (changes: WorkflowChanges) => Promise<void> }) {
  const names = useMemo(() => labels.map((label) => label.name), [labels])
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; action: string; changes: WorkflowChanges; destructive?: boolean }>()
  const [pendingFlow, setPendingFlow] = useState<string>()
  const statusLabels = valuesFor(names, "status::")
  const status = statusLabels.length === 1 ? statusLabels[0] : ""
  const flow = singleValue(names, "flow::")
  const automation = singleValue(names, "automation::")
  const size = singleValue(names, "size::")
  const optimization = singleValue(names, "optimization::")
  const visualPlan = names.includes("feature:visual-plan:on")

  function selectFlow(value: string) {
    if ((value === "flow::plan" || value === "flow::build") && !size) {
      setPendingFlow(value)
      return
    }
    void onChange({ flow: value })
  }

  function confirmStatus(value: string, title: string, description: string, action: string, destructive = false) {
    setConfirmation({ title, description, action, changes: { status: value }, destructive })
  }

  return <>
    <section className="issue-control-section">
      <header><strong>Labels</strong>{headerAction}</header>
      <StatusControl status={status} invalid={statusLabels.length > 1} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "status"} onChange={(value) => void onChange({ status: value })} onConfirm={confirmStatus} />
      <ControlMenu title="Flow" icon={GitBranch} value={flow} options={FLOW_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "flow"} onChange={selectFlow} />
      <ControlMenu title="Automation" icon={Bot} value={automation || "__default__"} options={AUTOMATION_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "automation"} onChange={(value) => void onChange({ automation: value === "__default__" ? null : value })} />
      {optimization ? <ReadOnlyControl title="Optimization" icon={Sparkles} value={optimization === "optimization::analyzing" ? "Analyzing" : "Analyzed"} /> : null}
      <ControlMenu title="Type" icon={Boxes} value={singleValue(names, "type::")} options={TYPE_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "type"} onChange={(value) => void onChange({ type: value })} />
      <ControlMenu title="Priority" icon={Gauge} value={singleValue(names, "priority::")} options={PRIORITY_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "priority"} onChange={(value) => void onChange({ priority: value })} />
      <ControlMenu title="Size" icon={Ruler} value={size} options={SIZE_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "size"} onChange={(value) => void onChange({ size: value })} />
      <div className="issue-control-row"><span className="issue-control-title"><Sparkles className="size-3.5" />Visual Plan</span><Switch size="sm" aria-label="切换 Visual Plan" checked={visualPlan} disabled={!canEdit || Boolean(busyGroup)} onCheckedChange={(checked) => void onChange({ visualPlan: checked ? "feature:visual-plan:on" : null })} /></div>
      {children ? <div className="issue-unmanaged-labels">{children}</div> : null}
    </section>
    <Dialog open={Boolean(confirmation)} onOpenChange={(open) => { if (!open) setConfirmation(undefined) }}>
      <DialogContent className="issue-confirm-dialog">
        <DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.description}</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="secondary" onClick={() => setConfirmation(undefined)}>取消</Button><Button variant={confirmation?.destructive ? "destructive" : "default"} onClick={() => { const changes = confirmation?.changes; setConfirmation(undefined); if (changes) void onChange(changes) }}>{confirmation?.action}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(pendingFlow)} onOpenChange={(open) => { if (!open) setPendingFlow(undefined) }}>
      <DialogContent className="issue-size-gate-dialog">
        <DialogHeader><DialogTitle>需要 Size</DialogTitle><DialogDescription>进入 {optionLabel(FLOW_OPTIONS, pendingFlow)} 前必须设置唯一的 Size。选择后将同时更新 Flow 和 Size。</DialogDescription></DialogHeader>
        <div className="issue-size-gate-options">{SIZE_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => { const flowValue = pendingFlow; setPendingFlow(undefined); if (flowValue) void onChange({ flow: flowValue, size: option.value }) }}><strong>{option.label}</strong><span>{option.detail}</span></button>)}</div>
      </DialogContent>
    </Dialog>
  </>
}

function StatusControl({ status, invalid, disabled, busy, onChange, onConfirm }: { status: string; invalid: boolean; disabled: boolean; busy: boolean; onChange: (value: string) => void; onConfirm: (value: string, title: string, description: string, action: string, destructive?: boolean) => void }) {
  const value = invalid ? "状态异常" : optionLabel(STATUS_OPTIONS, status) || "未设置"
  const action = status === "status::active" ? { label: "暂停", value: "status::suspend", icon: Pause }
    : status === "status::suspend" ? { label: "恢复", value: "status::active", icon: Play }
      : status === "status::done" || status === "status::drop" ? { label: "Active", value: "status::active", icon: Play }
        : { label: "启用", value: "status::active", icon: Play }
  return <div className="issue-status-control">
    <div className="issue-control-title"><CircleDot className="size-3.5" /><span><small>Status</small><strong className={`issue-status-value ${status.replace("status::", "") || "unset"}`}>{busy ? "更新中" : value}</strong></span></div>
    <div className="issue-status-actions">
      <Button size="xs" variant="secondary" disabled={disabled} onClick={() => onChange(action.value)}>{busy ? <Loader2 className="animate-spin" /> : <action.icon />}{action.label}</Button>
      {(status === "status::active" || status === "status::suspend") ? <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-xs" variant="ghost" disabled={disabled} aria-label="更多 Status 操作"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => onConfirm("status::done", "设为 Done？", "只会将 Status Label 切换为 Done，不会关闭 Issue。", "完成")}><Check />完成</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={() => onConfirm("status::drop", "设为 Drop？", "只会将 Status Label 切换为 Drop，不会关闭 Issue。", "放弃", true)}>放弃</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
    </div>
  </div>
}

function ControlMenu({ title, icon: Icon, value, options, disabled, busy, onChange }: { title: string; icon: ComponentType<{ className?: string }>; value: string; options: Option[]; disabled: boolean; busy: boolean; onChange: (value: string) => void }) {
  return <div className="issue-control-row"><span className="issue-control-title"><Icon className="size-3.5" />{title}</span><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="issue-control-trigger" disabled={disabled}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}<span>{busy ? "更新中" : optionLabel(options, value) || "未设置"}</span><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={value} onValueChange={onChange}>{options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><span className="issue-control-option"><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></div>
}

function ReadOnlyControl({ title, icon: Icon, value }: { title: string; icon: ComponentType<{ className?: string }>; value: string }) {
  return <div className="issue-control-row"><span className="issue-control-title"><Icon className="size-3.5" />{title}</span><span className="issue-control-readonly">{value}</span></div>
}

function valuesFor(labels: string[], prefix: string) { return labels.filter((label) => label.startsWith(prefix)) }
function singleValue(labels: string[], prefix: string) { const values = valuesFor(labels, prefix); return values.length === 1 ? values[0] : "" }
function optionLabel(options: Option[], value?: string) { return options.find((option) => option.value === value)?.label || "" }
