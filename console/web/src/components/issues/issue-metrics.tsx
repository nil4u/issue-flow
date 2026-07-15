import type { IssueRow } from "@/issue-flow-model"

type IssueMetricKind = "turns" | "agentTime"

export function IssueMetrics({ issue }: { issue: IssueRow }) {
  return (
    <div className="issue-metrics" aria-label={`Issue #${issue.issueNumber} agent metrics`}>
      <IssueMetric issue={issue} kind="turns" />
      <IssueMetric issue={issue} kind="agentTime" />
    </div>
  )
}

export function IssueMetric({ issue, kind, plain = false }: { issue: IssueRow; kind: IssueMetricKind; plain?: boolean }) {
  const metric = metricFor(issue, kind)

  return (
    <span className={`issue-metric issue-metric-${kind}${plain ? " issue-metric-plain" : ""}`} title={metric.description}>
      {!plain && <span className="issue-metric-label">{metric.label}</span>}
      <strong className="issue-metric-value">{metric.value}</strong>
    </span>
  )
}

function metricFor(issue: IssueRow, kind: IssueMetricKind) {
  if (kind === "turns") {
    return {
      label: "turns",
      value: formatCount(issue.turnsCount),
      description: "Agent task turns",
    }
  }

  return {
    label: "Agent execution",
    value: formatPercent(issue.agentTimeSharePct),
    description: "Agent execution time / issue lifecycle time",
  }
}

function formatCount(value?: number) {
  return Number.isFinite(value) ? String(Math.max(0, Math.round(Number(value)))) : "-"
}

function formatPercent(value?: number) {
  return Number.isFinite(value) ? `${Math.max(0, Math.min(100, Math.round(Number(value))))}%` : "-"
}
