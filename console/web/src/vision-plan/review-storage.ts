import type { DraftReviewItem, FeedbackRequest, VisionRouteContext, VisualReview } from "./types"

type StoredReviews = {
  drafts: DraftReviewItem[]
  reviews: VisualReview[]
}

const STORAGE_PREFIX = "issue-flow:plan-reviews:v1"

function storageKey(context: VisionRouteContext) {
  return [STORAGE_PREFIX, context.gitServerId, context.projectId, context.issueNumber, context.artifactType]
    .map((part) => encodeURIComponent(String(part)))
    .join(":")
}

function emptyReviews(): StoredReviews {
  return { drafts: [], reviews: [] }
}

function readStoredReviews(context: VisionRouteContext): StoredReviews {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(context)) || "null")
    return {
      drafts: Array.isArray(parsed?.drafts) ? parsed.drafts.filter(Boolean) : [],
      reviews: Array.isArray(parsed?.reviews) ? parsed.reviews.filter(Boolean) : [],
    }
  } catch {
    return emptyReviews()
  }
}

function writeStoredReviews(context: VisionRouteContext, value: StoredReviews) {
  window.localStorage.setItem(storageKey(context), JSON.stringify(value))
  return value
}

function localId(prefix: string) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${id}`
}

export function loadReviewStorage(context: VisionRouteContext) {
  return readStoredReviews(context)
}

export function addStoredReviewDraft(context: VisionRouteContext, input: FeedbackRequest) {
  const stored = readStoredReviews(context)
  const now = new Date().toISOString()
  const item: DraftReviewItem = { ...input, id: localId("visual_draft"), createdAt: now, updatedAt: now }
  writeStoredReviews(context, { ...stored, drafts: [...stored.drafts, item] })
  return item
}

export function updateStoredReviewDraft(context: VisionRouteContext, itemId: string, input: FeedbackRequest) {
  const stored = readStoredReviews(context)
  const current = stored.drafts.find((item) => item.id === itemId)
  if (!current) throw new Error("本地审阅意见不存在")
  const updated: DraftReviewItem = { ...current, ...input, id: itemId, updatedAt: new Date().toISOString() }
  writeStoredReviews(context, { ...stored, drafts: stored.drafts.map((item) => item.id === itemId ? updated : item) })
  return updated
}

export function deleteStoredReviewDraft(context: VisionRouteContext, itemId: string) {
  const stored = readStoredReviews(context)
  writeStoredReviews(context, { ...stored, drafts: stored.drafts.filter((item) => item.id !== itemId) })
}

export function saveSubmittedReview(context: VisionRouteContext, review: VisualReview) {
  const stored = readStoredReviews(context)
  writeStoredReviews(context, { drafts: [], reviews: [review, ...stored.reviews.filter((item) => item.id !== review.id)] })
}

export function clearReviewStorage(context: VisionRouteContext) {
  window.localStorage.removeItem(storageKey(context))
}
