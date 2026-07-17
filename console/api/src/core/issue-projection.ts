// @ts-nocheck

import { issueFlowMarkers } from "./provenance-marker.js"

const FLOW_VALUES = new Set(["triage", "plan", "build", "clarify", "approve", "suspend"])
const TYPE_VALUES = new Set(["feature", "bug", "debt", "ops"])
const AUTOMATION_VALUES = new Set(["off", "triage", "plan", "build"])
const STATUS_VALUES = new Set(["active", "done", "drop", "suspend"])
const SIZE_VALUES = new Set(["XS", "S", "M", "L", "XL"])

function labelName(label) {
  if (!label) return ""
  if (typeof label === "string") return label
  return label.name || label.title || ""
}

function labelsFromPayload(payload = {}) {
  const labels = Array.isArray(payload.labels) ? payload.labels : []
  return labels.map(labelName).filter(Boolean)
}

function prefixedValue(labels = [], prefix, normalize = (value) => value, allowed) {
  for (const label of labels) {
    if (!String(label).toLowerCase().startsWith(prefix)) continue
    const value = normalize(String(label).slice(prefix.length))
    if (!allowed || allowed.has(value)) return value
  }
  return ""
}

function issueFlow(labels = []) {
  return prefixedValue(labels, "flow::", (value) => value.toLowerCase(), FLOW_VALUES)
}

function issueState(attributes = {}) {
  return String(attributes.state || "").toLowerCase()
}

function issueStatus(attributes = {}, labels = []) {
  const explicit = prefixedValue(labels, "status::", (value) => value.toLowerCase(), STATUS_VALUES)
  const flow = issueFlow(labels)
  if (issueState(attributes) === "closed") {
    return explicit === "drop" ? "drop" : "done"
  }
  if (explicit) return explicit
  if (flow === "suspend") return "suspend"
  return "active"
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
  return {
    gitServerId: gitEvent.gitServerId,
    repositoryId: gitEvent.repositoryId,
    repositoryFullName: gitEvent.repositoryFullName,
    issueId,
    issueNumber,
    title: attributes.title || "",
    state: issueState(attributes),
    type: prefixedValue(labels, "type::", (value) => value.toLowerCase(), TYPE_VALUES),
    priority: prefixedValue(labels, "priority::", (value) => value.toUpperCase()),
    size: prefixedValue(labels, "size::", (value) => value.toUpperCase(), SIZE_VALUES),
    automation: prefixedValue(labels, "automation::", (value) => value.toLowerCase(), AUTOMATION_VALUES) || "off",
    status,
    flow: issueFlow(labels),
    openedAt: attributes.created_at || updatedAt,
    closedAt: status === "done" || status === "drop" ? attributes.closed_at || updatedAt : "",
    updatedAt,
    hasLabelSnapshot: Array.isArray(payload.labels),
    createdByTaskId: markers.sourceRuntime === "agentrix" ? markers.taskId : "",
  }
}

function issueSnapshotFromGitlabIssue(repo = {}, issue = {}) {
  const labels = Array.isArray(issue.labels) ? issue.labels : []
  const attributes = {
    id: issue.id,
    iid: issue.iid,
    title: issue.title,
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
    state: issueState(attributes),
    type: prefixedValue(labels, "type::", (value) => value.toLowerCase(), TYPE_VALUES),
    priority: prefixedValue(labels, "priority::", (value) => value.toUpperCase()),
    size: prefixedValue(labels, "size::", (value) => value.toUpperCase(), SIZE_VALUES),
    automation: prefixedValue(labels, "automation::", (value) => value.toLowerCase(), AUTOMATION_VALUES) || "off",
    status,
    flow: issueFlow(labels),
    openedAt: attributes.created_at || updatedAt,
    closedAt: status === "done" || status === "drop" ? attributes.closed_at || updatedAt : "",
    updatedAt,
    hasLabelSnapshot: true,
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
  return applyIssueSnapshotToFacts(store, snapshot, {
    ...options,
    projectSpan: shouldProjectSpan(snapshot, gitEvent),
  })
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
