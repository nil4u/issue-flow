import type { DashboardPanel } from "@/issue-flow-model"

export function drillParamsFromChartEvent(panel: DashboardPanel, event: Record<string, unknown>) {
  const seriesId = String(event.seriesId || "")
  const xParam = panel.drillConfig?.xParam || ""
  const seriesParam = panel.drillConfig?.seriesParam || ""
  const xValue = String(event.name || "")
  const seriesValue = String(event.seriesName || "")
  const allowedSeries = panel.drillConfig?.allowedSeries || []
  const isBarSegment = seriesId.startsWith("bar:") || seriesId.startsWith("percent:")
  if (!isBarSegment || !xParam || !seriesParam || !xValue || !seriesValue) return undefined
  if (allowedSeries.length && !allowedSeries.includes(seriesValue)) return undefined
  return { [xParam]: xValue, [seriesParam]: seriesValue }
}
