import { useMemo, useState, type ComponentType, type ReactNode } from "react"
import { Bot, Boxes, ChevronDown, CircleDot, Gauge, GitBranch, Loader2, Ruler, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import type { ProviderIssueLabel } from "@/issue-flow-model"

type WorkflowGroup = "type" | "status" | "flow" | "visualPlan" | "automation" | "optimization" | "priority" | "size"
type WorkflowChanges = Partial<Record<WorkflowGroup, string | null>>
type Option = { value: string; label: string; detail?: string }

const STATUS_OPTIONS: Option[] = [
  { value: "status::active", label: "Active", detail: "正常推进" },
  { value: "status::suspend", label: "Suspend", detail: "暂停自动推进" },
  { value: "status::done", label: "Done", detail: "标记为已完成" },
  { value: "status::drop", label: "Drop", detail: "标记为已放弃" },
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
const OPTIMIZATION_OPTIONS: Option[] = [
  { value: "__none__", label: "未设置" },
  { value: "optimization::analyzing", label: "Analyzing" },
  { value: "optimization::analyzed", label: "Analyzed" },
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
      <ControlMenu title="Optimization" icon={Sparkles} value={optimization || "__none__"} options={OPTIMIZATION_OPTIONS} disabled={!canEdit || Boolean(busyGroup)} busy={busyGroup === "optimization"} onChange={(value) => void onChange({ optimization: value === "__none__" ? null : value })} />
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
  function selectStatus(nextValue: string) {
    if (nextValue === status) return
    if (nextValue === "status::done") return onConfirm(nextValue, "设为 Done？", "只会将 Status Label 切换为 Done，不会关闭 Issue。", "完成")
    if (nextValue === "status::drop") return onConfirm(nextValue, "设为 Drop？", "只会将 Status Label 切换为 Drop，不会关闭 Issue。", "放弃", true)
    onChange(nextValue)
  }
  return <div className="issue-control-row">
    <span className="issue-control-title"><CircleDot className="size-3.5" />Status</span>
    <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="issue-control-trigger issue-status-trigger" disabled={disabled}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : <StatusDot value={status} />}<span>{busy ? "更新中" : value}</span><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={status} onValueChange={selectStatus}>{STATUS_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><span className="issue-status-option"><StatusDot value={option.value} /><span className="issue-control-option"><strong>{option.label}</strong><small>{option.detail}</small></span></span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
  </div>
}

function StatusDot({ value }: { value: string }) { return <span className={`issue-status-dot ${value.replace("status::", "") || "unset"}`} /> }

function ControlMenu({ title, icon: Icon, value, options, disabled, busy, onChange }: { title: string; icon: ComponentType<{ className?: string }>; value: string; options: Option[]; disabled: boolean; busy: boolean; onChange: (value: string) => void }) {
  return <div className="issue-control-row"><span className="issue-control-title"><Icon className="size-3.5" />{title}</span><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="issue-control-trigger" disabled={disabled}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}<span>{busy ? "更新中" : optionLabel(options, value) || "未设置"}</span><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={value} onValueChange={onChange}>{options.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><span className="issue-control-option"><strong>{option.label}</strong>{option.detail ? <small>{option.detail}</small> : null}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu></div>
}

function valuesFor(labels: string[], prefix: string) { return labels.filter((label) => label.startsWith(prefix)) }
function singleValue(labels: string[], prefix: string) { const values = valuesFor(labels, prefix); return values.length === 1 ? values[0] : "" }
function optionLabel(options: Option[], value?: string) { return options.find((option) => option.value === value)?.label || "" }
