import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertCircle, ArrowLeft, CheckCircle2, CircleDot, Eye, FileCode2, Files, GitMerge, GitPullRequest, Loader2, Maximize2, MessageCircle, Minimize2, Plus, RefreshCw, Search, Send, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { api, formatWhen, type MergeRequestComment, type MergeRequestDetail, type MergeRequestFile } from "@/issue-flow-model"

type DiffLine = { key: string; kind: "header" | "context" | "addition" | "deletion" | "meta"; content: string; oldLine?: number; newLine?: number }
type LineTarget = { file: MergeRequestFile; line: number; side: "LEFT" | "RIGHT"; content: string }
type DraftComment = LineTarget & { id: string; body: string }
type ReviewView = "conversation" | "preview" | "files"

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

export function MergeRequestPage({ gitServerId, projectId, mergeRequestNumber }: { gitServerId: string; projectId: string; mergeRequestNumber: number }) {
  const baseApi = `/api/merge-requests/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/${mergeRequestNumber}`
  const [detail, setDetail] = useState<MergeRequestDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [view, setView] = useState<ReviewView>("conversation")
  const [fileFilter, setFileFilter] = useState("")
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewBody, setReviewBody] = useState("")
  const [reviewAction, setReviewAction] = useState<"comment" | "approve">("comment")
  const [draftComments, setDraftComments] = useState<DraftComment[]>([])
  const [commentTarget, setCommentTarget] = useState<LineTarget>()
  const [lineCommentBody, setLineCommentBody] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [updatingState, setUpdatingState] = useState(false)
  const [previewExpanded, setPreviewExpanded] = useState(false)

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
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewExpanded(false) }
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
  const generalComments = useMemo(() => (detail?.comments || []).filter((comment) => !comment.path || !comment.line), [detail?.comments])
  const visibleFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase()
    return query ? (detail?.files || []).filter((file) => file.path.toLowerCase().includes(query)) : detail?.files || []
  }, [detail?.files, fileFilter])
  const diffTotals = useMemo(() => (detail?.files || []).reduce((totals, file) => ({ additions: totals.additions + file.additions, deletions: totals.deletions + file.deletions }), { additions: 0, deletions: 0 }), [detail?.files])
  const isOpen = detail?.mergeRequest.state === "open"
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

  async function mergeRequest() {
    if (!isOpen || merging || !window.confirm(`确认合并 !${mergeRequestNumber}？`)) return
    setMerging(true); setError("")
    try { await api(`${baseApi}/merge`, { method: "POST", body: "{}" }); await loadDetail() }
    catch (mergeError) { setError(mergeError instanceof Error ? mergeError.message : "合并失败") }
    finally { setMerging(false) }
  }

  async function updateState(action: "close" | "reopen") {
    if (!detail || updatingState || merging) return
    if (action === "close" && !window.confirm(`确认关闭 !${mergeRequestNumber}？`)) return
    setUpdatingState(true); setError("")
    try { await api(`${baseApi}/state`, { method: "POST", body: JSON.stringify({ action }) }); await loadDetail() }
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
            {isOpen ? <Button variant="secondary" onClick={() => void updateState("close")} disabled={updatingState || merging}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}{updatingState ? "正在关闭" : "Close"}</Button> : null}
            {detail?.mergeRequest.state === "closed" && !detail.mergeRequest.merged ? <Button onClick={() => void updateState("reopen")} disabled={updatingState}>{updatingState ? <Loader2 className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}{updatingState ? "正在重新打开" : "Reopen"}</Button> : null}
            {isOpen ? <Button className="gh-merge-button" onClick={() => void mergeRequest()} disabled={merging || updatingState || detail?.mergeRequest.mergeable === false}>{merging ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}{merging ? "正在合并" : "Merge"}</Button> : null}
          </div>
        </div>
        <div className="gh-pr-merge-line">
          <span className={`gh-pr-state state-${stateLabel().toLowerCase()}`}><GitPullRequest className="size-4" />{stateLabel()}</span>
          <strong>{detail?.mergeRequest.author.name || detail?.mergeRequest.author.username || "Unknown"}</strong>
          <span>wants to merge {detail?.mergeRequest.commitsCount || 0} commits into</span>
          <code>{detail?.mergeRequest.targetBranch}</code><span>from</span><code>{detail?.mergeRequest.sourceBranch}</code>
        </div>
        <nav className="gh-pr-tabs" aria-label="Merge request views">
          <button type="button" className={view === "conversation" ? "is-active" : ""} onClick={() => setView("conversation")}><MessageCircle className="size-4" />Conversation <span>{generalComments.length}</span></button>
          {previewHref ? <button type="button" className={view === "preview" ? "is-active" : ""} onClick={() => setView("preview")}><Eye className="size-4" />Preview</button> : null}
          <button type="button" className={view === "files" ? "is-active" : ""} onClick={() => setView("files")}><FileCode2 className="size-4" />Files changed <span>{detail?.files.length || 0}</span></button>
          {view === "files" ? <div className="gh-pr-diff-stat"><b>+{diffTotals.additions}</b><span>-{diffTotals.deletions}</span></div> : null}
        </nav>
      </header>

      {error ? <div className="gh-pr-error"><AlertCircle className="size-4" />{error}</div> : null}
      {view === "conversation" ? (
        <ConversationView detail={detail} comments={generalComments} issueHref={issueHref} sourceIssueNumber={sourceIssueNumber} />
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
    </main>
  )
}

function ConversationView({ detail, comments, issueHref, sourceIssueNumber }: { detail?: MergeRequestDetail; comments: MergeRequestComment[]; issueHref: string; sourceIssueNumber: number }) {
  return <section className="gh-conversation-view"><div className="gh-timeline"><TimelineCard author={detail?.mergeRequest.author} createdAt={detail?.mergeRequest.createdAt} label="opened this merge request"><MarkdownContent html={detail?.mergeRequest.bodyHtml} fallback={detail?.mergeRequest.body || "No description provided."} /></TimelineCard>{comments.map((comment) => <TimelineCard key={comment.id} author={comment.author} createdAt={comment.createdAt} label={comment.type === "review" ? `submitted a ${comment.state.toLowerCase()} review` : "commented"}><MarkdownContent html={comment.bodyHtml} fallback={comment.body || (comment.state ? `Review: ${comment.state}` : "")} /></TimelineCard>)}</div><aside className="gh-pr-meta"><MetaSection title="Reviewers"><p>{detail?.mergeRequest.approvedBy?.length ? detail.mergeRequest.approvedBy.map((user) => user.name || user.username).join(", ") : "No reviews"}</p></MetaSection><MetaSection title="Labels"><div className="gh-labels">{detail?.mergeRequest.labels.length ? detail.mergeRequest.labels.map((label) => <span key={label}>{label}</span>) : <p>None yet</p>}</div></MetaSection><MetaSection title="Development">{sourceIssueNumber > 0 ? issueHref ? <a href={issueHref} target="_blank" rel="noreferrer"><CircleDot className="size-4" />Mentions issue #{sourceIssueNumber}</a> : <p>Mentions issue #{sourceIssueNumber}</p> : <p>No linked issue</p>}</MetaSection></aside></section>
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
