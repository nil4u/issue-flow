import type { ReactNode } from "react"
import { Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { IssueRow } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

import { emptyIssueFilters, issueLane, issueLanes, type IssueFilters } from "./issue-view-model"

export function IssuesList({
  issues,
  filters,
  options,
  activeFilterCount,
  onFilters,
}: {
  issues: IssueRow[]
  filters: IssueFilters
  options: { type: string[]; priority: string[]; size: string[] }
  activeFilterCount: number
  onFilters: (filters: IssueFilters) => void
}) {
  return (
    <>
      <IssueListFilters
        filters={filters}
        options={options}
        activeFilterCount={activeFilterCount}
        onFilters={onFilters}
      />
      <IssueListTable issues={issues} />
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

function IssueListTable({ issues }: { issues: IssueRow[] }) {
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
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => <IssueListRow key={issue.id} issue={issue} />)}
        </tbody>
      </table>
    </div>
  )
}

function IssueListRow({ issue }: { issue: IssueRow }) {
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
      <td>{formatWhen(issue.updatedAt || issue.openedAt || "") || "-"}</td>
    </tr>
  )
}
