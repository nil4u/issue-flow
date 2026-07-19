import { ExternalLink, Eye } from "lucide-react"

import type { IssueRow, ReviewablePlanArtifact } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

import { issueLanes } from "./issue-view-model"
import { IssueMetrics } from "./issue-metrics"

export function IssuesKanban({ groupedIssues, issueHref, reviewArtifacts, reviewHref }: { groupedIssues: Map<string, IssueRow[]>; issueHref: (issueNumber: number) => string; reviewArtifacts: ReviewablePlanArtifact[]; reviewHref: (issueNumber: number, artifactType: "decision" | "plan") => string }) {
  return (
    <div className="issue-board-lanes">
      {issueLanes.map((lane) => (
        <IssueLane key={lane.id} title={lane.title} detail={lane.detail} issues={groupedIssues.get(lane.id) || []} issueHref={issueHref} reviewArtifacts={reviewArtifacts} reviewHref={reviewHref} />
      ))}
    </div>
  )
}

function IssueLane({ title, detail, issues, issueHref, reviewArtifacts, reviewHref }: { title: string; detail: string; issues: IssueRow[]; issueHref: (issueNumber: number) => string; reviewArtifacts: ReviewablePlanArtifact[]; reviewHref: (issueNumber: number, artifactType: "decision" | "plan") => string }) {
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
        {issues.map((issue) => <IssueCard key={issue.id} issue={issue} href={issueHref(issue.issueNumber)} reviewArtifacts={reviewArtifacts.filter((artifact) => artifact.issueNumber === issue.issueNumber)} reviewHref={reviewHref} />)}
      </div>
    </section>
  )
}

function IssueCard({ issue, href, reviewArtifacts, reviewHref }: { issue: IssueRow; href: string; reviewArtifacts: ReviewablePlanArtifact[]; reviewHref: (issueNumber: number, artifactType: "decision" | "plan") => string }) {
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
          {reviewArtifacts.map((artifact) => (
            <a
              key={artifact.type}
              className="issue-review-link"
              href={reviewHref(issue.issueNumber, artifact.type)}
              aria-label={`查看 issue #${issue.issueNumber} 的${artifact.type === "decision" ? "决策" : "方案"}`}
              title={artifact.type === "decision" ? "查看决策" : "查看方案"}
            >
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
