import { useCallback, useEffect, useState, type ReactNode } from "react"
import { AlertCircle, ArrowLeft, ChevronDown, CircleDot, ExternalLink, Eye, GitPullRequest, Loader2, MessageCircle, Pencil, RotateCcw, Send } from "lucide-react"

import { ProviderLabel, ProviderLabelPicker } from "@/components/issues/provider-label-picker"
import { ProviderMarkdown, ProviderMarkdownEditor } from "@/components/issues/provider-markdown"
import { issueReactionSymbol } from "@/components/issues/issue-reactions"
import { IssueWorkflowControls } from "@/components/issues/issue-workflow-controls"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { api, formatWhen, type MergeRequestUser, type ProviderIssueComment, type ProviderIssueDetail, type ProviderIssueLabel, type ProviderIssueReaction, type ReviewablePlanArtifact } from "@/issue-flow-model"
import { isManagedIssueLabel } from "@/lib/label-search"
import { toast } from "sonner"

export function IssuePage({ gitServerId, projectId, issueNumber }: { gitServerId: string; projectId: string; issueNumber: number }) {
  const baseApi = `/api/issues/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}`
  const issueApi = `${baseApi}/${issueNumber}`
  const [detail, setDetail] = useState<ProviderIssueDetail>()
  const [comments, setComments] = useState<ProviderIssueComment[]>([])
  const [availableLabels, setAvailableLabels] = useState<ProviderIssueLabel[]>([])
  const [artifact, setArtifact] = useState<ReviewablePlanArtifact>()
  const [loading, setLoading] = useState(true)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsLoaded, setCommentsLoaded] = useState(false)
  const [labelsLoading, setLabelsLoading] = useState(false)
  const [labelsLoaded, setLabelsLoaded] = useState(false)
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
  const [updatingWorkflow, setUpdatingWorkflow] = useState("")
  const [removingLabel, setRemovingLabel] = useState("")

  const loadDetail = useCallback(async () => {
    setLoading(true); setError("")
    try {
      const issueDetail = await api<ProviderIssueDetail>(issueApi)
      setDetail(issueDetail)
      setSelectedLabels(issueDetail.issue.labels.map((label) => label.name))
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载 Issue 失败") }
    finally { setLoading(false) }
  }, [issueApi])

  const loadArtifact = useCallback(async () => {
    const artifactBody = await api<{ artifacts?: ReviewablePlanArtifact[] }>(`/api/visual-artifacts/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/reviewable?issueNumber=${issueNumber}`).catch(() => ({ artifacts: [] }))
    setArtifact((artifactBody.artifacts || []).find((item) => item.issueNumber === issueNumber))
  }, [gitServerId, issueNumber, projectId])

  const loadComments = useCallback(async () => {
    setCommentsLoading(true)
    try {
      const body = await api<{ comments?: ProviderIssueComment[] }>(`${issueApi}/comments`)
      setComments(Array.isArray(body.comments) ? body.comments : [])
      setCommentsLoaded(true)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载评论失败") }
    finally { setCommentsLoading(false) }
  }, [issueApi])

  const loadLabels = useCallback(async () => {
    if (labelsLoaded || labelsLoading) return
    setLabelsLoading(true)
    try {
      const body = await api<{ labels?: ProviderIssueLabel[] }>(`${baseApi}/metadata`)
      setAvailableLabels(Array.isArray(body.labels) ? body.labels : [])
      setLabelsLoaded(true)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载 Labels 失败") }
    finally { setLabelsLoading(false) }
  }, [baseApi, labelsLoaded, labelsLoading])

  useEffect(() => { void loadDetail(); void loadArtifact(); void loadComments() }, [loadArtifact, loadComments, loadDetail])

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
      const managedLabels = detail?.issue.labels.map((label) => label.name).filter(isManagedIssueLabel) || []
      await api(issueApi, { method: "PATCH", body: JSON.stringify({ labels: [...managedLabels, ...selectedLabels] }) })
      setLabelsOpen(false); await loadDetail()
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "更新标签失败") }
    finally { setSaving(false) }
  }

  async function updateWorkflow(changes: Record<string, string | null>) {
    if (updatingWorkflow) return
    setUpdatingWorkflow(Object.keys(changes)[0] || "workflow"); setError("")
    try {
      await api(`${issueApi}/workflow`, { method: "PATCH", body: JSON.stringify({ changes }) })
      await loadDetail(); toast.success("Labels 已更新")
    } catch (workflowError) { setError(workflowError instanceof Error ? workflowError.message : "更新 Labels 失败") }
    finally { setUpdatingWorkflow("") }
  }

  async function removeLabel(labelName: string) {
    if (!detail || removingLabel) return
    setRemovingLabel(labelName); setError("")
    try {
      const labels = detail.issue.labels.map((label) => label.name).filter((name) => name !== labelName)
      await api(issueApi, { method: "PATCH", body: JSON.stringify({ labels }) })
      await loadDetail()
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : "删除标签失败") }
    finally { setRemovingLabel("") }
  }

  async function submitComment() {
    const body = comment.trim()
    if (!body || commenting) return
    setCommenting(true); setError("")
    try {
      await api(`${issueApi}/comments`, { method: "POST", body: JSON.stringify({ body }) })
      setComment(""); await loadComments()
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
  const unmanagedLabels = issue.labels.filter((label) => !isManagedIssueLabel(label.name))
  const availableUnmanagedLabels = availableLabels.filter((label) => !isManagedIssueLabel(label.name))
  const isOpen = issue.state === "open"
  const returnState = new URLSearchParams(window.location.search).get("state") === "closed" ? "?state=closed" : ""
  const defaultListHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues${returnState}`
  const listHref = issueReturnTo(gitServerId, projectId) || defaultListHref
  const reviewQuery = artifact?.mergeRequestNumber ? `?mergeRequest=${artifact.mergeRequestNumber}` : ""
  const reviewHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/plan/${issueNumber}${reviewQuery}`
  const issueHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues/${issueNumber}`
  const mergeRequestHref = (number: number) => `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/merge-requests/${number}?returnTo=${encodeURIComponent(issueHref)}`
  const mergeRequestActions = detail.mergeRequests.length === 1 ? (
    <Button asChild variant="secondary">
      <a href={mergeRequestHref(detail.mergeRequests[0].number)} title={detail.mergeRequests[0].title}>
        <GitPullRequest className="size-4" />MR #{detail.mergeRequests[0].number}
      </a>
    </Button>
  ) : detail.mergeRequests.length > 1 ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <GitPullRequest className="size-4" />MR<ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {detail.mergeRequests.map((mergeRequest) => (
          <DropdownMenuItem key={mergeRequest.number} asChild>
            <a href={mergeRequestHref(mergeRequest.number)} title={mergeRequest.title}>
              <GitPullRequest className="size-4" />MR #{mergeRequest.number}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null

  return <main className="provider-issue-page"><header className="provider-issue-page-header"><div className="provider-issue-title-row"><a href={listHref} className="gh-pr-back" aria-label="返回 Issues"><ArrowLeft className="size-4" /></a><h1>{issue?.title || "Issue"} <span>#{issueNumber}</span></h1><div className="provider-issue-page-actions">{artifact ? <Button asChild variant="secondary"><a href={reviewHref}><Eye className="size-4" />{artifact.type === "decision" ? "Decision" : "Plan"}</a></Button> : null}{mergeRequestActions}{issue?.permissions?.canEdit ? <Button variant="secondary" onClick={openEdit}><Pencil className="size-4" />Edit</Button> : null}{issue?.permissions?.canClose && isOpen ? <Button variant="secondary" onClick={() => void updateState("close")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <CircleDot className="size-4" />}Close</Button> : null}{issue?.permissions?.canClose && !isOpen ? <Button onClick={() => void updateState("reopen")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}Reopen</Button> : null}{issue?.webUrl ? <Button asChild variant="ghost" size="icon"><a href={issue.webUrl} target="_blank" rel="noreferrer" aria-label="在 Git server 打开"><ExternalLink className="size-4" /></a></Button> : null}</div></div><div className="provider-issue-page-meta"><span className={`provider-issue-state state-${issue?.state}`}><CircleDot className="size-4" />{isOpen ? "Open" : "Closed"}</span><strong>{issue?.author.name || issue?.author.username || "Unknown"}</strong><span>opened this issue {formatWhen(issue?.createdAt || "")}</span><span>· {commentsLoaded ? comments.length : issue.commentsCount} comments</span></div></header>{error ? <div className="provider-issue-page-error"><AlertCircle className="size-4" />{error}</div> : null}<div className="provider-issue-detail-layout"><section className="provider-issue-conversation"><IssueTimelineCard user={issue?.author} label={`opened this issue ${formatWhen(issue?.createdAt || "")}`}><ProviderMarkdown html={issue?.bodyHtml} fallback={issue?.body || "No description provided."} /></IssueTimelineCard>{commentsLoading ? <div className="provider-issue-page-loading"><Loader2 className="size-4 animate-spin" />正在加载评论…</div> : comments.map((item) => <IssueTimelineCard key={item.id} user={item.author} label={`commented ${formatWhen(item.createdAt)}`} reactions={item.reactions}><ProviderMarkdown html={item.bodyHtml} fallback={item.body} /></IssueTimelineCard>)}{issue?.permissions?.canComment ? <article className="provider-issue-comment-composer"><div className="provider-issue-avatar"><MessageCircle className="size-5" /></div><div><strong>Add a comment</strong><ProviderMarkdownEditor endpoint={`${baseApi}/markdown`} mentionsEndpoint={`${issueApi}/mentions`} value={comment} onChange={setComment} placeholder="Add your comment here…" disabled={commenting} /><footer><Button onClick={() => void submitComment()} disabled={commenting || !comment.trim()}>{commenting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{commenting ? "Commenting…" : "Comment"}</Button></footer></div></article> : null}</section><aside className="provider-issue-sidebar"><IssueWorkflowControls labels={issue.labels} canEdit={Boolean(issue.permissions?.canLabel)} busyGroup={updatingWorkflow} onChange={updateWorkflow} headerAction={issue.permissions?.canLabel ? <button type="button" onClick={() => { setSelectedLabels(unmanagedLabels.map((label) => label.name)); setLabelsOpen(true); void loadLabels() }}>编辑</button> : null}>{unmanagedLabels.length ? <div className="provider-issue-labels">{unmanagedLabels.map((label) => <ProviderLabel key={label.name} label={availableLabels.find((item) => item.name === label.name) || label} onRemove={issue.permissions?.canLabel ? () => void removeLabel(label.name) : undefined} removeDisabled={Boolean(removingLabel)} />)}</div> : <p>暂无其他 Labels</p>}</IssueWorkflowControls><section><strong>Milestone</strong>{issue?.milestone ? issue.milestone.webUrl ? <a className="provider-issue-milestone" href={issue.milestone.webUrl} target="_blank" rel="noreferrer">{issue.milestone.title}</a> : <span className="provider-issue-milestone">{issue.milestone.title}</span> : <p>No milestone</p>}</section><section><strong>Assignees</strong>{issue?.assignees.length ? issue.assignees.map((assignee) => <div key={assignee.id || assignee.username} className="provider-issue-assignee"><IssueAvatar user={assignee} />{assignee.name || assignee.username}</div>) : <p>No one assigned</p>}</section></aside></div><Dialog open={editOpen} onOpenChange={setEditOpen}><DialogContent className="provider-issue-dialog"><DialogHeader><DialogTitle>Edit issue</DialogTitle></DialogHeader><label className="provider-issue-field"><span>Title</span><Input value={editTitle} onChange={(event) => setEditTitle(event.currentTarget.value)} /></label><label className="provider-issue-field"><span>Description</span><ProviderMarkdownEditor endpoint={`${baseApi}/markdown`} value={editBody} onChange={setEditBody} placeholder="Describe the issue…" disabled={saving} /></label><div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setEditOpen(false)} disabled={saving}>Cancel</Button><Button onClick={() => void saveIssue()} disabled={saving || !editTitle.trim()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{saving ? "Saving…" : "Save changes"}</Button></div></DialogContent></Dialog><Dialog open={labelsOpen} onOpenChange={setLabelsOpen}><DialogContent className="provider-issue-label-dialog"><DialogHeader><DialogTitle>编辑 Labels</DialogTitle></DialogHeader>{labelsLoading ? <div className="provider-issue-page-loading"><Loader2 className="size-4 animate-spin" />正在加载 Labels…</div> : <ProviderLabelPicker labels={availableUnmanagedLabels} selected={selectedLabels} onChange={setSelectedLabels} disabled={saving} />}<div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setLabelsOpen(false)} disabled={saving}>取消</Button><Button onClick={() => void saveLabels()} disabled={saving || labelsLoading}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{saving ? "保存中" : "保存 Labels"}</Button></div></DialogContent></Dialog></main>
}

function IssueTimelineCard({ user, label, reactions = [], children }: { user?: MergeRequestUser; label: string; reactions?: ProviderIssueReaction[]; children: ReactNode }) {
  return <article className="provider-issue-timeline-entry"><IssueAvatar user={user} /><div className="provider-issue-timeline-card"><header><strong>{user?.name || user?.username || "Unknown"}</strong><span>{label}</span></header><div>{children}</div>{reactions.length ? <footer className="provider-issue-reactions">{reactions.map((reaction) => <span key={reaction.content} title={reaction.content} aria-label={`${reaction.content}: ${reaction.count}`}><span aria-hidden="true">{issueReactionSymbol(reaction.content)}</span>{reaction.count}</span>)}</footer> : null}</div></article>
}

function IssueAvatar({ user }: { user?: MergeRequestUser }) {
  const name = user?.name || user?.username || "?"
  return <span className="provider-issue-avatar">{user?.avatarUrl ? <img src={user.avatarUrl} alt="" /> : name.slice(0, 1)}</span>
}

function issueReturnTo(gitServerId: string, projectId: string) {
  const returnTo = new URLSearchParams(window.location.search).get("returnTo") || ""
  const repositoryPath = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}`
  if (returnTo !== repositoryPath && !returnTo.startsWith(`${repositoryPath}/`) && !returnTo.startsWith(`${repositoryPath}?`) && !returnTo.startsWith(`${repositoryPath}#`)) return ""
  return returnTo
}
