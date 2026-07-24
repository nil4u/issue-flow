import { Check, Loader2, Sparkles } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  api,
  type AutomationOptimizationItem,
  type DashboardPanel,
  type MetricsQueryResult,
  type Repository,
} from "@/issue-flow-model"
import { formatSeconds } from "@/lib/metrics-chart-options"

export type MetricsDrillSelection = {
  panel: DashboardPanel
  params: Record<string, string>
}

type DrillState = {
  loading: boolean
  error: string
  result?: MetricsQueryResult
  optimizations: Record<number, AutomationOptimizationItem>
}

type DrillKind = "issues" | "issue_type" | "issue_turns"
type SummaryItem = { label: string; value: string }

export function MetricsDrillDrawer({
  repository,
  slug,
  selection,
  onClose,
}: {
  repository: Repository
  slug: string
  selection: MetricsDrillSelection
  onClose: () => void
}) {
  const [state, setState] = useState<DrillState>({ loading: true, error: "", optimizations: {} })
  const [creatingIssueNumber, setCreatingIssueNumber] = useState(0)
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`

  useEffect(() => {
    const controller = new AbortController()
    const path = `/api/repositories/${encodeURIComponent(repository.id)}/dashboards/${encodeURIComponent(slug)}/panels/${encodeURIComponent(selection.panel.id)}/drill`
    void (async () => {
      try {
        const body = await api<{ result: MetricsQueryResult }>(path, {
          method: "POST",
          body: JSON.stringify({ params: selection.params }),
          signal: controller.signal,
        })
        const issueNumbers = body.result.rows.map((row) => Number(row.issue_number || 0)).filter((value) => value > 0)
        let optimizations: Record<number, AutomationOptimizationItem> = {}
        if (repository.gitServerId && repository.serverRepoId && issueNumbers.length) {
          const optimizationBody = await api<{ items: AutomationOptimizationItem[] }>(
            `/api/issues/${encodeURIComponent(repository.gitServerId)}/${encodeURIComponent(repository.serverRepoId)}/automation-optimizations`,
            { method: "POST", body: JSON.stringify({ issueNumbers }), signal: controller.signal },
          )
          optimizations = Object.fromEntries(optimizationBody.items.map((item) => [item.sourceIssueNumber, item]))
        }
        setState({ loading: false, error: "", result: body.result, optimizations })
      } catch (error) {
        if (!controller.signal.aborted) setState({ loading: false, error: error instanceof Error ? error.message : "加载下钻数据失败", optimizations: {} })
      }
    })()
    return () => controller.abort()
  }, [repository.gitServerId, repository.id, repository.serverRepoId, selection, slug])

  async function createOptimization(sourceIssueNumber: number) {
    if (!repository.gitServerId || !repository.serverRepoId || creatingIssueNumber) return
    setCreatingIssueNumber(sourceIssueNumber)
    try {
      const result = await api<{ issue: { number: number; webUrl?: string } }>(
        `/api/issues/${encodeURIComponent(repository.gitServerId)}/${encodeURIComponent(repository.serverRepoId)}/${sourceIssueNumber}/automation-optimization`,
        { method: "POST", body: "{}" },
      )
      setState((current) => ({
        ...current,
        optimizations: {
          ...current.optimizations,
          [sourceIssueNumber]: {
            ...current.optimizations[sourceIssueNumber],
            sourceIssueNumber,
            status: "analyzing",
            optimizationIssueNumber: result.issue.number,
            optimizationIssueUrl: result.issue.webUrl || "",
          },
        },
      }))
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "创建优化 Issue 失败" }))
    } finally {
      setCreatingIssueNumber(0)
    }
  }

  const rows = state.result?.rows || []
  const bucket = selection.params.bucket || ""
  const week = selection.params.week || ""
  const kind = (selection.panel.drillConfig?.kind || "issues") as DrillKind
  const first = rows[0] || {}
  const total = metricNumber(first.total_count) ?? rows.length
  const weekly = metricNumber(first.weekly_count)
  const summaryItems = buildSummaryItems(kind, first, total, weekly, state.loading)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="metrics-drill-sheet data-[side=right]:sm:max-w-[46rem]">
        <SheetHeader className="metrics-drill-header">
          <div className="metrics-drill-context">
            <i data-bucket={bucket} aria-hidden="true" />
            <span>{selection.panel.title}</span>
          </div>
          <SheetTitle>{drillTitle(kind, bucket)}</SheetTitle>
          <SheetDescription>
            {week ? `${week} 当周` : ""}
            {!state.loading && rows.length > 0
              ? weekly === null
                ? ` · ${total} issues`
                : ` · ${total} / ${weekly} issues`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <MetricsDrillSummary items={summaryItems} />

        <div className="metrics-drill-body">
          {state.loading && <DrillState icon={<Loader2 className="size-4 animate-spin" />} text="正在查询构成明细..." />}
          {state.error && <DrillState text={state.error} tone="error" />}
          {!state.loading && !state.error && rows.length === 0 && <DrillState text="这个区间没有 issue" />}
          {!state.loading && !state.error && rows.length > 0 && (
            <IssueEvidenceList repository={repository} rows={rows} kind={kind} optimizations={state.optimizations} creatingIssueNumber={creatingIssueNumber} returnTo={returnTo} onCreateOptimization={createOptimization} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MetricsDrillSummary({ items }: { items: SummaryItem[] }) {
  return (
    <dl className="metrics-drill-summary" aria-live="polite">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function IssueEvidenceList({
  repository,
  rows,
  kind,
  optimizations,
  creatingIssueNumber,
  returnTo,
  onCreateOptimization,
}: {
  repository: Repository
  rows: MetricsQueryResult["rows"]
  kind: DrillKind
  optimizations: Record<number, AutomationOptimizationItem>
  creatingIssueNumber: number
  returnTo: string
  onCreateOptimization: (issueNumber: number) => Promise<void>
}) {
  const columns = drillColumns(kind)
  return (
    <section className="metrics-drill-evidence" aria-label="构成 issue">
      <header className="metrics-drill-columns" data-kind={kind} aria-hidden="true">
        {columns.map((column) => <span key={column}>{column}</span>)}
      </header>
      <ol className="metrics-drill-list">
        {rows.map((row) => {
          const issueNumber = Number(row.issue_number || 0)
          const href = issueFlowIssueHref(repository, issueNumber, returnTo)
          const title = String(row.title || "-")
          return (
            <li key={String(row.issue_row_id || issueNumber)} className="metrics-drill-item" data-kind={kind}>
              <div className="metrics-drill-identity">
                <span>#{issueNumber}</span>
                {href
                  ? (
                    <a
                      className="metrics-drill-issue-link"
                      href={href}
                      aria-label={`打开 issue #${issueNumber}：${title}`}
                      title={title}
                    >
                      {title}
                    </a>
                  )
                  : <strong title={title}>{title}</strong>}
                <div>
                  {kind !== "issue_type" && <EvidenceTag value={row.type} prefix="type" />}
                  <EvidenceTag value={row.priority} prefix="priority" />
                  <EvidenceTag value={row.size} prefix="size" fallback="未标注" />
                </div>
                <AutomationOptimizationAction
                  item={optimizations[issueNumber]}
                  creating={creatingIssueNumber === issueNumber}
                  onCreate={() => onCreateOptimization(issueNumber)}
                />
              </div>
              <IssueSecondaryFacts row={row} kind={kind} />
              {kind === "issue_type"
                ? <IssueComplexity row={row} />
                : <IssueDuration row={row} />}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function AutomationOptimizationAction({ item, creating, onCreate }: { item?: AutomationOptimizationItem; creating: boolean; onCreate: () => Promise<void> }) {
  if (!item || item.status === "unavailable") return null
  const phases = item.phases.map((phase) => `${phase.phase} ${phase.turns}`).join(" · ")
  if (item.status === "available") {
    return <button type="button" className="metrics-optimization-action" title={phases} disabled={creating} onClick={() => void onCreate()}>{creating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}{creating ? "正在创建" : "分析优化"}</button>
  }
  const content = item.status === "analyzing"
    ? <><Loader2 className="size-3.5 animate-spin" />正在分析优化</>
    : <><Check className="size-3.5" />已分析优化</>
  return <span className={`metrics-optimization-status is-${item.status}`} title={phases}>{content}</span>
}

function issueFlowIssueHref(repository: Repository, issueNumber: number, returnTo: string) {
  if (!repository.gitServerId || !repository.serverRepoId || !issueNumber) return ""
  const params = new URLSearchParams({ returnTo })
  return `/repos/${encodeURIComponent(repository.gitServerId)}/${encodeURIComponent(repository.serverRepoId)}/issues/${issueNumber}?${params}`
}

function IssueSecondaryFacts({ row, kind }: { row: Record<string, unknown>; kind: DrillKind }) {
  if (kind === "issue_type") {
    return (
      <dl className="metrics-drill-status-facts">
        <div><dt>Status</dt><dd>{String(row.status || "-")}</dd></div>
        <div><dt>Flow</dt><dd>{row.flow ? String(row.flow) : "-"}</dd></div>
      </dl>
    )
  }
  if (kind === "issue_turns") {
    return (
      <dl className="metrics-drill-stage-turns">
        <div><dt>Create</dt><dd>{formatInteger(row.create_turns)}</dd></div>
        <div><dt>General</dt><dd>{formatInteger(row.general_turns)}</dd></div>
        <div><dt>Triage</dt><dd>{formatInteger(row.triage_turns)}</dd></div>
        <div><dt>Plan</dt><dd>{formatInteger(row.plan_turns)}</dd></div>
        <div><dt>Build</dt><dd>{formatInteger(row.build_turns)}</dd></div>
        <div><dt>Review</dt><dd>{formatInteger(row.review_turns)}</dd></div>
        <div><dt>Other</dt><dd>{formatInteger(row.other_turns)}</dd></div>
      </dl>
    )
  }
  return <IssueComplexity row={row} />
}

function IssueComplexity({ row }: { row: Record<string, unknown> }) {
  return (
    <dl className="metrics-drill-complexity">
      <div><dt>Turns</dt><dd>{formatInteger(row.task_turns)}</dd></div>
      <div><dt>Agent</dt><dd>{formatPercent(row.agent_execution_pct)}</dd></div>
    </dl>
  )
}

function IssueDuration({ row }: { row: Record<string, unknown> }) {
  return (
    <div className="metrics-drill-duration">
      <strong>{formatDuration(metricNumber(row.duration_seconds))}</strong>
      <small>{formatTimeline(row.opened_at, row.resolved_at)}</small>
    </div>
  )
}

function EvidenceTag({ value, prefix, fallback = "" }: { value: unknown; prefix: string; fallback?: string }) {
  const text = String(value || "").trim() || fallback
  if (!text) return null
  return <span>{`${prefix}::${text}`}</span>
}

function DrillState({ icon, text, tone = "muted" }: { icon?: ReactNode; text: string; tone?: "muted" | "error" }) {
  return <div className={`metrics-drill-state ${tone}`}>{icon}{text}</div>
}

function drillTitle(kind: DrillKind, bucket: string) {
  if (kind === "issue_type") {
    return bucket === "未分类" ? "未分类 issues" : `${bucket.replace(/^type::/, "")} issues`
  }
  if (kind === "issue_turns") return bucket === "0" ? "0 turns" : `${bucket} turns`
  if (bucket === "open") return "仍未完成"
  if (bucket === "drop") return "已丢弃"
  if (bucket === "7d+") return "超过 7d 完成"
  return `${bucket} 内完成`
}

function drillColumns(kind: DrillKind) {
  if (kind === "issue_type") return ["Issue", "状态", "复杂度"]
  if (kind === "issue_turns") return ["Issue", "阶段 Turns", "生命周期"]
  return ["Issue", "复杂度", "生命周期"]
}

function buildSummaryItems(
  kind: DrillKind,
  row: Record<string, unknown>,
  total: number,
  weekly: number | null,
  loading: boolean,
): SummaryItem[] {
  if (kind === "issue_type") {
    return summaryItems(
      ["本周占比", "加权规模", "完成率"],
      loading
        ? ["-", "-", "-"]
        : [formatShare(total, weekly), formatDecimal(row.weighted_total), formatShare(metricNumber(row.done_count) || 0, total)],
    )
  }
  if (kind === "issue_turns") {
    return summaryItems(
      ["本周占比", "桶内中位", "本周 P80"],
      loading
        ? ["-", "-", "-"]
        : [formatShare(total, weekly), formatTurns(row.task_turns_p50), formatTurns(row.task_turns_p80)],
    )
  }
  return summaryItems(
    ["本周占比", "中位耗时", "最长耗时"],
    loading
      ? ["-", "-", "-"]
      : [
          formatShare(total, weekly),
          formatDuration(metricNumber(row.duration_p50_seconds)),
          formatDuration(metricNumber(row.duration_max_seconds)),
        ],
  )
}

function summaryItems(labels: string[], values: string[]) {
  return labels.map((label, index) => ({ label, value: values[index] || "-" }))
}

function formatShare(value: number, total: number | null) {
  if (!total) return "-"
  const percent = value * 100 / total
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function formatDuration(value: number | null) {
  return value === null ? "-" : formatSeconds(value)
}

function metricNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function formatInteger(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? String(Math.max(0, Math.round(number))) : "-"
}

function formatDecimal(value: unknown) {
  const number = metricNumber(value)
  if (number === null) return "-"
  return Number.isInteger(number) ? String(number) : number.toFixed(1)
}

function formatTurns(value: unknown) {
  const formatted = formatDecimal(value)
  return formatted === "-" ? formatted : `${formatted} turns`
}

function formatPercent(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "-"
  return `${Math.max(0, Math.min(100, Math.round(number)))}%`
}

function formatTimeline(openedAt: unknown, resolvedAt: unknown) {
  const opened = formatDateTime(openedAt)
  const resolved = resolvedAt ? formatDateTime(resolvedAt) : "至今"
  return `${opened} → ${resolved}`
}

function formatDateTime(value: unknown) {
  const date = new Date(String(value || ""))
  if (Number.isNaN(date.getTime())) return "-"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
}
