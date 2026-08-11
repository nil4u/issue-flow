import { useMemo, useState } from "react"
import { Bot, ChevronDown, GitPullRequest, Loader2 } from "lucide-react"
import { toast } from "sonner"

import { ProviderLabel, ProviderLabelPicker } from "@/components/issues/provider-label-picker"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { api, type ProviderIssueLabel } from "@/issue-flow-model"
import { isManagedMergeRequestLabel } from "@/lib/label-search"

const MR_BY_OPTIONS = [
  { value: "__unset__", label: "未设置", detail: "移除 MR By Label" },
  { value: "mr-by::plan", label: "Plan", detail: "由 Plan 阶段创建" },
  { value: "mr-by::build", label: "Build", detail: "由 Build 阶段创建" },
]
const REVIEW_OPTIONS = [
  { value: "__default__", label: "Default", detail: "跟随仓库配置" },
  { value: "review::off", label: "Off", detail: "暂停自动 Review" },
]

export function MergeRequestLabelControls({ baseApi, labels, availableLabels, onUpdated, onError }: { baseApi: string; labels: string[]; availableLabels: ProviderIssueLabel[]; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const [busy, setBusy] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const managedLabels = useMemo(() => labels.filter(isManagedMergeRequestLabel), [labels])
  const unmanagedLabels = useMemo(() => labels.filter((label) => !isManagedMergeRequestLabel(label)), [labels])
  const availableUnmanagedLabels = useMemo(() => availableLabels.filter((label) => !isManagedMergeRequestLabel(label.name)), [availableLabels])
  const mrByLabels = useMemo(() => labels.filter((label) => label.startsWith("mr-by::")), [labels])
  const mrBy = mrByLabels.length === 1 ? mrByLabels[0] : ""
  const reviewPaused = labels.includes("review::off")
  const value = mrByLabels.length > 1 ? "状态异常" : MR_BY_OPTIONS.find((option) => option.value === mrBy)?.label || "未设置"

  async function updateManagedLabel(nextValue: string) {
    if (busy) return
    setBusy("mrBy"); onError("")
    try {
      await api(`${baseApi}/workflow`, { method: "PATCH", body: JSON.stringify({ changes: { mrBy: nextValue === "__unset__" ? null : nextValue } }) })
      await onUpdated(); toast.success("Labels 已更新")
    } catch (error) { onError(error instanceof Error ? error.message : "更新 Labels 失败") }
    finally { setBusy("") }
  }

  async function updateReview(nextValue: string) {
    if (busy) return
    setBusy("review"); onError("")
    try {
      await api(`${baseApi}/workflow`, { method: "PATCH", body: JSON.stringify({ changes: { review: nextValue === "__default__" ? null : nextValue } }) })
      await onUpdated(); toast.success(nextValue === "__default__" ? "Review 已恢复仓库默认" : "Review 已暂停")
    } catch (error) { onError(error instanceof Error ? error.message : "更新 Review 失败") }
    finally { setBusy("") }
  }

  async function saveLabels() {
    if (busy) return
    setBusy("labels"); onError("")
    try {
      await api(`${baseApi}/labels`, { method: "PATCH", body: JSON.stringify({ labels: [...managedLabels, ...selectedLabels] }) })
      setPickerOpen(false); await onUpdated(); toast.success("Labels 已更新")
    } catch (error) { onError(error instanceof Error ? error.message : "更新 Labels 失败") }
    finally { setBusy("") }
  }

  async function removeLabel(label: string) {
    if (busy) return
    setBusy(label); onError("")
    try {
      await api(`${baseApi}/labels`, { method: "PATCH", body: JSON.stringify({ labels: labels.filter((item) => item !== label) }) })
      await onUpdated(); toast.success("Labels 已更新")
    } catch (error) { onError(error instanceof Error ? error.message : "删除 Label 失败") }
    finally { setBusy("") }
  }

  return <>
    <section className="mr-label-section">
      <header><strong>Labels</strong><button type="button" onClick={() => { setSelectedLabels(unmanagedLabels); setPickerOpen(true) }}>编辑</button></header>
      <div className="mr-label-control-row">
        <span><GitPullRequest className="size-3.5" />MR By</span>
        <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="mr-label-control-trigger" disabled={Boolean(busy)}>{busy === "mrBy" ? <Loader2 className="size-3.5 animate-spin" /> : null}<strong>{busy === "mrBy" ? "更新中" : value}</strong><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={mrBy || "__unset__"} onValueChange={(nextValue) => void updateManagedLabel(nextValue)}>{MR_BY_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><span className="mr-label-option"><strong>{option.label}</strong><small>{option.detail}</small></span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
      </div>
      <div className="mr-label-control-row">
        <span><Bot className="size-3.5" />Review</span>
        <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="mr-label-control-trigger" disabled={Boolean(busy)}>{busy === "review" ? <Loader2 className="size-3.5 animate-spin" /> : null}<strong>{busy === "review" ? "更新中" : reviewPaused ? "Off" : "Default"}</strong><ChevronDown className="size-3.5" /></button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuRadioGroup value={reviewPaused ? "review::off" : "__default__"} onValueChange={(nextValue) => void updateReview(nextValue)}>{REVIEW_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><span className="mr-label-option"><strong>{option.label}</strong><small>{option.detail}</small></span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
      </div>
      <div className="mr-unmanaged-labels">{unmanagedLabels.length ? <div className="provider-issue-labels">{unmanagedLabels.map((label) => <ProviderLabel key={label} label={availableLabels.find((item) => item.name === label) || { name: label, color: "6e7781", description: "" }} onRemove={() => void removeLabel(label)} removeDisabled={Boolean(busy)} />)}</div> : <p>暂无其他 Labels</p>}</div>
    </section>
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}><DialogContent className="provider-issue-label-dialog"><DialogHeader><DialogTitle>编辑 Labels</DialogTitle></DialogHeader><ProviderLabelPicker labels={availableUnmanagedLabels} selected={selectedLabels} onChange={setSelectedLabels} disabled={Boolean(busy)} /><div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setPickerOpen(false)} disabled={Boolean(busy)}>取消</Button><Button onClick={() => void saveLabels()} disabled={Boolean(busy)}>{busy === "labels" ? <Loader2 className="size-4 animate-spin" /> : null}{busy === "labels" ? "保存中" : "保存 Labels"}</Button></div></DialogContent></Dialog>
  </>
}
