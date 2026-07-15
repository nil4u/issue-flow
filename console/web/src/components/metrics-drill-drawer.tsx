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

type DrillSummary = {
  total: number
  weekly: number | null
  medianSeconds: number | null
  maxSeconds: number | null
}

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
  const summary = drillSummary(rows)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="metrics-drill-sheet data-[side=right]:sm:max-w-[46rem]">
        <SheetHeader className="metrics-drill-header">
          <div className="metrics-drill-context">
            <i data-bucket={bucket} aria-hidden="true" />
            <span>Issue 完成时间分布</span>
          </div>
          <SheetTitle>{bucketLabel(bucket)}</SheetTitle>
          <SheetDescription>
            {week ? `${week} 当周` : ""}
            {!state.loading && rows.length > 0
              ? summary.weekly === null
                ? ` · ${summary.total} issues`
                : ` · ${summary.total} / ${summary.weekly} issues`
              : ""}
          </SheetDescription>
        </SheetHeader>

        <MetricsDrillSummary loading={state.loading} summary={summary} />

        <div className="metrics-drill-body">
          {state.loading && <DrillState icon={<Loader2 className="size-4 animate-spin" />} text="正在查询构成明细..." />}
          {state.error && <DrillState text={state.error} tone="error" />}
          {!state.loading && !state.error && rows.length === 0 && <DrillState text="这个区间没有 issue" />}
          {!state.loading && !state.error && rows.length > 0 && (
            <IssueEvidenceList repository={repository} rows={rows} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function MetricsDrillSummary({ loading, summary }: { loading: boolean; summary: DrillSummary }) {
  const values = loading
    ? { share: "-", median: "-", longest: "-" }
    : {
        share: formatShare(summary.total, summary.weekly),
        median: formatDuration(summary.medianSeconds),
        longest: formatDuration(summary.maxSeconds),
      }
  return (
    <dl className="metrics-drill-summary" aria-live="polite">
      <div>
        <dt>本周占比</dt>
        <dd>{values.share}</dd>
      </div>
      <div>
        <dt>中位耗时</dt>
        <dd>{values.median}</dd>
      </div>
      <div>
        <dt>最长耗时</dt>
        <dd>{values.longest}</dd>
      </div>
    </dl>
  )
}

function IssueEvidenceList({ repository, rows }: { repository: Repository; rows: MetricsQueryResult["rows"] }) {
  const projectWebUrl = repository.webUrl || repository.url || ""
  const provider = repository.provider || "gitlab"
  return (
    <section className="metrics-drill-evidence" aria-label="构成 issue">
      <header className="metrics-drill-columns" aria-hidden="true">
        <span>Issue</span>
        <span>复杂度</span>
        <span>生命周期</span>
        <span />
      </header>
      <ol className="metrics-drill-list">
        {rows.map((row) => {
          const issueNumber = Number(row.issue_number || 0)
          const href = issueWebUrl(projectWebUrl, provider, issueNumber)
          return (
            <li key={String(row.issue_row_id || issueNumber)} className="metrics-drill-item">
              <div className="metrics-drill-identity">
                <span>#{issueNumber}</span>
                <strong title={String(row.title || "-")}>{String(row.title || "-")}</strong>
                <div>
                  <EvidenceTag value={row.type} prefix="type" />
                  <EvidenceTag value={row.priority} prefix="priority" />
                  <EvidenceTag value={row.size} prefix="size" />
                </div>
              </div>
              <dl className="metrics-drill-complexity">
                <div>
                  <dt>Turns</dt>
                  <dd>{formatInteger(row.task_turns)}</dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{formatPercent(row.agent_execution_pct)}</dd>
                </div>
              </dl>
              <div className="metrics-drill-duration">
                <strong>{formatSeconds(row.duration_seconds)}</strong>
                <small>{formatTimeline(row.opened_at, row.resolved_at)}</small>
              </div>
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

function EvidenceTag({ value, prefix }: { value: unknown; prefix: string }) {
  const text = String(value || "").trim()
  if (!text) return null
  return <span>{`${prefix}::${text}`}</span>
}

function DrillState({ icon, text, tone = "muted" }: { icon?: ReactNode; text: string; tone?: "muted" | "error" }) {
  return <div className={`metrics-drill-state ${tone}`}>{icon}{text}</div>
}

function drillSummary(rows: MetricsQueryResult["rows"]): DrillSummary {
  const first = rows[0] || {}
  return {
    total: metricNumber(first.total_count) ?? rows.length,
    weekly: metricNumber(first.weekly_count),
    medianSeconds: metricNumber(first.duration_p50_seconds),
    maxSeconds: metricNumber(first.duration_max_seconds),
  }
}

function bucketLabel(bucket: string) {
  if (bucket === "open") return "仍未完成"
  if (bucket === "drop") return "已丢弃"
  if (bucket === "7d+") return "超过 7d 完成"
  return `${bucket} 内完成`
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
