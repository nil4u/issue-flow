// @ts-nocheck

import domain from "issue-flow/domain"

import { issueFlowMarkers } from "./provenance-marker.js"

const { issueFlow, issueStatus, managedLabelValue, normalizeLabels } = domain

function labelsFromPayload(payload = {}) {
  return normalizeLabels(Array.isArray(payload.labels) ? payload.labels : [])
}

function issueState(attributes = {}) {
  return String(attributes.state || "").toLowerCase()
}

function issueAuthor(payload = {}, attributes = {}, action = "") {
  const issueUser = payload.issue && payload.issue.user
  const author = issueUser || attributes.author || (["open", "create"].includes(String(action).toLowerCase()) ? payload.user : undefined) || {}
  return String(author.name || author.username || author.login || "")
}

function optimizationSourceIssueNumber(description = "") {
  return domain.optimizationSourceIssueNumber(description)
    || Number(domain.parseOptimizationProposalMarker(description)?.sourceIssueNumber || 0)
}

function issueSnapshot(gitEvent = {}) {
  if (gitEvent.eventName !== "issue" && gitEvent.eventName !== "issues") return undefined
  const payload = gitEvent.payload || {}
  const attributes = payload.object_attributes || {}
  const labels = labelsFromPayload(payload)
  const markers = issueFlowMarkers(attributes.description || "")
  const issueNumber = Number(attributes.iid || attributes.number || 0)
  const issueId = String(attributes.id || issueNumber || "")
  if (!issueId || !issueNumber) return undefined
  const status = issueStatus(attributes, labels)
  const updatedAt = attributes.updated_at || attributes.created_at || gitEvent.receivedAt
  const description = attributes.description
  return {
    gitServerId: gitEvent.gitServerId,
    repositoryId: gitEvent.repositoryId,
    repositoryFullName: gitEvent.repositoryFullName,
    issueId,
    issueNumber,
    title: attributes.title || "",
    author: issueAuthor(payload, attributes, gitEvent.action || attributes.action),
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
    hasLabelSnapshot: Array.isArray(payload.labels),
    hasDescriptionSnapshot: typeof description === "string",
    createdByTaskId: markers.sourceRuntime === "agentrix" ? markers.taskId : "",
  }
}

function issueSnapshotFromGitlabIssue(repo = {}, issue = {}) {
  const labels = normalizeLabels(issue.labels)
  const attributes = {
    id: issue.id,
    iid: issue.iid,
    title: issue.title,
    author: issue.author,
    state: issue.state,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    description: issue.description,
  }
  const markers = issueFlowMarkers(attributes.description || "")
  const status = issueStatus(attributes, labels)
  const updatedAt = attributes.updated_at || attributes.created_at || new Date().toISOString()
  return {
    gitServerId: repo.gitServerId,
    repositoryId: repo.projectId || repo.serverRepoId,
    repositoryFullName: repo.projectPath || repo.fullName,
    issueId: String(attributes.id || attributes.iid || ""),
    issueNumber: Number(attributes.iid || 0),
    title: attributes.title || "",
    author: attributes.author || "",
    state: issueState(attributes),
    type: managedLabelValue(labels, "type", (value) => value.toLowerCase()),
    priority: managedLabelValue(labels, "priority", (value) => value.toUpperCase()),
    size: managedLabelValue(labels, "size", (value) => value.toUpperCase()),
    automation: managedLabelValue(labels, "automation", (value) => value.toLowerCase()) || "off",
    status,
    flow: issueFlow(labels),
    optimizationState: managedLabelValue(labels, "optimizationState", (value) => value.toLowerCase()),
    optimizationSourceIssueNumber: optimizationSourceIssueNumber(attributes.description),
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

async function applyIssueSnapshotToFacts(store, snapshot = {}, options = {}) {
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

async function applyGitEventToIssueFacts(store, gitEvent = {}, options = {}) {
  const snapshot = issueSnapshot(gitEvent)
  if (!snapshot) return undefined
  return applyIssueSnapshotToFacts(store, snapshot, { ...options, projectSpan: shouldProjectSpan(snapshot, gitEvent) })
}

async function applyGitlabIssueSnapshotToFacts(store, repo = {}, issue = {}, options = {}) {
  return applyIssueSnapshotToFacts(store, issueSnapshotFromGitlabIssue(repo, issue), options)
}

export {
  applyGitlabIssueSnapshotToFacts,
  applyGitEventToIssueFacts,
  applyIssueSnapshotToFacts,
  issueFlow,
  issueSnapshot,
  issueSnapshotFromGitlabIssue,
  labelsFromPayload,
}
