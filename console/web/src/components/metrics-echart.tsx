import * as echarts from "echarts"
import { useEffect, useRef } from "react"

import type { EChartsOption } from "@/lib/metrics-chart-options"

export function EChart({
  option,
  className,
  onDataClick,
}: {
  option: EChartsOption
  className?: string
  onDataClick?: (params: Record<string, unknown>) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<ReturnType<typeof echarts.init>>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = echarts.init(containerRef.current)
    chartRef.current = chart
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true })
  }, [option])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onDataClick) return
    const handleClick = (params: unknown) => onDataClick(params as Record<string, unknown>)
    chart.on("click", handleClick)
    return () => {
      chart.off("click", handleClick)
    }
  }, [onDataClick])

  return <div ref={containerRef} className={className || "metrics-chart"} />
}
