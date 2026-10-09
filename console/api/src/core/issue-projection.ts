// @ts-nocheck

import domain from "issue-flow/domain"

import { issueFlowMarkers } from "./provenance-marker.js"

const { issueFlow, issueStatus, managedLabelValue, normalizeLabels } = domain

function issueState(attributes = {}) {
  return String(attributes.state || "").toLowerCase()
}

function optimizationSourceIssueNumber(description = "") {
  return domain.optimizationSourceIssueNumber(description)
    || Number(domain.parseOptimizationProposalMarker(description)?.sourceIssueNumber || 0)
}

function issueSnapshotFromProviderIssue(repo = {}, issue = {}) {
  const labels = normalizeLabels(issue.labels)
  const description = issue.body || ""
  const markers = issueFlowMarkers(description)
  const attributes = {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  }
  const status = issueStatus(attributes, labels)
  const updatedAt = attributes.updated_at || attributes.created_at || new Date().toISOString()
  return {
    gitServerId: repo.gitServerId,
    repositoryId: repo.serverRepoId || repo.projectId,
    repositoryFullName: repo.fullName || repo.projectPath,
    issueId: String(attributes.id || attributes.number || ""),
    issueNumber: Number(attributes.number || 0),
    title: attributes.title || "",
    author: issue.author && (issue.author.name || issue.author.username) || "",
    state: issueState(attributes),
    type: managedLabelValue(labels, "type", (value) => value.toLowerCase()),
    priority: managedLabelValue(labels, "priority", (value) => value.toUpperCase()),
    size: managedLabelValue(labels, "size", (value) => value.toUpperCase()),
    automation: managedLabelValue(labels, "automation", (value) => value.toLowerCase()) || "off",
    status,
    flow: issueFlow(labels),
    optimizationState: managedLabelValue(labels, "optimizationState", (value) => value.toLowerCase()),
    optimizationSourceIssueNumber: optimizationSourceIssueNumber(description),
    openedAt: attributes.created_at || updatedAt,
    closedAt: status === "done" || status === "drop" ? attributes.closed_at || updatedAt : "",
    updatedAt,
    hasLabelSnapshot: true,
    hasDescriptionSnapshot: true,
    createdByTaskId: markers.sourceRuntime === "agentrix" ? markers.taskId : "",
  }
}

function shouldProjectSpan(snapshot, gitEvent = {}) {
  if (!snapshot) return false
  if (snapshot.status === "done" || snapshot.status === "drop") return true
  if (snapshot.hasLabelSnapshot) return true
  return (gitEvent.normalizedEvents || []).some((event) => event.label || event.batch && event.batch.labels)
}

async function applyIssueSnapshotToFacts(store, snapshot, options = {}) {
  if (!snapshot) return undefined
  const { issue, applied } = await store.upsertIssueSnapshot(snapshot)
  if (applied && issue) {
    const at = snapshot.closedAt || snapshot.updatedAt
    if (options.projectSpan === false) {
      store.scheduleIssueStatsRebuild(snapshot)
    } else if (snapshot.status === "done" || snapshot.status === "drop") {
      await store.closeIssueFlowSpans({ ...snapshot, at })
      store.scheduleIssueStatsRebuild(snapshot)
    } else {
      await store.setIssueFlowSpan({ ...snapshot, at, flow: snapshot.flow })
      store.scheduleIssueStatsRebuild(snapshot)
    }
  }
  return issue
}

async function applyProviderIssueSnapshotToFacts(store, repo = {}, issue = {}, options = {}) {
  return applyIssueSnapshotToFacts(store, issueSnapshotFromProviderIssue(repo, issue), options)
}

export { applyIssueSnapshotToFacts, applyProviderIssueSnapshotToFacts, issueFlow, issueSnapshotFromProviderIssue, shouldProjectSpan }
