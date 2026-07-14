import { Loader2, RefreshCw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import { EChart } from "@/components/metrics-echart"
import { buildChartOption, buildWeeklyAxis, formatSeconds } from "@/lib/metrics-chart-options"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  api,
  type DashboardPanel,
  type DashboardView,
  type MetricsQueryResult,
  type Repository,
} from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

const OVERVIEW_DASHBOARD_SLUG = "agent-first-overview"
const DEFAULT_WEEK_OPTIONS = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52]

type PanelParams = {
  weeks: number
  from: string
  to: string
}

export function MetricsBoard({ repository }: { repository: Repository }) {
  const [dashboard, setDashboard] = useState<DashboardView>()
  const [loading, setLoading] = useState(true)
  const [weeks, setWeeks] = useState(8)
  const [refreshedAt, setRefreshedAt] = useState(() => Date.now())

  useEffect(() => {
    void (async () => {
      try {
        const body = await api<{ dashboard: DashboardView }>(`/api/dashboards/${OVERVIEW_DASHBOARD_SLUG}`)
        setDashboard(body.dashboard)
        const weeksDefault = body.dashboard.variables.find((item) => item.name === "weeks")?.defaultValue as
          | { value?: number }
          | undefined
        if (weeksDefault?.value) setWeeks(Number(weeksDefault.value) || 8)
      } catch (error) {
        notifyError(error, "加载度量看板失败")
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const weekOptions = useMemo(() => {
    const weeksDefault = dashboard?.variables.find((item) => item.name === "weeks")?.defaultValue as
      | { options?: number[] }
      | undefined
    return weeksDefault?.options?.length ? weeksDefault.options : DEFAULT_WEEK_OPTIONS
  }, [dashboard])

  const params = useMemo<PanelParams>(() => {
    const to = new Date(refreshedAt)
    const from = new Date(refreshedAt - weeks * 7 * 86400000)
    return { weeks, from: from.toISOString(), to: to.toISOString() }
  }, [weeks, refreshedAt])

  const weekAxis = useMemo(() => buildWeeklyAxis(params.weeks, params.to), [params])

  const panels = useMemo(() => {
    return [...(dashboard?.panels || [])].sort((a, b) => {
      const ay = a.position?.y ?? 0
      const by = b.position?.y ?? 0
      if (ay !== by) return ay - by
      return (a.position?.x ?? 0) - (b.position?.x ?? 0)
    })
  }, [dashboard])

  if (loading) {
    return <div className="metrics-loading"><Loader2 className="size-4 animate-spin" /> 正在加载度量看板...</div>
  }

  if (!dashboard) {
    return <div className="metrics-loading">度量看板不可用，请确认数据库迁移已执行。</div>
  }

  return (
    <div className="metrics-board">
      <div className="metrics-toolbar">
        <span className="metrics-toolbar-label">时间范围</span>
        <div className="metrics-weeks" role="group" aria-label="时间范围">
          {weekOptions.map((option) => (
            <button
              key={option}
              type="button"
              className={`metrics-weeks-option ${weeks === option ? "active" : ""}`}
              onClick={() => setWeeks(option)}
            >
              {option} 周
            </button>
          ))}
        </div>
        <span className="metrics-toolbar-spacer" aria-hidden="true" />
        <Button variant="outline" size="sm" onClick={() => setRefreshedAt(Date.now())}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      <div className="metrics-grid">
        {panels.map((panel) => (
          <MetricsPanel
            key={panel.id}
            repository={repository}
            slug={dashboard.slug}
            panel={panel}
            params={params}
            weekAxis={weekAxis}
          />
        ))}
      </div>
    </div>
  )
}

function MetricsPanel({
  repository,
  slug,
  panel,
  params,
  weekAxis,
}: {
  repository: Repository
  slug: string
  panel: DashboardPanel
  params: PanelParams
  weekAxis: string[]
}) {
  const width = Math.min(Math.max(panel.position?.w ?? 12, 1), 12)
  const height = Math.max(panel.position?.h ?? 8, 4) * 36

  return (
    <section className="metrics-panel" style={{ gridColumn: `span ${width}` }}>
      <header className="metrics-panel-head">
        <h3>{panel.title}</h3>
      </header>
      <div className="metrics-panel-body" style={{ minHeight: height }}>
        <PanelQuery
          key={`${repository.id}:${panel.id}:${params.weeks}:${params.from}`}
          repository={repository}
          slug={slug}
          panel={panel}
          params={params}
          weekAxis={weekAxis}
        />
      </div>
    </section>
  )
}

type PanelQueryState = {
  loading: boolean
  error: string
  result?: MetricsQueryResult
}

function PanelQuery({
  repository,
  slug,
  panel,
  params,
  weekAxis,
}: {
  repository: Repository
  slug: string
  panel: DashboardPanel
  params: PanelParams
  weekAxis: string[]
}) {
  const [state, setState] = useState<PanelQueryState>({ loading: true, error: "" })

  useEffect(() => {
    let cancelled = false
    const path = `/api/repositories/${encodeURIComponent(repository.id)}/dashboards/${encodeURIComponent(slug)}/panels/${encodeURIComponent(panel.id)}/query`
    api<{ result: MetricsQueryResult }>(path, {
      method: "POST",
      body: JSON.stringify({ params }),
    })
      .then((body) => {
        if (!cancelled) setState({ loading: false, error: "", result: body.result })
      })
      .catch((queryError: Error) => {
        if (!cancelled) setState({ loading: false, error: queryError.message || "查询失败" })
      })
    return () => {
      cancelled = true
    }
  }, [repository.id, slug, panel.id, params])

  if (state.loading) {
    return <div className="metrics-loading"><Loader2 className="size-4 animate-spin" /> 查询中...</div>
  }
  if (state.error) {
    return <div className="metrics-error">{state.error}</div>
  }
  if (!state.result) {
    return <div className="metrics-empty">暂无数据</div>
  }
  return (
    <div className="metrics-panel-result">
      {state.result.truncated && <div className="metrics-panel-note">结果已截断（最多 5000 行）</div>}
      <PanelContent panel={panel} result={state.result} weekAxis={weekAxis} />
    </div>
  )
}

function PanelContent({
  panel,
  result,
  weekAxis,
}: {
  panel: DashboardPanel
  result: MetricsQueryResult
  weekAxis: string[]
}) {
  if (!result.rows.length && panel.xField !== "week") {
    return <div className="metrics-empty">暂无数据</div>
  }
  if (panel.chartType === "table") {
    return <PanelTable panel={panel} result={result} />
  }
  if (panel.chartType === "stat") {
    return <PanelStat panel={panel} result={result} />
  }
  const sharedXs = panel.xField === "week" ? weekAxis : undefined
  return <EChart option={buildChartOption(panel, result, sharedXs)} />
}

function PanelStat({ panel, result }: { panel: DashboardPanel; result: MetricsQueryResult }) {
  const field = (panel.yFields || [])[0] || result.columns[0]?.name || ""
  const value = result.rows[0]?.[field]
  return <div className="metrics-stat">{String(value ?? "-")}</div>
}

function PanelTable({ panel, result }: { panel: DashboardPanel; result: MetricsQueryResult }) {
  const durationFields = new Set(
    Array.isArray(panel.visualConfig?.durationFields)
      ? (panel.visualConfig?.durationFields as string[])
      : [],
  )
  return (
    <div className="metrics-table">
      <Table>
        <TableHeader>
          <TableRow>
            {result.columns.map((column) => (
              <TableHead key={column.name}>{column.name}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.rows.map((row, index) => (
            <TableRow key={index}>
              {result.columns.map((column) => (
                <TableCell key={column.name}>
                  {durationFields.has(column.name)
                    ? formatSeconds(row[column.name])
                    : formatCell(row[column.name])}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "-"
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2)
  const raw = String(value)
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10)
  return raw
}
