import { ExternalLink, Loader2 } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { issueWebUrl } from "@/components/issues/issue-view-model"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  api,
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
  const [state, setState] = useState<DrillState>({ loading: true, error: "" })

  useEffect(() => {
    const controller = new AbortController()
    const path = `/api/repositories/${encodeURIComponent(repository.id)}/dashboards/${encodeURIComponent(slug)}/panels/${encodeURIComponent(selection.panel.id)}/drill`
    void api<{ result: MetricsQueryResult }>(path, {
      method: "POST",
      body: JSON.stringify({ params: selection.params }),
      signal: controller.signal,
    })
      .then((body) => setState({ loading: false, error: "", result: body.result }))
      .catch((error: Error) => {
        if (!controller.signal.aborted) setState({ loading: false, error: error.message || "加载下钻数据失败" })
      })
    return () => controller.abort()
  }, [repository.id, selection, slug])

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
            <IssueEvidenceList repository={repository} rows={rows} kind={kind} />
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
}: {
  repository: Repository
  rows: MetricsQueryResult["rows"]
  kind: DrillKind
}) {
  const projectWebUrl = repository.webUrl || repository.url || ""
  const provider = repository.provider || "gitlab"
  const columns = drillColumns(kind)
  return (
    <section className="metrics-drill-evidence" aria-label="构成 issue">
      <header className="metrics-drill-columns" aria-hidden="true">
        {columns.map((column) => <span key={column}>{column}</span>)}
        <span />
      </header>
      <ol className="metrics-drill-list">
        {rows.map((row) => {
          const issueNumber = Number(row.issue_number || 0)
          const href = issueWebUrl(projectWebUrl, provider, issueNumber)
          return (
            <li key={String(row.issue_row_id || issueNumber)} className="metrics-drill-item" data-kind={kind}>
              <div className="metrics-drill-identity">
                <span>#{issueNumber}</span>
                <strong title={String(row.title || "-")}>{String(row.title || "-")}</strong>
                <div>
                  {kind !== "issue_type" && <EvidenceTag value={row.type} prefix="type" />}
                  <EvidenceTag value={row.priority} prefix="priority" />
                  <EvidenceTag value={row.size} prefix="size" fallback="未标注" />
                </div>
              </div>
              <IssueSecondaryFacts row={row} kind={kind} />
              {kind === "issue_type"
                ? <IssueComplexity row={row} />
                : <IssueDuration row={row} />}
              {href && (
                <a
                  className="issue-external-link"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`在 Git server 中打开 issue #${issueNumber}`}
                  title="在 Git server 中打开"
                >
                  <ExternalLink className="size-4" />
                </a>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
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
