import { loadReviewStorage } from "./review-storage"
import type { DraftReviewItem, LoadedVisualArtifact, VisionRouteContext, VisualReview } from "./types"

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
    format?: "json" | "markdown"
    mergeRequest?: { number?: number; url?: string; state?: string }
    repository?: { fullName?: string }
    html: string
  }>(await fetch(endpoint(context)))
  const artifact = result.artifact
  const stored = loadReviewStorage(context)
  return {
    issue: {
      issueId: `#${context.issueNumber}`,
      issuePath: `${context.gitServerId}/${context.projectId}/${context.issueNumber}`,
      title: `${result.repository?.fullName || context.projectId} · 议题 #${context.issueNumber}`,
      artifacts: [{
        type: context.artifactType,
        path: artifact.entryPath,
        title: context.artifactType === "decision" ? "决策" : "方案",
        modifiedAt: artifact.updatedAt,
        status: artifact.status || "pending",
        format: result.format || "json",
        mergeRequestNumber: result.mergeRequest?.number,
        mergeRequestUrl: result.mergeRequest?.url,
        mergeRequestState: result.mergeRequest?.state,
      }],
    },
    html: result.html,
    format: result.format || "json",
    drafts: stored.drafts,
    reviews: stored.reviews,
  }
}

export async function submitReviewDraft(context: VisionRouteContext, items: DraftReviewItem[]) {
  return parseResponse<{ review: VisualReview; status: string }>(await fetch(endpoint(context, "/reviews"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  }))
}

export async function approveAllDecisions(context: VisionRouteContext, items: DraftReviewItem[]) {
  return parseResponse<{ review: VisualReview; status: string }>(await fetch(endpoint(context, "/reviews"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approveAll: true, items }),
  }))
}

export async function approveVisionArtifact(context: VisionRouteContext) {
  return parseResponse<{ artifact: { status: string }; review: VisualReview; flow: string }>(await fetch(
    `/api/visual-artifacts/${encodeURIComponent(context.gitServerId)}/${encodeURIComponent(context.projectId)}/${context.issueNumber}/plan/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ))
}
