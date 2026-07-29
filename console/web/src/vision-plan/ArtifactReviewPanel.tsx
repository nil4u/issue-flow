import { useEffect, useRef } from "react";
import { CheckCircle2, MessageCircle, PanelRightClose, PencilLine, Plus, Send, Trash2 } from "lucide-react";
import type { DraftReviewItem, VisualReview, VisualTarget } from "./types";

type Props = {
  approvable: boolean;
  approved: boolean;
  approvalLabel: string;
  approveWithDrafts: boolean;
  composerOpen: boolean;
  commentText: string;
  drafts: DraftReviewItem[];
  editingDraft: DraftReviewItem | null;
  error: string | null;
  pendingTarget: VisualTarget | null;
  reviews: VisualReview[];
  selectedDraftId: string | null;
  submitting: boolean;
  onApprove: () => void;
  onCancelComment: () => void;
  onChangeComment: (value: string) => void;
  onCollapse: () => void;
  onEditDraft: (item: DraftReviewItem) => void;
  onOpenOverallComment: () => void;
  onRemoveDraft: (itemId: string) => void;
  onSelectDraft: (item: DraftReviewItem) => void;
  onSaveComment: () => void;
  onSubmit: () => void;
  onUpdateComment: () => void;
};

function draftScope(item: DraftReviewItem) {
  if (item.decision) return item.decision.action === "discuss" ? "决策讨论" : "决策确认";
  if (!item.visualTarget) return "全文反馈";
  return null;
}

function DraftCopy({ item }: { item: DraftReviewItem }) {
  const scope = draftScope(item);
  return <span className="markdown-draft-copy">
    {scope ? <small>{scope}</small> : null}
    <span className="draft-comment">{item.comment}</span>
  </span>;
}

function quotePreview(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized;
}

export function ArtifactReviewPanel({
  approvable,
  approved,
  approvalLabel,
  approveWithDrafts,
  composerOpen,
  commentText,
  drafts,
  editingDraft,
  error,
  pendingTarget,
  reviews,
  selectedDraftId,
  submitting,
  onApprove,
  onCancelComment,
  onChangeComment,
  onCollapse,
  onEditDraft,
  onOpenOverallComment,
  onRemoveDraft,
  onSelectDraft,
  onSaveComment,
  onSubmit,
  onUpdateComment,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const quote = quotePreview(pendingTarget?.selectionText);
  const submittedReviews = reviews.filter((review) => review.payload?.items?.length);
  const submittedCount = submittedReviews.reduce((count, review) => count + (review.payload.items?.length ?? 0), 0);

  useEffect(() => {
    if (composerOpen) inputRef.current?.focus();
  }, [composerOpen, pendingTarget]);

  return (
    <aside className="markdown-review-panel" aria-label="评论区">
      <header className="markdown-review-heading">
        <h2>评论</h2>
        <div className="markdown-review-heading-actions">
          <button
            type="button"
            className="icon-button add-overall-comment"
            aria-label="添加全文评论"
            title="添加全文评论"
            aria-expanded={composerOpen && !pendingTarget}
            disabled={approved}
            onClick={onOpenOverallComment}
          ><Plus size={17} /></button>
          <button type="button" className="icon-button collapse-review-panel" aria-label="收起评论区" title="收起评论区" onClick={onCollapse}><PanelRightClose size={17} /></button>
        </div>
      </header>

      <div className="markdown-review-content">
        {composerOpen ? (
          <section className="markdown-comment-composer">
            {quote ? <blockquote title={quote}>{quote}</blockquote> : null}
            <textarea ref={inputRef} value={commentText} onChange={(event) => onChangeComment(event.currentTarget.value)} placeholder="写下你的评论…" />
            <div className="markdown-comment-actions">
              <button type="button" onClick={onCancelComment}>取消</button>
              <button type="button" className="send-comment-action" disabled={!commentText.trim()} onClick={editingDraft ? onUpdateComment : onSaveComment}>{editingDraft ? "保存" : "添加"}</button>
            </div>
          </section>
        ) : null}

        {drafts.length ? <section className="markdown-drafts">
          <div className="markdown-review-section-title">
            <strong>待提交</strong>
            <span>{drafts.length}</span>
          </div>
          <div className="draft-list">
            {drafts.map((item) => editingDraft?.id === item.id ? (
              <article key={item.id} className="draft-item is-selected is-editing">
                <div className="inline-draft-editor">
                  <textarea value={commentText} onChange={(event) => onChangeComment(event.currentTarget.value)} placeholder="写下你的评论…" autoFocus />
                  <div className="markdown-comment-actions">
                    <button type="button" onClick={onCancelComment}>取消</button>
                    <button type="button" className="send-comment-action" disabled={!commentText.trim()} onClick={onUpdateComment}>保存</button>
                  </div>
                </div>
              </article>
            ) : (
              <article key={item.id} className={`draft-item ${selectedDraftId === item.id ? "is-selected" : ""}`}>
                <button type="button" className="draft-summary" onClick={() => onSelectDraft(item)}>
                  <span className="draft-icon" aria-hidden="true"><MessageCircle size={15} /></span>
                  <DraftCopy item={item} />
                </button>
                <div className="draft-item-actions">
                  <button type="button" className="icon-button edit-review-item" aria-label="编辑评论" title="编辑" onClick={() => onEditDraft(item)}><PencilLine size={14} /></button>
                  <button type="button" className="icon-button delete-review-item" aria-label="删除评论" title="删除" onClick={() => onRemoveDraft(item.id)}><Trash2 size={14} /></button>
                </div>
              </article>
            ))}
          </div>
        </section> : null}

        {!composerOpen && !drafts.length && !submittedReviews.length ? (
          <div className="markdown-review-empty"><MessageCircle size={19} /><p>还没有评论</p></div>
        ) : null}

        {submittedReviews.length ? (
          <section className="markdown-review-history">
            <div className="markdown-review-section-title"><strong>已提交</strong><span>{submittedCount}</span></div>
            {submittedReviews.map((review) => (
              <div key={review.id} className="submitted-review-group">
                <div className="submitted-review-meta">
                  <span>{new Date(review.submittedAt || review.createdAt).toLocaleString("zh-CN")}</span>
                  {review.user?.name || review.user?.username ? <span>{review.user.name || review.user.username}</span> : null}
                </div>
                {review.payload?.items?.map((item) => item.visualTarget ? (
                  <button key={item.id} type="button" className={`submitted-comment ${selectedDraftId === item.id ? "is-selected" : ""}`} onClick={() => onSelectDraft(item)}>
                    <span className="draft-icon" aria-hidden="true"><MessageCircle size={15} /></span>
                    <DraftCopy item={item} />
                  </button>
                ) : (
                  <article key={item.id} className="submitted-comment">
                    <span className="draft-icon" aria-hidden="true"><MessageCircle size={15} /></span>
                    <DraftCopy item={item} />
                  </article>
                ))}
              </div>
            ))}
          </section>
        ) : null}

        {error ? <pre className="error-box">{error}</pre> : null}
      </div>

      <footer className={`markdown-review-actions ${approvable ? "" : "comments-only"}`}>
        <button type="button" className="submit-review-action" onClick={onSubmit} disabled={!drafts.length || submitting || approved}>
          <Send size={16} />{submitting ? "正在提交…" : drafts.length ? `提交 ${drafts.length} 条评论` : "提交评论"}
        </button>
        {approvable ? <button type="button" className="approve-action" onClick={onApprove} disabled={approved || submitting || (!approveWithDrafts && drafts.length > 0)} title={!approveWithDrafts && drafts.length ? "请先提交当前评论" : undefined}>
          <CheckCircle2 size={16} />{approvalLabel}
        </button> : null}
      </footer>
    </aside>
  );
}
