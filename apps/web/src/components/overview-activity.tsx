import {
  CircleDot,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Hash,
  MessageSquare,
  Tag,
  UserRound,
  Webhook,
} from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import type { GitEventRow, Repository } from "@/issue-flow-model"
import { formatWhen } from "@/issue-flow-model"

type ActivityView = {
  id: string
  action: string
  actor: string
  avatarUrl: string
  branch: string
  deliveryId: string
  detail: string
  eventName: string
  labels: string[]
  objectId: string
  objectType: string
  repository: string
  time: string
  title: string
  tone: "issue" | "merge" | "comment" | "pipeline" | "default"
}

export function OverviewActivity({
  gitEvents,
  repository,
}: {
  gitEvents: GitEventRow[]
  repository: Repository
}) {
  const rows = gitEvents.slice(0, 12).map(activityView)
  const latest = rows[0]?.time || "暂无"
  return (
    <section className="overview-activity">
      <header className="overview-activity-head">
        <div>
          <span className="overview-kicker"><Webhook className="size-4" />最近活动</span>
          <h2>Webhook 活动流</h2>
          <p>{repository.fullName || repository.projectPath} 的最近交付、issue、MR 和评论事件。</p>
        </div>
        <div className="overview-activity-stats" aria-label="活动概览">
          <span><strong>{rows.length}</strong><small>最近记录</small></span>
          <span><strong>{latest}</strong><small>最后接收</small></span>
        </div>
      </header>
      <div className="activity-feed">
        {rows.length === 0 && <ActivityEmpty repository={repository} />}
        {rows.map((row) => <ActivityCard key={row.id} row={row} />)}
      </div>
    </section>
  )
}

function ActivityCard({ row }: { row: ActivityView }) {
  const meta = [
    row.objectId ? { icon: <Hash className="size-3.5" />, text: row.objectId } : undefined,
    row.branch ? { icon: <GitBranch className="size-3.5" />, text: row.branch } : undefined,
    row.deliveryId ? { icon: <GitCommitHorizontal className="size-3.5" />, text: shortId(row.deliveryId) } : undefined,
  ].filter(Boolean) as Array<{ icon: ReactNode; text: string }>
  return (
    <article className={`activity-card ${row.tone}`}>
      <div className="activity-icon">{activityIcon(row)}</div>
      <div className="activity-card-main">
        <div className="activity-card-topline">
          <Badge variant="outline">{row.eventName}</Badge>
          {row.action && <Badge variant="secondary">{row.action}</Badge>}
          <time>{row.time}</time>
        </div>
        <h3>{row.title}</h3>
        <p>{row.detail}</p>
        <div className="activity-meta-row">
          <span><UserRound className="size-3.5" />{row.actor}</span>
          {meta.map((item) => <span key={item.text}>{item.icon}{item.text}</span>)}
        </div>
        {row.labels.length > 0 && (
          <div className="activity-labels">
            {row.labels.map((label) => <span key={label}><Tag className="size-3" />{label}</span>)}
          </div>
        )}
      </div>
    </article>
  )
}

function ActivityEmpty({ repository }: { repository: Repository }) {
  return (
    <div className="activity-empty">
      <div><Webhook className="size-6" /></div>
      <strong>暂无活动</strong>
      <span>{repository.fullName || repository.projectPath} 还没有收到 webhook 事件。</span>
    </div>
  )
}

function activityView(row: GitEventRow): ActivityView {
  const payload = record(row.payload)
  const object = firstRecord(payload.object_attributes, payload.objectAttributes)
  const actor = record(payload.user)
  const fact = record(row.normalizedEvents?.[0])
  const subject = activitySubject(row, object, fact)
  return {
    id: row.id,
    action: row.action || text(object.action) || text(fact.eventAction),
    actor: actorName(actor),
    avatarUrl: text(actor.avatar_url) || text(actor.avatarUrl),
    branch: text(object.target_branch) || text(object.targetBranch) || text(object.ref),
    deliveryId: row.deliveryId || "",
    detail: activityDetail(row, subject, payload, object),
    eventName: eventLabel(row.eventName || text(payload.object_kind) || text(payload.event_type)),
    labels: activityLabels(fact, payload),
    objectId: row.objectId || text(object.iid) || text(object.id),
    objectType: row.objectType || text(fact.subjectKind) || text(payload.object_kind),
    repository: row.repositoryFullName || "",
    time: formatWhen(row.receivedAt || row.createdAt || ""),
    title: subject.title,
    tone: activityTone(row),
  }
}

function activitySubject(row: GitEventRow, object: Record<string, unknown>, fact: Record<string, unknown>) {
  const issue = record(fact.issue)
  const pullRequest = record(fact.pullRequest)
  const title = text(object.title) || text(issue.title) || text(pullRequest.title)
  const fallback = [row.objectType || row.eventName || "event", row.objectId].filter(Boolean).join(" ")
  return { title: title || fallback || "Webhook event" }
}

function activityDetail(row: GitEventRow, subject: { title: string }, payload: Record<string, unknown>, object: Record<string, unknown>) {
  const repo = row.repositoryFullName || text(record(payload.project).path_with_namespace) || text(record(payload.repository).name)
  const source = text(object.source_branch) || text(object.sourceBranch)
  const target = text(object.target_branch) || text(object.targetBranch)
  const branch = source && target ? `${source} -> ${target}` : target || source
  return [repo, branch, row.deliveryId ? `delivery ${shortId(row.deliveryId)}` : ""].filter(Boolean).join(" · ") || subject.title
}

function activityLabels(fact: Record<string, unknown>, payload: Record<string, unknown>) {
  const label = text(record(fact.label).name) || text(record(payload.label).title)
  const batch = record(fact.batch)
  const labels = Array.isArray(batch.labels) ? batch.labels.map((item) => text(record(item).name || item)).filter(Boolean) : []
  return [...new Set([label, ...labels].filter(Boolean))].slice(0, 4)
}

function activityTone(row: GitEventRow): ActivityView["tone"] {
  const name = `${row.eventName || ""} ${row.objectType || ""}`.toLowerCase()
  if (name.includes("merge") || name.includes("pull_request")) return "merge"
  if (name.includes("comment") || name.includes("note")) return "comment"
  if (name.includes("pipeline") || name.includes("workflow")) return "pipeline"
  if (name.includes("issue")) return "issue"
  return "default"
}

function activityIcon(row: ActivityView) {
  if (row.tone === "merge") return <GitPullRequest className="size-4" />
  if (row.tone === "comment") return <MessageSquare className="size-4" />
  if (row.tone === "issue") return <CircleDot className="size-4" />
  if (row.tone === "pipeline") return <GitMerge className="size-4" />
  return <Webhook className="size-4" />
}

function actorName(actor: Record<string, unknown>) {
  return text(actor.name) || text(actor.username) || "GitLab"
}

function eventLabel(value = "") {
  return value.replace(/_/g, " ") || "webhook"
}

function shortId(value = "") {
  return value.length > 12 ? `${value.slice(0, 8)}...` : value
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstRecord(...values: unknown[]) {
  for (const value of values) {
    const result = record(value)
    if (Object.keys(result).length > 0) return result
  }
  return {}
}
