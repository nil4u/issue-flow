import type { ReactNode } from "react"
import { ExternalLink, Eye, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { IssueRow, ReviewablePlanArtifact } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

import { emptyIssueFilters, issueLane, issueLanes, type IssueFilters } from "./issue-view-model"
import { IssueMetric } from "./issue-metrics"

export function IssuesList({
  issues,
  filters,
  options,
  activeFilterCount,
  onFilters,
  issueHref,
  reviewArtifacts,
  reviewHref,
}: {
  issues: IssueRow[]
  filters: IssueFilters
  options: { type: string[]; priority: string[]; size: string[] }
  activeFilterCount: number
  onFilters: (filters: IssueFilters) => void
  issueHref: (issueNumber: number) => string
  reviewArtifacts: ReviewablePlanArtifact[]
  reviewHref: (issueNumber: number) => string
}) {
  return (
    <>
      <IssueListFilters
        filters={filters}
        options={options}
        activeFilterCount={activeFilterCount}
        onFilters={onFilters}
      />
      <IssueListTable issues={issues} issueHref={issueHref} reviewArtifacts={reviewArtifacts} reviewHref={reviewHref} />
    </>
  )
}

function IssueListFilters({
  filters,
  options,
  activeFilterCount,
  onFilters,
}: {
  filters: IssueFilters
  options: { type: string[]; priority: string[]; size: string[] }
  activeFilterCount: number
  onFilters: (filters: IssueFilters) => void
}) {
  const updateFilter = (key: keyof IssueFilters, value: string) => onFilters({ ...filters, [key]: value })

  return (
    <section className="issue-list-filters" aria-label="Issue filters">
      <label className="issue-search-field">
        <Search className="size-4" />
        <input
          value={filters.query}
          onChange={(event) => updateFilter("query", event.target.value)}
          placeholder="搜索标题、编号或标签"
        />
      </label>
      <IssueSelect label="Flow" value={filters.flow} onValueChange={(value) => updateFilter("flow", value)}>
        {issueLanes.map((lane) => <SelectItem key={lane.id} value={lane.id}>{lane.title}</SelectItem>)}
      </IssueSelect>
      <IssueSelect label="Type" value={filters.type} onValueChange={(value) => updateFilter("type", value)}>
        {options.type.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
      </IssueSelect>
      <IssueSelect label="Priority" value={filters.priority} onValueChange={(value) => updateFilter("priority", value)}>
        {options.priority.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
      </IssueSelect>
      <IssueSelect label="Size" value={filters.size} onValueChange={(value) => updateFilter("size", value)}>
        {options.size.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}
      </IssueSelect>
      <Button type="button" variant="ghost" size="sm" onClick={() => onFilters(emptyIssueFilters)} disabled={activeFilterCount === 0}>
        <X className="size-4" />
        清除{activeFilterCount > 0 ? ` ${activeFilterCount}` : ""}
      </Button>
    </section>
  )
}

function IssueSelect({
  label,
  value,
  onValueChange,
  children,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  children: ReactNode
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger size="sm" className="issue-filter-select" aria-label={`${label} filter`}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{label}: 全部</SelectItem>
        {children}
      </SelectContent>
    </Select>
  )
}

function IssueListTable({ issues, issueHref, reviewArtifacts, reviewHref }: { issues: IssueRow[]; issueHref: (issueNumber: number) => string; reviewArtifacts: ReviewablePlanArtifact[]; reviewHref: (issueNumber: number) => string }) {
  if (issues.length === 0) {
    return <div className="issue-list-empty">没有匹配的 issue</div>
  }

  return (
    <div className="issue-list-panel">
      <table className="issue-list-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Flow</th>
            <th>Type</th>
            <th>Priority</th>
            <th>Size</th>
            <th>Turns</th>
            <th>Agent execution</th>
            <th>Updated</th>
            <th className="issue-link-cell"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => <IssueListRow key={issue.id} issue={issue} href={issueHref(issue.issueNumber)} reviewArtifacts={reviewArtifacts.filter((artifact) => artifact.issueNumber === issue.issueNumber)} reviewHref={reviewHref} />)}
        </tbody>
      </table>
    </div>
  )
}

function IssueListRow({ issue, href, reviewArtifacts, reviewHref }: { issue: IssueRow; href: string; reviewArtifacts: ReviewablePlanArtifact[]; reviewHref: (issueNumber: number) => string }) {
  const lane = issueLane(issue)

  return (
    <tr>
      <td>
        <span className="issue-list-title">
          <strong>#{issue.issueNumber}</strong>
          <span>{issue.title || "-"}</span>
        </span>
      </td>
      <td><span className="issue-flow-pill">{lane.title}</span></td>
      <td>{issue.type || "-"}</td>
      <td>{issue.priority || "-"}</td>
      <td>{issue.size || "-"}</td>
      <td className="issue-metric-cell"><IssueMetric issue={issue} kind="turns" plain /></td>
      <td className="issue-metric-cell"><IssueMetric issue={issue} kind="agentTime" plain /></td>
      <td>{formatWhen(issue.updatedAt || issue.openedAt || "") || "-"}</td>
      <td className="issue-link-cell">
        {reviewArtifacts.map((artifact) => (
          <a key={artifact.type} className="issue-review-link" href={reviewHref(issue.issueNumber)} title={artifact.type === "decision" ? "查看决策" : "查看方案"}>
            <Eye className="size-4" />
            <span>{artifact.type === "decision" ? "Decision" : "Plan"}</span>
          </a>
        ))}
        <a
          className="issue-external-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在 Git server 中打开 issue #${issue.issueNumber}`}
          title="在 Git server 中打开"
        >
          <ExternalLink className="size-4" />
        </a>
      </td>
    </tr>
  )
}
