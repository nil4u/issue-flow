// @ts-nocheck
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

async function applyPullRequestSnapshotToFacts(store, snapshot) {
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

export { applyPullRequestSnapshotToFacts, openedByTaskId, pullRequestKind, pullRequestState, sourceIssueNumber }
