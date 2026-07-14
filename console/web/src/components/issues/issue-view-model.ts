import type { IssueRow } from "@/issue-flow-model"

export type IssueLane = {
  id: string
  title: string
  detail: string
}

export type IssueFilters = {
  query: string
  flow: string
  type: string
  priority: string
  size: string
}

export const issueLanes: IssueLane[] = [
  { id: "untriaged", title: "No flow", detail: "无 flow:: 标签" },
  { id: "triage", title: "Triage", detail: "flow::triage" },
  { id: "plan", title: "Plan", detail: "flow::plan" },
  { id: "build", title: "Build", detail: "flow::build" },
  { id: "clarify", title: "Clarify", detail: "flow::clarify" },
  { id: "approve", title: "Approve", detail: "flow::approve" },
]

export const emptyIssueFilters: IssueFilters = {
  query: "",
  flow: "all",
  type: "all",
  priority: "all",
  size: "all",
}

export function activeIssueFilters(filters: IssueFilters) {
  return [
    filters.query.trim(),
    filters.flow !== "all",
    filters.type !== "all",
    filters.priority !== "all",
    filters.size !== "all",
  ].filter(Boolean).length
}

export function openActiveIssues(issues: IssueRow[]) {
  return issues.filter((issue) => {
    return String(issue.state || "").toLowerCase() === "opened" && String(issue.status || "").toLowerCase() === "active"
  })
}

export function issueLaneId(issue: IssueRow) {
  const flow = String(issue.currentFlow || "").toLowerCase()
  return issueLanes.some((lane) => lane.id === flow) ? flow : "untriaged"
}

export function issueLane(issue: IssueRow) {
  return issueLanes.find((lane) => lane.id === issueLaneId(issue)) || issueLanes[0]
}

export function groupIssuesByLane(issues: IssueRow[]) {
  const map = new Map(issueLanes.map((lane) => [lane.id, [] as IssueRow[]]))
  for (const issue of issues) {
    map.get(issueLaneId(issue))?.push(issue)
  }
  return map
}

export function sortIssuesByUpdatedDesc(issues: IssueRow[]) {
  return [...issues].sort((a, b) => Number(new Date(b.updatedAt || 0).getTime()) - Number(new Date(a.updatedAt || 0).getTime()))
}

export function issueWebUrl(projectWebUrl: string, provider: string, issueNumber: number) {
  const baseUrl = projectWebUrl.replace(/\/+$/, "")
  if (!baseUrl || issueNumber <= 0) return ""
  const issuePath = provider.toLowerCase() === "github" ? "issues" : "-/issues"
  return `${baseUrl}/${issuePath}/${issueNumber}`
}

export function issueFilterOptions(issues: IssueRow[]) {
  return {
    type: uniqueOptions(issues, "type"),
    priority: uniqueOptions(issues, "priority"),
    size: uniqueOptions(issues, "size"),
  }
}

export function filterIssues(issues: IssueRow[], filters: IssueFilters) {
  return issues.filter((issue) => {
    return matchesIssueQuery(issue, filters.query)
      && (filters.flow === "all" || issueLaneId(issue) === filters.flow)
      && matchesFilter(issue.type, filters.type)
      && matchesFilter(issue.priority, filters.priority)
      && matchesFilter(issue.size, filters.size)
  })
}

function filterValue(value?: string) {
  return String(value || "").trim()
}

function uniqueOptions(issues: IssueRow[], key: "type" | "priority" | "size") {
  return Array.from(new Set(issues.map((issue) => filterValue(issue[key])).filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function matchesFilter(value: string | undefined, expected: string) {
  return expected === "all" || filterValue(value).toLowerCase() === expected.toLowerCase()
}

function matchesIssueQuery(issue: IssueRow, query: string) {
  const text = [
    `#${issue.issueNumber}`,
    issue.title,
    issue.type,
    issue.priority,
    issue.size,
    issue.currentFlow,
  ].join(" ").toLowerCase()
  return text.includes(query.trim().toLowerCase())
}
