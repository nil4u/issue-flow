import type { DashboardPanel, MetricsQueryResult } from "@/issue-flow-model"

const BUCKET_COLORS: Record<string, string> = {
  "1d": "#22c55e",
  "2d": "#4ade80",
  "3d": "#a3e635",
  "4d": "#facc15",
  "5d": "#fb923c",
  "6d": "#f97316",
  "7d": "#ef4444",
  "7d+": "#b91c1c",
  open: "#94a3b8",
  drop: "#1f2937",
}

const LINE_COLORS = ["#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"]
const BAR_COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444"]

export function formatSeconds(value: unknown) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return String(value ?? "")
  const abs = Math.abs(seconds)
  if (abs >= 2 * 86400) return `${(seconds / 86400).toFixed(1)}d`
  if (abs >= 2 * 3600) return `${(seconds / 3600).toFixed(1)}h`
  if (abs >= 120) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds)}s`
}

function formatMetricValue(value: unknown, unit: string) {
  if (unit === "seconds") return formatSeconds(value)
  if (unit === "days") {
    const days = Number(value)
    return Number.isFinite(days) ? `${days.toFixed(1)}d` : String(value ?? "")
  }
  const num = Number(value)
  if (Number.isFinite(num)) return Number.isInteger(num) ? String(num) : num.toFixed(1)
  return String(value ?? "")
}

function xLabel(value: unknown) {
  const raw = String(value ?? "")
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  return raw
}

function distinct(values: string[]) {
  return Array.from(new Set(values))
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

export type EChartsOption = Record<string, unknown>
type SeriesEntry = Record<string, unknown>

function stackOrderOf(panel: DashboardPanel, values: string[]) {
  const configured = Array.isArray(panel.visualConfig?.stackOrder)
    ? (panel.visualConfig?.stackOrder as string[])
    : []
  const ordered = configured.filter((name) => values.includes(name))
  const extras = values.filter((name) => !ordered.includes(name))
  return [...ordered, ...extras]
}

function baseOption(panel: DashboardPanel, xs: string[]): EChartsOption {
  const yUnit = String(panel.visualConfig?.yUnit || "")
  const y2Unit = String(panel.visualConfig?.y2Unit || "")
  const hasY2 = (panel.y2Fields || []).length > 0
  return {
    tooltip: { trigger: "axis", confine: true },
    legend: { bottom: 0, type: "scroll", icon: "roundRect", itemWidth: 12, itemHeight: 8 },
    grid: { left: 48, right: hasY2 ? 56 : 24, top: 36, bottom: 44, containLabel: false },
    xAxis: { type: "category", data: xs, axisTick: { show: false } },
    yAxis: [
      {
        type: "value",
        axisLabel: { formatter: (value: number) => formatMetricValue(value, yUnit) },
        splitLine: { lineStyle: { opacity: 0.4 } },
      },
      ...(hasY2
        ? [{
          type: "value" as const,
          axisLabel: { formatter: (value: number) => formatMetricValue(value, y2Unit) },
          splitLine: { show: false },
        }]
        : []),
    ],
  }
}

function fieldLabel(panel: DashboardPanel, field: string) {
  const fieldLabels = (panel.visualConfig?.fieldLabels || {}) as Record<string, string>
  return fieldLabels[field] || field
}

function y2LineSeries(panel: DashboardPanel, rows: MetricsQueryResult["rows"], xs: string[], xField: string) {
  return (panel.y2Fields || []).map((field, index) => ({
    id: `line:${field}`,
    name: fieldLabel(panel, field),
    type: "line",
    yAxisIndex: 1,
    symbol: "circle",
    symbolSize: 6,
    connectNulls: true,
    lineStyle: { width: 2 },
    color: LINE_COLORS[index % LINE_COLORS.length],
    data: xs.map((x) => {
      const row = rows.find((item) => xLabel(item[xField]) === x && numberOrNull(item[field]) !== null)
      return row ? numberOrNull(row[field]) : null
    }),
  }))
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function tooltipRow(marker: unknown, name: string, value: string) {
  return `<div style="display:flex;align-items:center;gap:6px;min-width:9rem;">${String(marker || "")}<span>${escapeHtml(name)}</span><span style="margin-left:auto;font-weight:600;">${escapeHtml(value)}</span></div>`
}

type StackBreakdown = Map<string, Array<{ bucket: string; value: number }>>

function breakdownKey(x: string, field: string) {
  return `${x}::${field}`
}

function bucketMarker(bucket: string) {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${BUCKET_COLORS[bucket] || "#999"};"></span>`
}

function stackedItemTooltipFormatter(panel: DashboardPanel, breakdown: StackBreakdown) {
  const yUnit = String(panel.visualConfig?.yUnit || "")
  const y2Unit = String(panel.visualConfig?.y2Unit || "")
  const fieldLabels = (panel.visualConfig?.fieldLabels || {}) as Record<string, string>
  return (input: unknown) => {
    const params = (Array.isArray(input) ? input[0] : input) as Record<string, unknown>
    const id = String(params?.seriesId || "")
    const x = String(params?.name || "")
    if (id.startsWith("line:")) {
      const value = numberOrNull(params.value)
      if (value === null) return ""
      return [
        `<div style="margin-bottom:4px;font-weight:600;">${escapeHtml(x)}</div>`,
        tooltipRow(params.marker, String(params.seriesName || ""), formatMetricValue(value, y2Unit)),
      ].join("")
    }
    if (!id.startsWith("bar:")) return ""
    const [, field, hoveredBucket] = id.split(":")
    const entries = breakdown.get(breakdownKey(x, field)) || []
    const total = entries.reduce((sum, entry) => sum + entry.value, 0)
    const label = fieldLabels[field] || field
    const lines = [`<div style="margin-bottom:4px;font-weight:600;">${escapeHtml(x)} · ${escapeHtml(label)}</div>`]
    for (const entry of entries) {
      const pct = total > 0 ? ` (${((entry.value / total) * 100).toFixed(1)}%)` : ""
      const emphasis = entry.bucket === hoveredBucket
        ? "background:rgba(15,23,42,.08);border-radius:6px;font-weight:700;"
        : ""
      lines.push(
        `<div style="display:flex;align-items:center;gap:6px;min-width:11rem;padding:2px 4px;${emphasis}">${bucketMarker(entry.bucket)}<span>${escapeHtml(entry.bucket)}</span><span style="margin-left:auto;">${escapeHtml(formatMetricValue(entry.value, yUnit))}${pct}</span></div>`,
      )
    }
    lines.push(
      `<div style="display:flex;gap:6px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(128,128,128,.35);"><span>合计</span><span style="margin-left:auto;font-weight:600;">${escapeHtml(formatMetricValue(total, yUnit))}</span></div>`,
    )
    return lines.join("")
  }
}

function stackTotals(breakdown: StackBreakdown, xs: string[], field: string) {
  return xs.map((x) => {
    const entries = breakdown.get(breakdownKey(x, field)) || []
    return entries.reduce((sum, entry) => sum + entry.value, 0)
  })
}

function stackTotalLabelSeries(xs: string[], totals: number[], field: string) {
  return {
    id: `bar-total:${field}`,
    name: "总数",
    type: "bar",
    stack: field,
    barMaxWidth: 28,
    silent: true,
    tooltip: { show: false },
    itemStyle: { color: "transparent" },
    emphasis: { disabled: true },
    label: {
      show: true,
      position: "top",
      distance: 4,
      color: "#0f172a",
      fontSize: 12,
      fontWeight: 700,
      formatter: (params: { data?: { total?: number } }) => {
        const total = Number(params.data?.total || 0)
        return total > 0 ? formatMetricValue(total, "") : ""
      },
    },
    data: xs.map((_, index) => ({ value: 0, total: totals[index] || 0 })),
  }
}

function stackedBarOption(panel: DashboardPanel, result: MetricsQueryResult): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const stackField = panel.stackField || ""
  const xs = distinct(rows.map((row) => xLabel(row[xField])))
  const stacks = stackOrderOf(panel, distinct(rows.map((row) => String(row[stackField] ?? ""))))
  const yFields = panel.yFields || []
  const series: SeriesEntry[] = []
  const breakdown: StackBreakdown = new Map()
  for (const field of yFields) {
    for (const stackValue of stacks) {
      const data = xs.map((x) => {
        let total = 0
        let found = false
        for (const row of rows) {
          if (xLabel(row[xField]) !== x || String(row[stackField] ?? "") !== stackValue) continue
          const value = numberOrNull(row[field])
          if (value === null) continue
          total += value
          found = true
        }
        return found ? total : 0
      })
      xs.forEach((x, index) => {
        const value = data[index]
        if (!value) return
        const key = breakdownKey(x, field)
        if (!breakdown.has(key)) breakdown.set(key, [])
        breakdown.get(key)?.push({ bucket: stackValue, value })
      })
      series.push({
        id: `bar:${field}:${stackValue}`,
        name: stackValue,
        type: "bar",
        stack: field,
        barMaxWidth: 28,
        color: BUCKET_COLORS[stackValue],
        emphasis: { focus: "series" },
        data,
      })
    }
  }
  for (const field of yFields) {
    if (field) {
      series.push(stackTotalLabelSeries(xs, stackTotals(breakdown, xs, field), field))
    }
  }
  series.push(...y2LineSeries(panel, rows, xs, xField))
  return {
    ...baseOption(panel, xs),
    legend: {
      bottom: 0,
      type: "scroll",
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 8,
      data: [...stacks, ...(panel.y2Fields || []).map((field) => fieldLabel(panel, field))],
    },
    tooltip: {
      trigger: "item",
      confine: true,
      formatter: stackedItemTooltipFormatter(panel, breakdown),
    },
    series,
  } as EChartsOption
}

function barOption(panel: DashboardPanel, result: MetricsQueryResult): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const xs = distinct(rows.map((row) => xLabel(row[xField])))
  const yUnit = String(panel.visualConfig?.yUnit || "")
  const series: SeriesEntry[] = (panel.yFields || []).map((field, index) => ({
    name: field,
    type: "bar",
    barMaxWidth: 36,
    color: BAR_COLORS[index % BAR_COLORS.length],
    data: xs.map((x) => {
      const row = rows.find((item) => xLabel(item[xField]) === x)
      return row ? numberOrNull(row[field]) : null
    }),
  }))
  series.push(...y2LineSeries(panel, rows, xs, xField))
  const option = baseOption(panel, xs)
  return {
    ...option,
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      confine: true,
      valueFormatter: (value: unknown) => formatMetricValue(value, yUnit),
    },
    series,
  } as EChartsOption
}

function lineOption(panel: DashboardPanel, result: MetricsQueryResult): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const seriesField = panel.seriesField || ""
  const xs = distinct(rows.map((row) => xLabel(row[xField])))
  const series: SeriesEntry[] = []
  if (seriesField) {
    const groups = distinct(rows.map((row) => String(row[seriesField] ?? "")))
    const field = (panel.yFields || [])[0] || ""
    for (const [index, group] of groups.entries()) {
      series.push({
        name: group,
        type: "line",
        symbol: "circle",
        connectNulls: true,
        color: LINE_COLORS[index % LINE_COLORS.length],
        data: xs.map((x) => {
          const row = rows.find((item) => xLabel(item[xField]) === x && String(item[seriesField] ?? "") === group)
          return row ? numberOrNull(row[field]) : null
        }),
      })
    }
  } else {
    for (const [index, field] of (panel.yFields || []).entries()) {
      series.push({
        name: field,
        type: "line",
        symbol: "circle",
        connectNulls: true,
        color: LINE_COLORS[index % LINE_COLORS.length],
        data: xs.map((x) => {
          const row = rows.find((item) => xLabel(item[xField]) === x)
          return row ? numberOrNull(row[field]) : null
        }),
      })
    }
  }
  series.push(...y2LineSeries(panel, rows, xs, xField))
  return { ...baseOption(panel, xs), series } as EChartsOption
}

export function buildChartOption(panel: DashboardPanel, result: MetricsQueryResult): EChartsOption {
  if (panel.chartType === "stacked_bar" || panel.chartType === "stacked_bar_with_lines") {
    return stackedBarOption(panel, result)
  }
  if (panel.chartType === "line") {
    return lineOption(panel, result)
  }
  return barOption(panel, result)
}
