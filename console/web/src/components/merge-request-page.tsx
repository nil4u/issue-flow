import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { AlertCircle, ArrowLeft, CheckCircle2, ChevronDown, CircleDot, Eye, FileCode2, Files, GitMerge, GitPullRequest, GitPullRequestClosed, Loader2, Maximize2, MessageCircle, Minimize2, Plus, RefreshCw, Search, Send, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import { api, formatWhen, type MergeRequestComment, type MergeRequestDetail, type MergeRequestFile } from "@/issue-flow-model"

type DiffLine = { key: string; kind: "header" | "context" | "addition" | "deletion" | "meta"; content: string; oldLine?: number; newLine?: number }
type LineTarget = { file: MergeRequestFile; line: number; side: "LEFT" | "RIGHT"; content: string }
type DraftComment = LineTarget & { id: string; body: string }
type ReviewView = "conversation" | "preview" | "files"
type ConversationThread = { id: string; comments: MergeRequestComment[] }
type MentionUser = { id: string; username: string; name: string; avatarUrl: string; url: string; bot: boolean }
type MentionRange = { start: number; end: number; query: string }

const mentionUsersCache = new Map<string, Promise<MentionUser[]>>()

function loadMentionUsers(baseApi: string) {
  if (!mentionUsersCache.has(baseApi)) {
    mentionUsersCache.set(baseApi, api<{ users?: MentionUser[] }>(`${baseApi}/mentions`).then((result) => result.users || []).catch(() => []))
  }
  return mentionUsersCache.get(baseApi) as Promise<MentionUser[]>
}

function parsePatch(patch: string): DiffLine[] {
  let oldLine = 0
  let newLine = 0
  return String(patch || "").split("\n").map((content, index) => {
    if (content.startsWith("@@")) {
      const match = content.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (match) { oldLine = Number(match[1]); newLine = Number(match[2]) }
      return { key: `header-${index}`, kind: "header", content }
    }
    if (content.startsWith("diff --git") || content.startsWith("index ") || content.startsWith("--- ") || content.startsWith("+++ ") || content.startsWith("\\ No newline")) return { key: `meta-${index}`, kind: "meta", content }
    if (content.startsWith("+")) return { key: `addition-${index}`, kind: "addition", content: content.slice(1), newLine: newLine++ }
    if (content.startsWith("-")) return { key: `deletion-${index}`, kind: "deletion", content: content.slice(1), oldLine: oldLine++ }
    const line = { key: `context-${index}`, kind: "context" as const, content: content.startsWith(" ") ? content.slice(1) : content, oldLine, newLine }
    oldLine += 1; newLine += 1
    return line
  })
}

function commentKey(path: string, side: string, line: number) { return `${path}:${side}:${line}` }

function groupConversationComments(comments: MergeRequestComment[]) {
  const threads = new Map<string, MergeRequestComment[]>()
  for (const comment of comments) {
    const id = comment.discussionId || `comment:${comment.id}`
    threads.set(id, [...(threads.get(id) || []), comment])
  }
  return [...threads.entries()].map(([id, threadComments]) => ({ id, comments: threadComments }))
}

function diffContext(files: MergeRequestFile[], comment: MergeRequestComment) {
  if (!comment.path || !comment.line) return []
  const file = files.find((candidate) => candidate.path === comment.path || candidate.oldPath === comment.path)
  if (!file) return []
  const lines = parsePatch(file.patch)
  const targetIndex = lines.findIndex((line) => comment.side === "LEFT" ? line.oldLine === comment.line : line.newLine === comment.line)
  if (targetIndex < 0) return []
  return lines.slice(Math.max(0, targetIndex - 2), Math.min(lines.length, targetIndex + 3)).filter((line) => line.kind !== "meta")
}

export function MergeRequestPage({ gitServerId, projectId, mergeRequestNumber }: { gitServerId: string; projectId: string; mergeRequestNumber: number }) {
  const baseApi = `/api/merge-requests/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/${mergeRequestNumber}`
  const [detail, setDetail] = useState<MergeRequestDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [view, setView] = useState<ReviewView>("conversation")
  const [fileFilter, setFileFilter] = useState("")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewBody, setReviewBody] = useState("")
  const [conversationComment, setConversationComment] = useState("")
  const [reviewAction, setReviewAction] = useState<"comment" | "approve">("comment")
  const [draftComments, setDraftComments] = useState<DraftComment[]>([])
  const [commentTarget, setCommentTarget] = useState<LineTarget>()
  const [lineCommentBody, setLineCommentBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [merging, setMerging] = useState(false)
  const [updatingState, setUpdatingState] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const [pendingAction, setPendingAction] = useState<"merge" | "close">()
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash">("merge")
  const [mergeCommitMessage, setMergeCommitMessage] = useState("")

  const loadDetail = useCallback(async () => {
    setLoading(true); setError("")
    try { setDetail(await api<MergeRequestDetail>(baseApi)) }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载 Merge Request 失败") }
    finally { setLoading(false) }
  }, [baseApi])

  useEffect(() => {
    let active = true
    void api<MergeRequestDetail>(baseApi).then((body) => { if (active) setDetail(body) }).catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : "加载 Merge Request 失败") }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [baseApi])

  useEffect(() => {
    if (!previewExpanded) return
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setPreviewExpanded(false) }
    document.body.style.overflow = "hidden"
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [previewExpanded])

  const commentsByLine = useMemo(() => {
    const result = new Map<string, MergeRequestComment[]>()
    for (const comment of detail?.comments || []) {
      if (!comment.path || !comment.line) continue
      const key = commentKey(comment.path, comment.side || "RIGHT", comment.line)
      result.set(key, [...(result.get(key) || []), comment])
    }
    return result
  }, [detail?.comments])
  const conversationComments = useMemo(() => detail?.comments || [], [detail?.comments])
  const visibleFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase()
    return query ? (detail?.files || []).filter((file) => file.path.toLowerCase().includes(query)) : detail?.files || []
  }, [detail?.files, fileFilter])
  const diffTotals = useMemo(() => (detail?.files || []).reduce((totals, file) => ({ additions: totals.additions + file.additions, deletions: totals.deletions + file.deletions }), { additions: 0, deletions: 0 }), [detail?.files])
  const isOpen = detail?.mergeRequest.state === "open"
  const canMerge = Boolean(detail?.mergeRequest.permissions?.canMerge)
  const canClose = Boolean(detail?.mergeRequest.permissions?.canClose)
  const canApprove = Boolean(detail?.mergeRequest.permissions?.canApprove)
  const hasApproved = Boolean(detail?.mergeRequest.permissions?.hasApproved)
  const sourceIssueNumber = detail?.mergeRequest.sourceIssueNumber || 0
  const listHref = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/merge-requests`
  const previewHref = detail?.mergeRequest.previewable && sourceIssueNumber > 0 ? `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/plan/${sourceIssueNumber}` : ""
  const issueHref = sourceIssueNumber && detail?.repository.webUrl ? `${detail.repository.webUrl.replace(/\/+$/, "")}${detail.repository.provider === "gitlab" ? "/-/issues/" : "/issues/"}${sourceIssueNumber}` : ""

  function stateLabel() {
    if (!detail) return "Loading"
    if (detail.mergeRequest.merged || detail.mergeRequest.state === "merged") return "Merged"
    if (detail.mergeRequest.state === "open") return detail.mergeRequest.draft ? "Draft" : "Open"
    return "Closed"
  }

  function defaultMergeMessage(method: "merge" | "squash") {
    if (!detail) return ""
    const mergeRequest = detail.mergeRequest
    if (detail.repository.provider === "github") {
      return method === "squash" ? `${mergeRequest.title} (#${mergeRequest.number})${mergeRequest.body ? `\n\n${mergeRequest.body}` : ""}` : `Merge pull request #${mergeRequest.number} from ${mergeRequest.sourceBranch}\n\n${mergeRequest.title}`
    }
    const reference = `${detail.repository.fullName}!${mergeRequest.number}`
    return method === "squash" ? `${mergeRequest.title}\n\nSee merge request ${reference}` : `Merge branch '${mergeRequest.sourceBranch}' into '${mergeRequest.targetBranch}'\n\n${mergeRequest.title}\n\nSee merge request ${reference}`
  }

  function openMergeDialog() {
    setMergeMethod("merge")
    setMergeCommitMessage(defaultMergeMessage("merge"))
    setPendingAction("merge")
  }

  function selectMergeMethod(method: "merge" | "squash") {
    setMergeMethod(method)
    setMergeCommitMessage(defaultMergeMessage(method))
  }

  function openLineComment(file: MergeRequestFile, line: DiffLine) {
    const side = line.kind === "deletion" ? "LEFT" : "RIGHT"
    const lineNumber = side === "LEFT" ? line.oldLine : line.newLine
    if (!lineNumber) return
    setCommentTarget({ file, line: lineNumber, side, content: line.content }); setLineCommentBody("")
  }

  function saveLineComment() {
    if (!commentTarget || !lineCommentBody.trim()) return
    setDraftComments((current) => [...current, { ...commentTarget, id: crypto.randomUUID(), body: lineCommentBody.trim() }])
    setCommentTarget(undefined); setLineCommentBody("")
  }

  async function submitReview() {
    if (!isOpen || submitting || (!reviewBody.trim() && !draftComments.length && reviewAction !== "approve")) return
    setSubmitting(true); setError("")
    try {
      await api(`${baseApi}/reviews`, { method: "POST", body: JSON.stringify({ action: reviewAction, body: reviewBody.trim(), comments: draftComments.map((comment) => ({ body: comment.body, path: comment.file.path, oldPath: comment.file.oldPath, line: comment.line, side: comment.side })) }) })
      setReviewBody(""); setDraftComments([]); setReviewAction("comment"); setReviewOpen(false); await loadDetail()
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : "提交审阅失败") }
    finally { setSubmitting(false) }
  }

  async function submitConversationComment() {
    const body = conversationComment.trim()
    if (!body || commentSubmitting) return
    setCommentSubmitting(true); setError("")
    try {
      await api(`${baseApi}/comments`, { method: "POST", body: JSON.stringify({ body }) })
      setConversationComment(""); await loadDetail()
    } catch (commentError) { setError(commentError instanceof Error ? commentError.message : "发表评论失败") }
    finally { setCommentSubmitting(false) }
  }

  async function approveMergeRequest() {
    if (!isOpen || !canApprove || hasApproved || approving) return
    setApproving(true); setError("")
    try { await api(`${baseApi}/reviews`, { method: "POST", body: JSON.stringify({ action: "approve", body: "", comments: [] }) }); await loadDetail() }
    catch (approveError) { setError(approveError instanceof Error ? approveError.message : "Approve failed") }
    finally { setApproving(false) }
  }

  async function mergeRequest() {
    if (!isOpen || !canMerge || merging) return
    setMerging(true); setError("")
    try { await api(`${baseApi}/merge`, { method: "POST", body: JSON.stringify({ method: mergeMethod, commitMessage: mergeCommitMessage }) }); setPendingAction(undefined); await loadDetail() }
    catch (mergeError) { setError(mergeError instanceof Error ? mergeError.message : "合并失败") }
    finally { setMerging(false) }
  }

  async function updateState(action: "close" | "reopen") {
    if (!detail || updatingState || merging) return
    if ((action === "close" || action === "reopen") && !canClose) return
    setUpdatingState(true); setError("")
    try { await api(`${baseApi}/state`, { method: "POST", body: JSON.stringify({ action }) }); setPendingAction(undefined); await loadDetail() }
    catch (stateError) { setError(stateError instanceof Error ? stateError.message : action === "close" ? "关闭失败" : "重新打开失败") }
    finally { setUpdatingState(false) }
  }

  if (loading && !detail) return <main className="gh-pr-page"><div className="gh-pr-loading"><Loader2 className="size-5 animate-spin" />正在加载 Merge Request…</div></main>

  return (
    <main className="gh-pr-page">
      <header className="gh-pr-header">
        <div className="gh-pr-title-row">
          <a href={listHref} className="gh-pr-back" aria-label="返回 Merge Requests"><ArrowLeft className="size-4" /></a>
          <h1>{detail?.mergeRequest.title || "Merge Request"} <span>#{mergeRequestNumber}</span></h1>
          <div className="gh-pr-actions">
            <Button variant="secondary" onClick={() => void loadDetail()} disabled={loading}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />刷新</Button>
            {isOpen && (canApprove || hasApproved) ? <Button className="gh-approve-button" variant="secondary" onClick={() => void approveMergeRequest()} disabled={approving || hasApproved}>{approving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}{approving ? "Approving…" : hasApproved ? "Approved" : "Approve"}</Button> : null}
            {detail?.mergeRequest.state === "closed" && !detail.mergeRequest.merged && canClose ? <Button onClick={() => void updateState("reopen")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}{updatingState ? "正在重新打开" : "Reopen"}</Button> : null}
            {isOpen && canMerge && canClose ? <DropdownMenu><DropdownMenuTrigger asChild><Button className="gh-merge-button" disabled={merging || updatingState}>{merging ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}{merging ? "正在合并" : "Merge"}<ChevronDown className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={detail?.mergeRequest.mergeable === false} onSelect={openMergeDialog}><GitMerge className="size-4" />Merge</DropdownMenuItem><DropdownMenuItem onSelect={() => setPendingAction("close")}><GitPullRequestClosed className="size-4" />Close</DropdownMenuItem></DropdownMenuContent></DropdownMenu> : null}
            {isOpen && canMerge && !canClose ? <Button className="gh-merge-button" onClick={openMergeDialog} disabled={merging || updatingState || detail?.mergeRequest.mergeable === false}><GitMerge className="size-4" />Merge</Button> : null}
            {isOpen && !canMerge && canClose ? <Button variant="secondary" onClick={() => setPendingAction("close")} disabled={updatingState}><GitPullRequestClosed className="size-4" />Close</Button> : null}
          </div>
        </div>
        <div className="gh-pr-merge-line">
          <span className={`gh-pr-state state-${stateLabel().toLowerCase()}`}><GitPullRequest className="size-4" />{stateLabel()}</span>
          <strong>{detail?.mergeRequest.author.name || detail?.mergeRequest.author.username || "Unknown"}</strong>
          <span>wants to merge {detail?.mergeRequest.commitsCount || 0} commits into</span>
          <code>{detail?.mergeRequest.targetBranch}</code><span>from</span><code>{detail?.mergeRequest.sourceBranch}</code>
        </div>
        <nav className="gh-pr-tabs" aria-label="Merge request views">
          <button type="button" className={view === "conversation" ? "is-active" : ""} onClick={() => setView("conversation")}><MessageCircle className="size-4" />Conversation <span>{conversationComments.length}</span></button>
          {previewHref ? <button type="button" className={view === "preview" ? "is-active" : ""} onClick={() => setView("preview")}><Eye className="size-4" />Preview</button> : null}
          <button type="button" className={view === "files" ? "is-active" : ""} onClick={() => setView("files")}><FileCode2 className="size-4" />Files changed <span>{detail?.files.length || 0}</span></button>
          {view === "files" ? <div className="gh-pr-diff-stat"><b>+{diffTotals.additions}</b><span>-{diffTotals.deletions}</span></div> : null}
        </nav>
      </header>

      {error ? <div className="gh-pr-error"><AlertCircle className="size-4" />{error}</div> : null}
      {view === "conversation" ? (
        <ConversationView detail={detail} comments={conversationComments} issueHref={issueHref} sourceIssueNumber={sourceIssueNumber} comment={conversationComment} submitting={commentSubmitting} baseApi={baseApi} onCommentChange={setConversationComment} onSubmitComment={() => void submitConversationComment()} onUpdated={loadDetail} onError={setError} />
      ) : view === "preview" && previewHref ? (
        <section className={`gh-preview-view ${previewExpanded ? "is-expanded" : ""}`}>
          <Button className="gh-preview-expand" variant="secondary" size="icon" onClick={() => setPreviewExpanded((expanded) => !expanded)} aria-label={previewExpanded ? "退出全屏预览" : "全屏预览"} title={previewExpanded ? "退出全屏" : "全屏预览"}>{previewExpanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</Button>
          <iframe src={previewHref} title={`Preview MR #${mergeRequestNumber}`} />
        </section>
      ) : (
        <section className="gh-files-view">
          <div className="gh-files-toolbar">
            <span>{visibleFiles.length} changed files</span>
            <div><span className="gh-review-progress">{draftComments.length} pending comments</span><Button onClick={() => setReviewOpen(true)} disabled={!isOpen}><Send className="size-4" />Submit review</Button></div>
          </div>
          <div className="gh-files-layout">
            <aside className="gh-file-tree">
              <label><Search className="size-4" /><input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="Filter files…" />{fileFilter ? <button type="button" onClick={() => setFileFilter("")} aria-label="清除文件筛选"><X className="size-3" /></button> : null}</label>
              <nav>{visibleFiles.map((file, index) => <a key={file.path} href={`#changed-file-${index}`}><Files className="size-4" /><code>{file.path}</code><span>{commentsByLine.size ? "" : file.status}</span></a>)}</nav>
            </aside>
            <div className="gh-file-diffs">{visibleFiles.map((file, fileIndex) => <FileDiff key={file.path} file={file} fileIndex={fileIndex} isOpen={isOpen} commentsByLine={commentsByLine} draftComments={draftComments} onComment={openLineComment} onRemoveDraft={(id) => setDraftComments((current) => current.filter((item) => item.id !== id))} />)}</div>
          </div>
        </section>
      )}

      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}><DialogContent className="gh-review-dialog"><DialogHeader><DialogTitle>Submit review</DialogTitle></DialogHeader><div className="gh-review-kind"><button className={reviewAction === "comment" ? "is-active" : ""} onClick={() => setReviewAction("comment")}>Comment</button><button className={reviewAction === "approve" ? "is-active" : ""} onClick={() => setReviewAction("approve")}><CheckCircle2 className="size-4" />Approve</button></div><Textarea value={reviewBody} onChange={(event) => setReviewBody(event.currentTarget.value)} placeholder={reviewAction === "approve" ? "Leave an optional approval summary" : "Leave a review summary"} /><p>{draftComments.length} pending inline comments</p><div className="gh-dialog-actions"><Button onClick={() => void submitReview()} disabled={submitting || (!reviewBody.trim() && !draftComments.length && reviewAction !== "approve")}><Send className="size-4" />{submitting ? "Submitting…" : "Submit review"}</Button></div></DialogContent></Dialog>
      <Dialog open={Boolean(commentTarget)} onOpenChange={(open) => !open && setCommentTarget(undefined)}><DialogContent><DialogHeader><DialogTitle>Add a line comment</DialogTitle></DialogHeader><div className="gh-comment-target"><code>{commentTarget?.file.path}:{commentTarget?.line}</code><pre>{commentTarget?.content}</pre></div><Textarea autoFocus value={lineCommentBody} onChange={(event) => setLineCommentBody(event.currentTarget.value)} placeholder="Leave a comment" /><div className="gh-dialog-actions"><Button onClick={saveLineComment} disabled={!lineCommentBody.trim()}><Plus className="size-4" />Add to review</Button></div></DialogContent></Dialog>
      <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open && !merging && !updatingState) setPendingAction(undefined) }}>{pendingAction === "merge" ? <DialogContent className="gh-merge-dialog" showCloseButton={false} onOpenAutoFocus={(event) => event.preventDefault()}><div className="gh-merge-dialog-header"><div className="gh-action-dialog-icon is-merge"><GitMerge className="size-4" /></div><div><DialogHeader><DialogTitle>Merge Merge Request</DialogTitle></DialogHeader><p><code>{detail?.mergeRequest.sourceBranch}</code> into <code>{detail?.mergeRequest.targetBranch}</code></p></div></div><div className="gh-merge-methods"><button type="button" className={mergeMethod === "merge" ? "is-selected" : ""} onClick={() => selectMergeMethod("merge")}><span className="gh-merge-method-radio" /><span><strong>Create a merge commit</strong><small>All commits from this branch will be added through a merge commit.</small></span></button><button type="button" className={mergeMethod === "squash" ? "is-selected" : ""} onClick={() => selectMergeMethod("squash")}><span className="gh-merge-method-radio" /><span><strong>Squash and merge</strong><small>{detail?.mergeRequest.commitsCount || "All"} commits will be combined into one commit.</small></span></button></div><label className="gh-merge-message"><span>{mergeMethod === "squash" ? "Squash commit message" : "Merge commit message"}</span><Textarea value={mergeCommitMessage} onChange={(event) => setMergeCommitMessage(event.currentTarget.value)} /></label><div className="gh-merge-dialog-actions"><Button variant="secondary" onClick={() => setPendingAction(undefined)} disabled={merging}>Cancel</Button><Button className="gh-merge-button" onClick={() => void mergeRequest()} disabled={merging || !mergeCommitMessage.trim()}>{merging ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}{merging ? "Merging…" : mergeMethod === "squash" ? "Squash and merge" : "Create merge commit"}</Button></div></DialogContent> : <DialogContent className="gh-action-dialog" showCloseButton={false} onOpenAutoFocus={(event) => event.preventDefault()}><div className="gh-action-dialog-main"><div className="gh-action-dialog-icon"><GitPullRequestClosed className="size-4" /></div><div><DialogHeader><DialogTitle>Close this Merge Request?</DialogTitle></DialogHeader><p>Close without merging. You can reopen it later.</p></div></div><div className="gh-action-dialog-actions"><Button variant="secondary" onClick={() => setPendingAction(undefined)} disabled={updatingState}>Cancel</Button><Button onClick={() => void updateState("close")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequestClosed className="size-4" />}{updatingState ? "Closing…" : "Close"}</Button></div></DialogContent>}</Dialog>
    </main>
  )
}

function ConversationView({ detail, comments, issueHref, sourceIssueNumber, comment, submitting, baseApi, onCommentChange, onSubmitComment, onUpdated, onError }: { detail?: MergeRequestDetail; comments: MergeRequestComment[]; issueHref: string; sourceIssueNumber: number; comment: string; submitting: boolean; baseApi: string; onCommentChange: (value: string) => void; onSubmitComment: () => void; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const threads = groupConversationComments(comments)
  return <section className="gh-conversation-view"><div className="gh-timeline"><TimelineCard author={detail?.mergeRequest.author} createdAt={detail?.mergeRequest.createdAt} label="opened this merge request"><MarkdownContent html={detail?.mergeRequest.bodyHtml} fallback={detail?.mergeRequest.body || "No description provided."} /></TimelineCard>{threads.map((thread) => <DiscussionCard key={thread.id} thread={thread} files={detail?.files || []} baseApi={baseApi} onUpdated={onUpdated} onError={onError} />)}<article className="gh-timeline-entry gh-comment-composer"><div className="gh-timeline-avatar"><MessageCircle className="size-5" /></div><div className="gh-comment-editor"><strong>Add a comment</strong><CommentEditor baseApi={baseApi} value={comment} submitting={submitting} placeholder="Add your comment here…" submitLabel="Comment" onChange={onCommentChange} onSubmit={onSubmitComment} /></div></article></div><aside className="gh-pr-meta"><MetaSection title="Reviewers"><p>{detail?.mergeRequest.approvedBy?.length ? detail.mergeRequest.approvedBy.map((user) => user.name || user.username).join(", ") : "No reviews"}</p></MetaSection><MetaSection title="Labels"><div className="gh-labels">{detail?.mergeRequest.labels.length ? detail.mergeRequest.labels.map((label) => <span key={label}>{label}</span>) : <p>None yet</p>}</div></MetaSection><MetaSection title="Development">{sourceIssueNumber > 0 ? issueHref ? <a href={issueHref} target="_blank" rel="noreferrer"><CircleDot className="size-4" />Mentions issue #{sourceIssueNumber}</a> : <p>Mentions issue #{sourceIssueNumber}</p> : <p>No linked issue</p>}</MetaSection></aside></section>
}

function DiscussionCard({ thread, files, baseApi, onUpdated, onError }: { thread: ConversationThread; files: MergeRequestFile[]; baseApi: string; onUpdated: () => Promise<void>; onError: (message: string) => void }) {
  const root = thread.comments.find((comment) => comment.discussionRoot) || thread.comments[0]
  const [reply, setReply] = useState("")
  const [replyOpen, setReplyOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const context = diffContext(files, root)
  const displayName = root.author.name || root.author.username || "Unknown"

  async function submitReply() {
    const body = reply.trim()
    if (!body || submitting) return
    setSubmitting(true); onError("")
    try {
      await api(`${baseApi}/comments/${encodeURIComponent(root.id)}/replies`, { method: "POST", body: JSON.stringify({ body, discussionId: root.discussionId, type: root.type }) })
      setReply(""); await onUpdated()
    } catch (replyError) { onError(replyError instanceof Error ? replyError.message : "回复失败") }
    finally { setSubmitting(false) }
  }

  const replies = root.type === "inline" ? thread.comments : thread.comments.filter((commentItem) => commentItem.id !== root.id)
  return <article className="gh-timeline-entry"><div className="gh-timeline-avatar">{root.author.avatarUrl ? <img src={root.author.avatarUrl} alt="" /> : displayName.slice(0, 1)}</div><div className={`gh-discussion-card ${root.type === "inline" ? "is-inline" : ""}`}><header><div><strong>{displayName}</strong><span>{root.type === "inline" ? " started a thread on the diff " : root.type === "review" ? ` submitted a ${root.state.toLowerCase()} review ` : " commented "}{formatWhen(root.createdAt)}</span></div></header>{root.type === "inline" ? <><div className="gh-thread-location"><FileCode2 className="size-4" /><code>{root.path}</code><span>line {root.line}</span></div>{context.length ? <div className="gh-thread-diff">{context.map((line) => <div key={line.key} className={`is-${line.kind}`}><span>{line.newLine || line.oldLine || ""}</span><code>{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}{line.content}</code></div>)}</div> : null}</> : <div className="gh-comment-body"><MarkdownContent html={root.bodyHtml} fallback={root.body || (root.state ? `Review: ${root.state}` : "")} /></div>}{replies.length ? <div className="gh-thread-notes">{replies.map((commentItem) => <div key={commentItem.id} className="gh-thread-note"><Avatar user={commentItem.author} /><div><header><strong>{commentItem.author.name || commentItem.author.username || "Unknown"}</strong><span>{formatWhen(commentItem.createdAt)}</span></header><MarkdownContent html={commentItem.bodyHtml} fallback={commentItem.body || (commentItem.state ? `Review: ${commentItem.state}` : "")} /></div></div>)}</div> : null}<div className="gh-thread-reply">{replyOpen ? <CommentEditor compact baseApi={baseApi} value={reply} submitting={submitting} placeholder="Reply…" submitLabel="Reply" onChange={setReply} onSubmit={() => void submitReply()} onCancel={() => { setReplyOpen(false); setReply("") }} /> : <button type="button" className="gh-reply-trigger" onClick={() => setReplyOpen(true)}><MessageCircle className="size-4" />Reply…</button>}</div></div></article>
}

function CommentEditor({ baseApi, value, submitting, placeholder, submitLabel, compact = false, onChange, onSubmit, onCancel }: { baseApi: string; value: string; submitting: boolean; placeholder: string; submitLabel: string; compact?: boolean; onChange: (value: string) => void; onSubmit: () => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<"write" | "preview">("write")
  const [previewHtml, setPreviewHtml] = useState("")
  const [previewing, setPreviewing] = useState(false)
  const [mentionRange, setMentionRange] = useState<MentionRange>()
  const [mentionUsers, setMentionUsers] = useState<MentionUser[]>([])
  const [mentionsLoading, setMentionsLoading] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const mentionCandidates = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.toLowerCase()
    return mentionUsers.filter((user) => !query || user.username.toLowerCase().includes(query) || user.name.toLowerCase().includes(query)).slice(0, 8)
  }, [mentionRange, mentionUsers])

  useEffect(() => {
    if (!mentionRange || mentionUsers.length) return
    let active = true
    setMentionsLoading(true)
    void loadMentionUsers(baseApi).then((users) => { if (active) setMentionUsers(users) }).finally(() => { if (active) setMentionsLoading(false) })
    return () => { active = false }
  }, [baseApi, mentionRange, mentionUsers.length])

  function updateMention(nextValue: string, cursor: number) {
    const match = nextValue.slice(0, cursor).match(/(?:^|\s)@([\w.-]*)$/)
    if (!match) { setMentionRange(undefined); return }
    const query = match[1]
    setMentionRange({ start: cursor - query.length - 1, end: cursor, query })
    setMentionIndex(0)
  }

  function selectMention(user: MentionUser) {
    if (!mentionRange) return
    const insertion = `@${user.username} `
    const nextValue = `${value.slice(0, mentionRange.start)}${insertion}${value.slice(mentionRange.end)}`
    const cursor = mentionRange.start + insertion.length
    onChange(nextValue)
    setMentionRange(undefined)
    requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(cursor, cursor) })
  }

  function handleMentionKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (!mentionRange || !mentionCandidates.length) return
    if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((current) => (current + 1) % mentionCandidates.length) }
    else if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((current) => (current - 1 + mentionCandidates.length) % mentionCandidates.length) }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectMention(mentionCandidates[mentionIndex] || mentionCandidates[0]) }
    else if (event.key === "Escape") { event.preventDefault(); setMentionRange(undefined) }
  }

  async function showPreview() {
    setMode("preview")
    if (!value.trim()) { setPreviewHtml(""); return }
    setPreviewing(true)
    try { setPreviewHtml((await api<{ html?: string }>(`${baseApi}/markdown`, { method: "POST", body: JSON.stringify({ body: value }) })).html || "") }
    finally { setPreviewing(false) }
  }

  return <div className={`gh-editor ${compact ? "is-compact" : ""}`}><div className="gh-editor-tabs"><button type="button" className={mode === "write" ? "is-active" : ""} onClick={() => setMode("write")}>Write</button><button type="button" className={mode === "preview" ? "is-active" : ""} onClick={() => void showPreview()}>Preview</button></div><div className="gh-editor-body">{mode === "write" ? <><Textarea ref={textareaRef} value={value} onChange={(event) => { const nextValue = event.currentTarget.value; onChange(nextValue); updateMention(nextValue, event.currentTarget.selectionStart) }} onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={handleMentionKeyDown} placeholder={placeholder} disabled={submitting} />{mentionRange ? <div className="gh-mention-menu">{mentionsLoading ? <div className="gh-mention-empty"><Loader2 className="size-4 animate-spin" />Loading users…</div> : mentionCandidates.length ? mentionCandidates.map((user, index) => <button key={user.username} type="button" className={index === mentionIndex ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => selectMention(user)}><Avatar user={user} /><span><strong>@{user.username}</strong><small>{user.name}</small></span>{user.bot ? <em>Bot</em> : null}</button>) : <div className="gh-mention-empty">No matching users</div>}</div> : null}</> : previewing ? <div className="gh-editor-preview is-loading"><Loader2 className="size-4 animate-spin" />Rendering preview…</div> : previewHtml ? <MarkdownContent html={previewHtml} fallback="" /> : <div className="gh-editor-preview">Nothing to preview.</div>}</div><footer>{onCancel ? <Button variant="secondary" onClick={onCancel} disabled={submitting}>Cancel</Button> : null}<Button onClick={onSubmit} disabled={submitting || !value.trim()}>{submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{submitting ? `${submitLabel}ing…` : submitLabel}</Button></footer></div>
}

function TimelineCard({ author, createdAt, label, children }: { author?: MergeRequestComment["author"]; createdAt?: string; label: string; children: ReactNode }) {
  const displayName = author?.name || author?.username || "Unknown"
  return <article className="gh-timeline-entry"><div className="gh-timeline-avatar">{author?.avatarUrl ? <img src={author.avatarUrl} alt="" /> : displayName.slice(0, 1)}</div><div className="gh-comment-card"><header><strong>{displayName}</strong><span>{label} {formatWhen(createdAt || "")}</span></header><div className="gh-comment-body">{children}</div></div></article>
}

function MetaSection({ title, children }: { title: string; children: ReactNode }) { return <section><strong>{title}</strong>{children}</section> }

function FileDiff({ file, fileIndex, isOpen, commentsByLine, draftComments, onComment, onRemoveDraft }: { file: MergeRequestFile; fileIndex: number; isOpen: boolean; commentsByLine: Map<string, MergeRequestComment[]>; draftComments: DraftComment[]; onComment: (file: MergeRequestFile, line: DiffLine) => void; onRemoveDraft: (id: string) => void }) {
  return <article id={`changed-file-${fileIndex}`} className="gh-file-diff"><header><FileCode2 className="size-4" /><code>{file.path}</code><div><b>+{file.additions}</b><span>-{file.deletions}</span><em>{file.status}</em></div></header>{file.patch ? <div className="gh-diff-table">{parsePatch(file.patch).map((line) => {
    const side = line.kind === "deletion" ? "LEFT" : "RIGHT"
    const lineNumber = side === "LEFT" ? line.oldLine : line.newLine
    const key = lineNumber ? commentKey(file.path, side, lineNumber) : ""
    return <div key={line.key} className={`gh-diff-line is-${line.kind}`}><span>{line.oldLine || ""}</span><span>{line.newLine || ""}</span><span className="gh-line-comment">{isOpen && lineNumber && !["header", "meta"].includes(line.kind) ? <button type="button" onClick={() => onComment(file, line)} aria-label={`在 ${file.path} 第 ${lineNumber} 行添加评论`}><Plus className="size-3" /></button> : null}</span><code>{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : line.kind === "context" ? " " : ""}{line.content}</code>{key ? commentsByLine.get(key)?.map((comment) => <InlineComment key={comment.id} comment={comment} />) : null}{key ? draftComments.filter((comment) => commentKey(comment.file.path, comment.side, comment.line) === key).map((comment) => <div key={comment.id} className="gh-inline-comment is-draft"><MessageCircle className="size-4" /><div><strong>Pending</strong><p>{comment.body}</p></div><button type="button" onClick={() => onRemoveDraft(comment.id)}><Trash2 className="size-4" /></button></div>) : null}</div>
  })}</div> : <div className="gh-empty-diff">{file.truncated ? "Diff is too large to display." : "No diff available."}</div>}</article>
}

function InlineComment({ comment }: { comment: MergeRequestComment }) { return <div className="gh-inline-comment"><Avatar user={comment.author} /><div><header><strong>{comment.author.name || comment.author.username || "Unknown"}</strong><span>{formatWhen(comment.createdAt)}</span></header><MarkdownContent html={comment.bodyHtml} fallback={comment.body} /></div></div> }
function Avatar({ user }: { user: MergeRequestComment["author"] }) { const name = user.name || user.username || "?"; return user.avatarUrl ? <img className="gh-avatar" src={user.avatarUrl} alt="" /> : <span className="gh-avatar">{name.slice(0, 1)}</span> }
function MarkdownContent({ html, fallback }: { html?: string; fallback: string }) { return html ? <div className="gh-markdown" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="gh-markdown"><p>{fallback}</p></div> }
