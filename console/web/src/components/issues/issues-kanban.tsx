import { ExternalLink } from "lucide-react"

import type { IssueRow } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

import { issueLanes } from "./issue-view-model"
import { IssueMetrics } from "./issue-metrics"

export function IssuesKanban({ groupedIssues, issueHref }: { groupedIssues: Map<string, IssueRow[]>; issueHref: (issueNumber: number) => string }) {
  return (
    <div className="issue-board-lanes">
      {issueLanes.map((lane) => (
        <IssueLane key={lane.id} title={lane.title} detail={lane.detail} issues={groupedIssues.get(lane.id) || []} issueHref={issueHref} />
      ))}
    </div>
  )
}

function IssueLane({ title, detail, issues, issueHref }: { title: string; detail: string; issues: IssueRow[]; issueHref: (issueNumber: number) => string }) {
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
        {issues.map((issue) => <IssueCard key={issue.id} issue={issue} href={issueHref(issue.issueNumber)} />)}
      </div>
    </section>
  )
}

function IssueCard({ issue, href }: { issue: IssueRow; href: string }) {
  const meta = [
    issue.type ? `type::${issue.type}` : "",
    issue.priority ? `priority::${issue.priority}` : "",
    issue.size ? `size::${issue.size}` : "",
  ].filter(Boolean)

  return (
    <article className="issue-card">
      <header>
        <strong>#{issue.issueNumber}</strong>
        <span className="issue-card-actions">
          <small>{formatWhen(issue.updatedAt || issue.openedAt || "")}</small>
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
        </span>
      </header>
      <p>{issue.title || "-"}</p>
      <IssueMetrics issue={issue} />
      {meta.length > 0 && (
        <div className="issue-card-labels">
          {meta.map((item) => <span key={item}>{item}</span>)}
        </div>
      )}
    </article>
  )
}
