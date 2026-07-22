import { useCallback, useEffect, useState, type ReactNode } from "react"
import { AlertCircle, ArrowLeft, CircleDot, ExternalLink, Eye, Loader2, MessageCircle, Pencil, RotateCcw, Send } from "lucide-react"

import { ProviderLabel, ProviderLabelPicker } from "@/components/issues/provider-label-picker"
import { ProviderMarkdown, ProviderMarkdownEditor } from "@/components/issues/provider-markdown"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, formatWhen, type MergeRequestUser, type ProviderIssueDetail, type ReviewablePlanArtifact } from "@/issue-flow-model"

export function IssuePage({ gitServerId, projectId, issueNumber }: { gitServerId: string; projectId: string; issueNumber: number }) {
  const baseApi = `/api/issues/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}`
  const issueApi = `${baseApi}/${issueNumber}`
  const [detail, setDetail] = useState<ProviderIssueDetail>()
  const [artifact, setArtifact] = useState<ReviewablePlanArtifact>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [editOpen, setEditOpen] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [editTitle, setEditTitle] = useState("")
  const [editBody, setEditBody] = useState("")
  const [selectedLabels, setSelectedLabels] = useState<string[]>([])
  const [comment, setComment] = useState("")
  const [saving, setSaving] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [updatingState, setUpdatingState] = useState(false)

  const loadDetail = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const [issueDetail, artifactBody] = await Promise.all([
        api<ProviderIssueDetail>(issueApi),
        api<{ artifacts?: ReviewablePlanArtifact[] }>(`/api/visual-artifacts/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/reviewable`).catch(() => ({ artifacts: [] })),
      ])
      setDetail(issueDetail)
      setArtifact((artifactBody.artifacts || []).find((item) => item.issueNumber === issueNumber))
      setSelectedLabels(issueDetail.issue.labels.map((label) => label.name))
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载 Issue 失败") }
    finally { setLoading(false) }
  }, [gitServerId, issueApi, issueNumber, projectId])

  useEffect(() => { void loadDetail() }, [loadDetail])

  function openEdit() {
    if (!detail) return
    setEditTitle(detail.issue.title); setEditBody(detail.issue.body); setEditOpen(true)
  }

  async function saveIssue() {
    if (!editTitle.trim() || saving) return
    setSaving(true); setError("")
    try {
      await api(issueApi, { method: "PATCH", body: JSON.stringify({ title: editTitle.trim(), body: editBody }) })
      setEditOpen(false); await loadDetail()
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "更新 Issue 失败") }
    finally { setSaving(false) }
  }

  async function saveLabels() {
    if (saving) return
    setSaving(true); setError("")
    try {
      await api(issueApi, { method: "PATCH", body: JSON.stringify({ labels: selectedLabels }) })
      setLabelsOpen(false); await loadDetail()
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "更新标签失败") }
    finally { setSaving(false) }
  }

  async function submitComment() {
    const body = comment.trim()
    if (!body || commenting) return
    setCommenting(true); setError("")
    try {
      await api(`${issueApi}/comments`, { method: "POST", body: JSON.stringify({ body }) })
      setComment(""); await loadDetail()
    } catch (commentError) { setError(commentError instanceof Error ? commentError.message : "发表评论失败") }
    finally { setCommenting(false) }
  }

  async function updateState(action: "close" | "reopen") {
    if (updatingState) return
    setUpdatingState(true); setError("")
    try { await api(`${issueApi}/state`, { method: "POST", body: JSON.stringify({ action }) }); await loadDetail() }
    catch (stateError) { setError(stateError instanceof Error ? stateError.message : action === "close" ? "关闭 Issue 失败" : "重新打开 Issue 失败") }
    finally { setUpdatingState(false) }
  }

  if (loading && !detail) return <main className="provider-issue-page"><div className="provider-issue-page-loading"><Loader2 className="size-5 animate-spin" />正在加载 Issue…</div></main>
  if (!detail) return <main className="provider-issue-page"><div className="provider-issue-page-loading"><AlertCircle className="size-5" />{error || "Issue 不存在或无法访问"}</div></main>

  const issue = detail.issue
  const isOpen = issue.state === "open"
  const returnState = new URLSearchParams(window.location.search).get("state") === "closed" ? "?state=closed" : ""
  const listHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues${returnState}`
  const reviewHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/plan/${issueNumber}`

  return <main className="provider-issue-page"><header className="provider-issue-page-header"><div className="provider-issue-title-row"><a href={listHref} className="gh-pr-back" aria-label="返回 Issues"><ArrowLeft className="size-4" /></a><h1>{issue?.title || "Issue"} <span>#{issueNumber}</span></h1><div className="provider-issue-page-actions">{artifact ? <Button asChild variant="secondary"><a href={reviewHref}><Eye className="size-4" />{artifact.type === "decision" ? "Decision" : "Plan"}</a></Button> : null}{issue?.permissions?.canEdit ? <Button variant="secondary" onClick={openEdit}><Pencil className="size-4" />Edit</Button> : null}{issue?.permissions?.canClose && isOpen ? <Button variant="secondary" onClick={() => void updateState("close")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <CircleDot className="size-4" />}Close</Button> : null}{issue?.permissions?.canClose && !isOpen ? <Button onClick={() => void updateState("reopen")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}Reopen</Button> : null}{issue?.webUrl ? <Button asChild variant="ghost" size="icon"><a href={issue.webUrl} target="_blank" rel="noreferrer" aria-label="在 Git server 打开"><ExternalLink className="size-4" /></a></Button> : null}</div></div><div className="provider-issue-page-meta"><span className={`provider-issue-state state-${issue?.state}`}><CircleDot className="size-4" />{isOpen ? "Open" : "Closed"}</span><strong>{issue?.author.name || issue?.author.username || "Unknown"}</strong><span>opened this issue {formatWhen(issue?.createdAt || "")}</span><span>· {detail?.comments.length || 0} comments</span></div></header>{error ? <div className="provider-issue-page-error"><AlertCircle className="size-4" />{error}</div> : null}<div className="provider-issue-detail-layout"><section className="provider-issue-conversation"><IssueTimelineCard user={issue?.author} label={`opened this issue ${formatWhen(issue?.createdAt || "")}`}><ProviderMarkdown html={issue?.bodyHtml} fallback={issue?.body || "No description provided."} /></IssueTimelineCard>{detail?.comments.map((item) => <IssueTimelineCard key={item.id} user={item.author} label={`commented ${formatWhen(item.createdAt)}`}><ProviderMarkdown html={item.bodyHtml} fallback={item.body} /></IssueTimelineCard>)}{issue?.permissions?.canComment ? <article className="provider-issue-comment-composer"><div className="provider-issue-avatar"><MessageCircle className="size-5" /></div><div><strong>Add a comment</strong><ProviderMarkdownEditor endpoint={`${baseApi}/markdown`} mentionsEndpoint={`${issueApi}/mentions`} value={comment} onChange={setComment} placeholder="Add your comment here…" disabled={commenting} /><footer><Button onClick={() => void submitComment()} disabled={commenting || !comment.trim()}>{commenting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{commenting ? "Commenting…" : "Comment"}</Button></footer></div></article> : null}</section><aside className="provider-issue-sidebar"><section><header><strong>Labels</strong>{issue?.permissions?.canLabel ? <button type="button" onClick={() => { setSelectedLabels(issue.labels.map((label) => label.name)); setLabelsOpen(true) }}>Edit</button> : null}</header>{issue?.labels.length ? <div className="provider-issue-labels">{issue.labels.map((label) => <ProviderLabel key={label.name} label={detail.availableLabels.find((item) => item.name === label.name) || label} />)}</div> : <p>No labels</p>}</section><section><strong>Assignees</strong>{issue?.assignees.length ? issue.assignees.map((assignee) => <div key={assignee.id || assignee.username} className="provider-issue-assignee"><IssueAvatar user={assignee} />{assignee.name || assignee.username}</div>) : <p>No one assigned</p>}</section></aside></div><Dialog open={editOpen} onOpenChange={setEditOpen}><DialogContent className="provider-issue-dialog"><DialogHeader><DialogTitle>Edit issue</DialogTitle></DialogHeader><label className="provider-issue-field"><span>Title</span><Input value={editTitle} onChange={(event) => setEditTitle(event.currentTarget.value)} /></label><label className="provider-issue-field"><span>Description</span><ProviderMarkdownEditor endpoint={`${baseApi}/markdown`} value={editBody} onChange={setEditBody} placeholder="Describe the issue…" disabled={saving} /></label><div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button><Button onClick={() => void saveIssue()} disabled={saving || !editTitle.trim()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{saving ? "Saving…" : "Save changes"}</Button></div></DialogContent></Dialog><Dialog open={labelsOpen} onOpenChange={setLabelsOpen}><DialogContent className="provider-issue-label-dialog"><DialogHeader><DialogTitle>Edit labels</DialogTitle></DialogHeader><ProviderLabelPicker labels={detail?.availableLabels || []} selected={selectedLabels} onChange={setSelectedLabels} disabled={saving} /><div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setLabelsOpen(false)} disabled={saving}>Cancel</Button><Button onClick={() => void saveLabels()} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{saving ? "Saving…" : "Save labels"}</Button></div></DialogContent></Dialog></main>
}

function IssueTimelineCard({ user, label, children }: { user?: MergeRequestUser; label: string; children: ReactNode }) {
  return <article className="provider-issue-timeline-entry"><IssueAvatar user={user} /><div className="provider-issue-timeline-card"><header><strong>{user?.name || user?.username || "Unknown"}</strong><span>{label}</span></header><div>{children}</div></div></article>
}

function IssueAvatar({ user }: { user?: MergeRequestUser }) {
  const name = user?.name || user?.username || "?"
  return <span className="provider-issue-avatar">{user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : name.slice(0, 1)}</span>
}
