import type { DashboardPanel, MetricsQueryResult } from "@/issue-flow-model"

const COMPLETION_BUCKET_COLORS: Record<string, string> = {
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

const ISSUE_TYPE_COLORS: Record<string, string> = {
  "type::feature": "#2563eb",
  "type::bug": "#dc2626",
  "type::debt": "#9333ea",
  "type::ops": "#0f766e",
  "未分类": "#64748b",
}

const TASK_TURN_COLORS: Record<string, string> = {
  "0": "#94a3b8",
  "1-3": "#22c55e",
  "4-6": "#84cc16",
  "7-10": "#f59e0b",
  "11-20": "#f97316",
  "20+": "#dc2626",
}

const TASK_ACTION_COLORS: Record<string, string> = {
  create: "#64748b",
  general: "#14b8a6",
  triage: "#0ea5e9",
  plan: "#8b5cf6",
  build: "#22c55e",
  review: "#f59e0b",
}

const TIME_SHARE_COLORS: Record<string, string> = {
  agent: "#2563eb",
  wait: "#94a3b8",
}

const LINE_COLORS = ["#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6"]
const BAR_COLORS = ["#6366f1", "#0ea5e9", "#22c55e", "#f59e0b", "#ef4444"]
const FALLBACK_STACK_COLOR = "#999"
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const LEGEND_STYLE = {
  bottom: 0,
  type: "scroll",
  icon: "roundRect",
  itemWidth: 10,
  itemHeight: 6,
  itemGap: 16,
  textStyle: { color: "#64748b", fontSize: 11 },
}
const TOOLTIP_STYLE = {
  confine: true,
  backgroundColor: "rgba(255, 255, 255, 0.96)",
  borderColor: "#e2e8f0",
  borderWidth: 1,
  padding: [8, 10],
  textStyle: { color: "#0f172a", fontSize: 12 },
  extraCssText: "border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.12);",
}

export function buildWeeklyAxis(weeks: number, to: string) {
  const count = Math.max(1, Math.trunc(weeks))
  const end = new Date(to)
  if (Number.isNaN(end.getTime())) return []

  end.setUTCHours(0, 0, 0, 0)
  end.setUTCDate(end.getUTCDate() - ((end.getUTCDay() + 6) % 7))

  return Array.from({ length: count }, (_, index) => {
    const week = new Date(end.getTime() - (count - index - 1) * WEEK_MS)
    return week.toISOString().slice(0, 10)
  })
}

function compactNumber(value: number) {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

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
  if (unit === "percent") {
    const percent = Number(value)
    return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : String(value ?? "")
  }
  if (unit === "tokens") {
    const tokens = Number(value)
    return Number.isFinite(tokens) ? compactNumber(tokens) : String(value ?? "")
  }
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

function xValues(rows: MetricsQueryResult["rows"], xField: string, sharedXs?: string[]) {
  return sharedXs?.length ? sharedXs : distinct(rows.map((row) => xLabel(row[xField])))
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
    tooltip: { ...TOOLTIP_STYLE, trigger: "axis" },
    legend: LEGEND_STYLE,
    grid: { left: 56, right: 56, top: 32, bottom: 48, containLabel: false },
    xAxis: {
      type: "category",
      data: xs,
      boundaryGap: true,
      axisLine: { lineStyle: { color: "#cbd5e1" } },
      axisTick: {
        show: true,
        alignWithLabel: true,
        interval: 0,
        length: 4,
        lineStyle: { color: "#cbd5e1" },
      },
      axisLabel: {
        color: "#64748b",
        fontSize: 11,
        margin: 10,
        hideOverlap: true,
        formatter: (value: string) => value.slice(5).replace("-", "/"),
      },
    },
    yAxis: [
      {
        type: "value",
        axisLabel: {
          color: "#64748b",
          fontSize: 11,
          formatter: (value: number) => formatMetricValue(value, yUnit),
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "#e2e8f0", opacity: 0.7 } },
      },
      ...(hasY2
        ? [{
          type: "value" as const,
          axisLabel: {
            color: "#64748b",
            fontSize: 11,
            formatter: (value: number) => formatMetricValue(value, y2Unit),
          },
          axisLine: { show: false },
          axisTick: { show: false },
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

function stackColor(value: string) {
  return COMPLETION_BUCKET_COLORS[value]
    || ISSUE_TYPE_COLORS[value]
    || TASK_TURN_COLORS[value]
    || TASK_ACTION_COLORS[value]
    || TIME_SHARE_COLORS[value]
    || FALLBACK_STACK_COLOR
}

function bucketMarker(bucket: string) {
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${stackColor(bucket)};"></span>`
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
    const [, field] = id.split(":")
    const hoveredBucket = String(params.seriesName || "")
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

function stackedBarOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const stackField = panel.stackField || ""
  const xs = xValues(rows, xField, sharedXs)
  const stacks = stackOrderOf(panel, distinct(rows.map((row) => String(row[stackField] ?? ""))))
  const yFields = panel.yFields || []
  const series: SeriesEntry[] = []
  const breakdown: StackBreakdown = new Map()
  for (const field of yFields) {
    for (const [stackIndex, stackValue] of stacks.entries()) {
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
        id: `bar:${field}:${stackIndex}`,
        name: stackValue,
        type: "bar",
        stack: field,
        barMaxWidth: 28,
        color: stackColor(stackValue),
        emphasis: { focus: "series" },
        cursor: panel.drillQuerySql ? "pointer" : "default",
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
      ...LEGEND_STYLE,
      data: [...stacks, ...(panel.y2Fields || []).map((field) => fieldLabel(panel, field))],
    },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "item",
      formatter: stackedItemTooltipFormatter(panel, breakdown),
    },
    series,
  } as EChartsOption
}

function stackedAreaTooltipFormatter(panel: DashboardPanel) {
  const yUnit = String(panel.visualConfig?.yUnit || "")
  const y2Unit = String(panel.visualConfig?.y2Unit || "")
  return (input: unknown) => {
    const params = (Array.isArray(input) ? input : [input]) as Array<Record<string, unknown>>
    const x = String(params[0]?.axisValueLabel || params[0]?.name || "")
    const lines = [`<div style="margin-bottom:4px;font-weight:600;">${escapeHtml(x)}</div>`]
    for (const item of params) {
      const id = String(item.seriesId || "")
      const value = numberOrNull(item.value)
      if (value === null) continue
      const unit = id.startsWith("line:") ? y2Unit : yUnit
      lines.push(tooltipRow(item.marker, String(item.seriesName || ""), formatMetricValue(value, unit)))
    }
    return lines.join("")
  }
}

function stackedAreaOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const stackField = panel.stackField || ""
  const field = (panel.yFields || [])[0] || ""
  const xs = xValues(rows, xField, sharedXs)
  const stacks = stackOrderOf(panel, distinct(rows.map((row) => String(row[stackField] ?? ""))))
  const series: SeriesEntry[] = stacks.map((stackValue) => ({
    id: `area:${field}:${stackValue}`,
    name: stackValue,
    type: "line",
    stack: field,
    symbol: "circle",
    symbolSize: 5,
    smooth: true,
    connectNulls: true,
    color: stackColor(stackValue),
    areaStyle: { opacity: 0.18 },
    lineStyle: { width: 2 },
    emphasis: { focus: "series" },
    data: xs.map((x) => {
      let total = 0
      let found = false
      for (const row of rows) {
        if (xLabel(row[xField]) !== x || String(row[stackField] ?? "") !== stackValue) continue
        const value = numberOrNull(row[field])
        if (value === null) continue
        total += value
        found = true
      }
      return found ? total : null
    }),
  }))
  series.push(...y2LineSeries(panel, rows, xs, xField))
  return {
    ...baseOption(panel, xs),
    legend: {
      ...LEGEND_STYLE,
      data: [...stacks, ...(panel.y2Fields || []).map((lineField) => fieldLabel(panel, lineField))],
    },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      formatter: stackedAreaTooltipFormatter(panel),
    },
    series,
  } as EChartsOption
}

function percentStackedTooltipFormatter(panel: DashboardPanel, breakdown: StackBreakdown) {
  const yUnit = String(panel.visualConfig?.yUnit || "")
  const y2Unit = String(panel.visualConfig?.y2Unit || "")
  return (input: unknown) => {
    const params = (Array.isArray(input) ? input : [input]) as Array<Record<string, unknown>>
    const x = String(params[0]?.axisValueLabel || params[0]?.name || "")
    const entries = breakdown.get(breakdownKey(x, "percent")) || []
    const total = entries.reduce((sum, entry) => sum + entry.value, 0)
    const lines = [`<div style="margin-bottom:4px;font-weight:600;">${escapeHtml(x)}</div>`]
    for (const item of params) {
      const id = String(item.seriesId || "")
      const name = String(item.seriesName || "")
      const value = numberOrNull(item.value)
      if (value === null) continue
      if (id.startsWith("line:")) {
        lines.push(tooltipRow(item.marker, name, formatMetricValue(value, y2Unit)))
        continue
      }
      const entry = entries.find((candidate) => candidate.bucket === name)
      const raw = entry?.value ?? 0
      lines.push(tooltipRow(item.marker, name, `${formatMetricValue(raw, yUnit)} · ${formatMetricValue(value, "percent")}`))
    }
    if (total > 0) {
      lines.push(
        `<div style="display:flex;gap:6px;margin-top:4px;padding-top:4px;border-top:1px solid rgba(128,128,128,.35);"><span>整体</span><span style="margin-left:auto;font-weight:600;">${escapeHtml(formatMetricValue(total, yUnit))}</span></div>`,
      )
    }
    return lines.join("")
  }
}

function percentStackedBarOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const stackField = panel.stackField || ""
  const field = (panel.yFields || [])[0] || ""
  const xs = xValues(rows, xField, sharedXs)
  const stacks = stackOrderOf(panel, distinct(rows.map((row) => String(row[stackField] ?? ""))))
  const breakdown: StackBreakdown = new Map()
  for (const x of xs) {
    const entries = stacks
      .map((stackValue) => {
        let total = 0
        for (const row of rows) {
          if (xLabel(row[xField]) !== x || String(row[stackField] ?? "") !== stackValue) continue
          total += numberOrNull(row[field]) || 0
        }
        return { bucket: stackValue, value: total }
      })
      .filter((entry) => entry.value > 0)
    breakdown.set(breakdownKey(x, "percent"), entries)
  }
  const series: SeriesEntry[] = stacks.map((stackValue) => ({
    id: `percent:${field}:${stackValue}`,
    name: stackValue,
    type: "bar",
    stack: "percent",
    barMaxWidth: 32,
    color: stackColor(stackValue),
    emphasis: { focus: "series" },
    data: xs.map((x) => {
      const entries = breakdown.get(breakdownKey(x, "percent")) || []
      const total = entries.reduce((sum, entry) => sum + entry.value, 0)
      const raw = entries.find((entry) => entry.bucket === stackValue)?.value || 0
      return total > 0 ? Number(((raw / total) * 100).toFixed(2)) : 0
    }),
  }))
  series.push(...y2LineSeries(panel, rows, xs, xField))
  return {
    ...baseOption(panel, xs),
    legend: {
      ...LEGEND_STYLE,
      data: [...stacks, ...(panel.y2Fields || []).map((lineField) => fieldLabel(panel, lineField))],
    },
    tooltip: {
      ...TOOLTIP_STYLE,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: percentStackedTooltipFormatter(panel, breakdown),
    },
    yAxis: [
      {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: {
          color: "#64748b",
          fontSize: 11,
          formatter: (value: number) => formatMetricValue(value, "percent"),
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: "#e2e8f0", opacity: 0.7 } },
      },
      {
        // y2 lines (e.g. share percentage) auto-scale to their own range
        type: "value",
        scale: true,
        axisLabel: {
          color: "#64748b",
          fontSize: 11,
          formatter: (value: number) => formatMetricValue(value, String(panel.visualConfig?.y2Unit || "")),
        },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
    ],
    series,
  } as EChartsOption
}

function barOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const xs = xValues(rows, xField, sharedXs)
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
      ...TOOLTIP_STYLE,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (value: unknown) => formatMetricValue(value, yUnit),
    },
    series,
  } as EChartsOption
}

function lineOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  const rows = result.rows
  const xField = panel.xField || ""
  const seriesField = panel.seriesField || ""
  const xs = xValues(rows, xField, sharedXs)
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

export function buildChartOption(panel: DashboardPanel, result: MetricsQueryResult, sharedXs?: string[]): EChartsOption {
  if (panel.chartType === "stacked_area_with_lines") {
    return stackedAreaOption(panel, result, sharedXs)
  }
  if (panel.chartType === "percent_stacked_bar_with_lines") {
    return percentStackedBarOption(panel, result, sharedXs)
  }
  if (panel.chartType === "stacked_bar" || panel.chartType === "stacked_bar_with_lines") {
    return stackedBarOption(panel, result, sharedXs)
  }
  if (panel.chartType === "line") {
    return lineOption(panel, result, sharedXs)
  }
  return barOption(panel, result, sharedXs)
}
