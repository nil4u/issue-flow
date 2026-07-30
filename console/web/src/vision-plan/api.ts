import { loadReviewStorage } from "./review-storage"
import type { DraftReviewItem, LoadedVisualArtifact, OptimizationProposalState, VisionRouteContext, VisualReview } from "./types"

function endpoint(context: VisionRouteContext, suffix = "") {
  const base = `/api/visual-artifacts/${encodeURIComponent(context.gitServerId)}/${encodeURIComponent(context.projectId)}/${context.issueNumber}`
  const query = new URLSearchParams()
  if (context.mergeRequestNumber) query.set("mergeRequest", String(context.mergeRequestNumber))
  if (context.artifactPath) query.set("path", context.artifactPath)
  const search = query.toString()
  return `${base}${suffix}${search ? `?${search}` : ""}`
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error ? `请求失败：${data.error}` : `请求失败：HTTP ${response.status}`)
  return data as T
}

export async function loadVisualArtifact(context: VisionRouteContext): Promise<LoadedVisualArtifact> {
  const result = await parseResponse<{
    artifact: { type: "decision" | "plan" | "optimization" | "markdown"; format?: "json" | "markdown"; entryPath: string; updatedAt: string; status?: string; previewer?: string; workflow?: "plan" | "preview" }
    artifacts?: Array<{ type: "decision" | "plan" | "optimization" | "markdown"; format?: "json" | "markdown"; entryPath: string; updatedAt: string; status?: string; previewer?: string; workflow?: "plan" | "preview" }>
    format?: "json" | "markdown"
    mergeRequest?: { number?: number; url?: string; state?: string }
    associatedMergeRequests?: Array<{ number: number; title: string; state: string; labels: string[] }>
    repository?: { fullName?: string }
    html: string
    optimization?: { sourceIssueNumber: number; proposals: OptimizationProposalState[] }
  }>(await fetch(endpoint(context)))
  const artifact = result.artifact
  const artifactContext = { ...context, artifactType: artifact.type, artifactPath: artifact.entryPath }
  const stored = loadReviewStorage(artifactContext)
  const artifacts = (result.artifacts?.length ? result.artifacts : [artifact]).map((item) => ({
    type: item.type,
    path: item.entryPath,
    title: item.entryPath.split("/").at(-1) || item.entryPath,
    modifiedAt: item.updatedAt,
    status: item.status || "pending",
    format: item.format || "json",
    previewer: item.previewer,
    workflow: item.workflow,
    mergeRequestNumber: result.mergeRequest?.number,
    mergeRequestUrl: result.mergeRequest?.url,
    mergeRequestState: result.mergeRequest?.state,
  }))
  return {
    issue: {
      issueId: `#${context.issueNumber}`,
      issuePath: `${context.gitServerId}/${context.projectId}/${context.issueNumber}`,
      title: `${result.repository?.fullName || context.projectId} · 议题 #${context.issueNumber}`,
      artifacts,
      mergeRequests: result.associatedMergeRequests || [],
    },
    selectedPath: artifact.entryPath,
    html: result.html,
    format: result.format || "json",
    drafts: stored.drafts,
    reviews: stored.reviews,
    optimization: result.optimization,
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
    endpoint(context, "/approve"),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ))
}

export async function actOnOptimizationProposal(context: VisionRouteContext, proposalId: string, action: "approve" | "ignore") {
  return parseResponse<{ proposal: OptimizationProposalState; created?: boolean; completion?: { completed: boolean } }>(await fetch(
    endpoint(context, `/proposals/${encodeURIComponent(proposalId)}/${action}`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ))
}
