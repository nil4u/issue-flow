// @ts-nocheck

import { labelsFromPayload } from "./issue-projection.js"
import { issueFlowMarkers } from "./provenance-marker.js"

const PR_KIND_BY_LABEL = new Map([
  ["mr-by::plan", "plan"],
  ["mr-by::build", "build"],
])

function pullRequestKind(labels = []) {
  for (const label of labels) {
    const kind = PR_KIND_BY_LABEL.get(String(label).toLowerCase())
    if (kind) return kind
  }
  return ""
}

function sourceIssueNumber(description = "") {
  return issueFlowMarkers(description).sourceIssueNumber
}

function openedByTaskId(description = "") {
  return issueFlowMarkers(description).taskId
}

function pullRequestState(attributes = {}) {
  const state = String(attributes.state || "").toLowerCase()
  if (state === "merged") return "merged"
  if (state === "closed") return "closed"
  return "open"
}

function pullRequestSnapshot(gitEvent = {}) {
  const payload = gitEvent.payload || {}
  const objectKind = payload.object_kind || payload.event_type || ""
  if (gitEvent.eventName !== "merge_request" && objectKind !== "merge_request") return undefined
  const attributes = payload.object_attributes || {}
  const prNumber = Number(attributes.iid || attributes.number || 0)
  const pullRequestId = String(attributes.id || prNumber || "")
  if (!pullRequestId || !prNumber) return undefined
  const description = attributes.description || ""
  const markers = issueFlowMarkers(description)
  const state = pullRequestState(attributes)
  const updatedAt = attributes.updated_at || attributes.created_at || gitEvent.receivedAt
  return {
    gitServerId: gitEvent.gitServerId,
    repositoryId: gitEvent.repositoryId,
    repositoryFullName: gitEvent.repositoryFullName,
    issueNumber: markers.sourceIssueNumber,
    openedByTaskId: markers.taskId,
    sourceRuntime: markers.sourceRuntime,
    pullRequestId,
    prNumber,
    kind: pullRequestKind(labelsFromPayload(payload)),
    state,
    htmlUrl: attributes.url || "",
    openedAt: attributes.created_at || updatedAt,
    mergedAt: attributes.merged_at || (state === "merged" ? updatedAt : ""),
    closedAt: attributes.closed_at || (state === "closed" ? updatedAt : ""),
    updatedAt,
  }
}

async function applyGitEventToPullRequestFacts(store, gitEvent = {}) {
  const snapshot = pullRequestSnapshot(gitEvent)
  if (!snapshot) return undefined
  const { pullRequest } = await store.upsertPullRequestSnapshot(snapshot)
  if (snapshot.openedByTaskId && snapshot.sourceRuntime === "agentrix") {
    await store.upsertTaskMarkerLink({
      taskId: snapshot.openedByTaskId,
      gitServerId: snapshot.gitServerId,
      repositoryId: snapshot.repositoryId,
      repositoryFullName: snapshot.repositoryFullName,
      issueNumber: snapshot.issueNumber,
    })
  }
  return pullRequest
}

export {
  applyGitEventToPullRequestFacts,
  openedByTaskId,
  pullRequestKind,
  pullRequestSnapshot,
  sourceIssueNumber,
}
