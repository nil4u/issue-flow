// @ts-nocheck
import domain from 'issue-flow/domain'
import { issueFlowMarkers } from '../provenance-marker.js'
import { applyIssueSnapshotToFacts, shouldProjectSpan } from '../issue-projection.js'
import { applyPullRequestSnapshotToFacts, pullRequestKind, pullRequestState } from '../pull-request-projection.js'
import { optimizationIssueLifecycle } from '../optimization-lifecycle.js'
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

async function applyGitEventToIssueFacts(store, gitEvent = {}, options = {}) {
  const snapshot = issueSnapshot(gitEvent)
  if (!snapshot) return undefined
  return applyIssueSnapshotToFacts(store, snapshot, { ...options, projectSpan: shouldProjectSpan(snapshot, gitEvent) })
}

async function applyGitlabIssueSnapshotToFacts(store, repo = {}, issue = {}, options = {}) {
  return applyIssueSnapshotToFacts(store, issueSnapshotFromGitlabIssue(repo, issue), options)
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
  return applyPullRequestSnapshotToFacts(store, snapshot)
}


function optimizationIssueLifecycleFromGitlabPayload(payload = {}) {
  const kind = payload.object_kind || payload.objectKind || payload.event_type || payload.eventType || ""
  if (kind !== "issue") return undefined
  const attributes = payload.object_attributes || payload.objectAttributes || {}
  const action = String(attributes.action || "").toLowerCase()
  const rawState = String(attributes.state || "").toLowerCase()
  const state = action === "close" || rawState === "closed"
    ? "closed"
    : action === "open" || action === "reopen" || rawState === "open" || rawState === "opened"
      ? "open"
      : ""
  return optimizationIssueLifecycle({
    number: attributes.iid || attributes.number,
    body: attributes.description || "",
    state,
    labels: payload.labels || attributes.labels || [],
  })
}

function mergedMergeRequest(payload = {}) {
  const attributes = payload.object_attributes || payload.objectAttributes || {}
  const kind = payload.object_kind || payload.objectKind || payload.event_type || payload.eventType || ''
  if (kind !== 'merge_request') return undefined
  const state = attributes.state || ''
  const action = attributes.action || ''
  if (state !== 'merged' && action !== 'merge') return undefined
  return {
    iid: attributes.iid !== undefined ? String(attributes.iid) : '',
    sourceBranch: attributes.source_branch || attributes.sourceBranch || '',
    targetBranch: attributes.target_branch || attributes.targetBranch || '',
  }
}

function closedMergeRequest(payload = {}) {
  const attributes = payload.object_attributes || payload.objectAttributes || {}
  const kind = payload.object_kind || payload.objectKind || payload.event_type || payload.eventType || ''
  if (kind !== 'merge_request') return undefined
  const state = attributes.state || ''
  const action = attributes.action || ''
  if (state !== 'closed' && action !== 'close') return undefined
  return {
    iid: attributes.iid !== undefined ? String(attributes.iid) : '',
    sourceBranch: attributes.source_branch || attributes.sourceBranch || '',
  }
}

export function gitlabEventFacts(record) {
  const issue = issueSnapshot(record)
  return {
    issue,
    projectSpan: shouldProjectSpan(issue, record),
    pullRequest: pullRequestSnapshot(record),
  }
}

export function gitlabPluginChange(payload) {
  const merged = mergedMergeRequest(payload)
  if (merged) return { ...merged, state: 'merged' }
  const closed = closedMergeRequest(payload)
  return closed ? { ...closed, state: 'closed' } : undefined
}

export {
  issueSnapshot, issueSnapshotFromGitlabIssue, applyGitEventToIssueFacts,
  applyGitlabIssueSnapshotToFacts, pullRequestSnapshot, applyGitEventToPullRequestFacts,
  optimizationIssueLifecycleFromGitlabPayload,
}
