import { useMemo } from "react"
import { AlertCircle, CircleDot, GitBranch, GitMerge, Loader2, RefreshCw, Search } from "lucide-react"

import { EmptyPanel } from "@/components/empty-panel"
import { Button } from "@/components/ui/button"
import type { IssueRow, RepoWorkspaceProps } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

const issueLanes = [
  { id: "untriaged", title: "No flow", detail: "无 flow:: 标签" },
  { id: "triage", title: "Triage", detail: "flow::triage" },
  { id: "plan", title: "Plan", detail: "flow::plan" },
  { id: "build", title: "Build", detail: "flow::build" },
  { id: "clarify", title: "Clarify", detail: "flow::clarify" },
  { id: "approve", title: "Approve", detail: "flow::approve" },
]

function issueLaneId(issue: IssueRow) {
  const flow = String(issue.currentFlow || "").toLowerCase()
  return issueLanes.some((lane) => lane.id === flow) ? flow : "untriaged"
}

export function IssuesBoard({
  gitServer,
  user,
  project,
  repository,
  issues,
  loadingIssues,
  onLogin,
  onSyncIssues,
}: RepoWorkspaceProps) {
  const openIssues = useMemo(() => (issues || []).filter((issue) => {
    return String(issue.state || "").toLowerCase() === "opened" && String(issue.status || "").toLowerCase() === "active"
  }), [issues])
  const grouped = useMemo(() => {
    const map = new Map(issueLanes.map((lane) => [lane.id, [] as IssueRow[]]))
    for (const issue of openIssues) {
      map.get(issueLaneId(issue))?.push(issue)
    }
    for (const rows of map.values()) {
      rows.sort((a, b) => Number(new Date(b.updatedAt || 0).getTime()) - Number(new Date(a.updatedAt || 0).getTime()))
    }
    return map
  }, [openIssues])

  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) {
    return (
      <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后查看 issue 看板。">
        <Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button>
      </EmptyPanel>
    )
  }
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<CircleDot className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再查看 issue 看板。" />

  return (
    <div className="issue-board">
      <header className="issue-board-toolbar">
        <span aria-hidden="true" />
        <Button type="button" variant="secondary" onClick={() => void onSyncIssues()} disabled={loadingIssues}>
          {loadingIssues ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          同步
        </Button>
      </header>
      <div className="issue-board-lanes">
        {issueLanes.map((lane) => (
          <IssueLane key={lane.id} title={lane.title} detail={lane.detail} issues={grouped.get(lane.id) || []} />
        ))}
      </div>
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
  const meta = [
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
