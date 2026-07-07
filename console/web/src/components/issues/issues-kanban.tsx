import type { IssueRow } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

import { issueLane, issueLanes } from "./issue-view-model"

export function IssuesKanban({ groupedIssues }: { groupedIssues: Map<string, IssueRow[]> }) {
  return (
    <div className="issue-board-lanes">
      {issueLanes.map((lane) => (
        <IssueLane key={lane.id} title={lane.title} detail={lane.detail} issues={groupedIssues.get(lane.id) || []} />
      ))}
    </div>
  )
}

function IssueLane({ title, detail, issues }: { title: string; detail: string; issues: IssueRow[] }) {
  return (
    <section className="issue-lane">
      <header>
        <span>
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
        <b>{issues.length}</b>
      </header>
      <div className="issue-lane-list">
        {issues.length === 0 && <div className="issue-lane-empty">暂无 issue</div>}
        {issues.map((issue) => <IssueCard key={issue.id} issue={issue} />)}
      </div>
    </section>
  )
}

function IssueCard({ issue }: { issue: IssueRow }) {
  const lane = issueLane(issue)
  const meta = [
    `flow::${lane.id}`,
    issue.type ? `type::${issue.type}` : "",
    issue.priority ? `priority::${issue.priority}` : "",
    issue.size ? `size::${issue.size}` : "",
  ].filter(Boolean)

  return (
    <article className="issue-card">
      <header>
        <strong>#{issue.issueNumber}</strong>
        <small>{formatWhen(issue.updatedAt || issue.openedAt || "")}</small>
      </header>
      <p>{issue.title || "-"}</p>
      {meta.length > 0 && (
        <div className="issue-card-labels">
          {meta.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </article>
  )
}
