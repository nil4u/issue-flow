import type { DraftReviewItem, FeedbackRequest, LoadedVisualArtifact, VisionRouteContext, VisualReview } from "./types"

function endpoint(context: VisionRouteContext, suffix = "") {
  const base = `/api/visual-artifacts/${encodeURIComponent(context.gitServerId)}/${encodeURIComponent(context.projectId)}/${context.issueNumber}/${context.artifactType}`
  return `${base}${suffix}`
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error ? `请求失败：${data.error}` : `请求失败：HTTP ${response.status}`)
  return data as T
}

export async function loadVisualArtifact(context: VisionRouteContext): Promise<LoadedVisualArtifact> {
  const result = await parseResponse<{
    artifact: { entryPath: string; updatedAt: string; status?: string }
    format?: "html" | "markdown"
    mergeRequest?: { number?: number; url?: string; state?: string }
    repository?: { fullName?: string }
    html: string
    drafts?: DraftReviewItem[]
    reviews?: VisualReview[]
  }>(await fetch(endpoint(context)))
  const artifact = result.artifact
  return {
    issue: {
      issueId: `#${context.issueNumber}`,
      issuePath: `${context.gitServerId}/${context.projectId}/${context.issueNumber}`,
      title: `${result.repository?.fullName || context.projectId} · 议题 #${context.issueNumber}`,
      artifacts: [{
        type: context.artifactType,
        path: artifact.entryPath,
        title: context.artifactType === "decision" ? "决策" : "方案",
        url: endpoint(context, "/file"),
        modifiedAt: artifact.updatedAt,
        status: artifact.status || "pending",
        format: result.format || "html",
        mergeRequestNumber: result.mergeRequest?.number,
        mergeRequestUrl: result.mergeRequest?.url,
        mergeRequestState: result.mergeRequest?.state,
      }],
    },
    html: result.html,
    format: result.format || "html",
    drafts: Array.isArray(result.drafts) ? result.drafts : [],
    reviews: Array.isArray(result.reviews) ? result.reviews : [],
  }
}

export async function addReviewDraftItem(context: VisionRouteContext, input: FeedbackRequest) {
  return parseResponse<DraftReviewItem>(await fetch(endpoint(context, "/drafts"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
}

export async function updateReviewDraftItem(context: VisionRouteContext, itemId: string, input: FeedbackRequest) {
  return parseResponse<DraftReviewItem>(await fetch(endpoint(context, `/drafts/${encodeURIComponent(itemId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }))
}

export async function deleteReviewDraftItem(context: VisionRouteContext, itemId: string) {
  return parseResponse<{ id: string; deleted: boolean }>(await fetch(endpoint(context, `/drafts/${encodeURIComponent(itemId)}`), { method: "DELETE" }))
}

export async function submitReviewDraft(context: VisionRouteContext) {
  return parseResponse<{ review: VisualReview; status: string }>(await fetch(endpoint(context, "/reviews"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }))
}

export async function approveAllDecisions(context: VisionRouteContext) {
  return parseResponse<{ review: VisualReview; status: string }>(await fetch(endpoint(context, "/reviews"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approveAll: true }),
  }))
}

export async function approveVisionArtifact(context: VisionRouteContext) {
  return parseResponse<{ artifact: { status: string }; review: VisualReview; flow: string }>(await fetch(
    `/api/visual-artifacts/${encodeURIComponent(context.gitServerId)}/${encodeURIComponent(context.projectId)}/${context.issueNumber}/plan/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ))
}
