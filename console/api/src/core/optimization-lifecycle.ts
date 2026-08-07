// @ts-nocheck

import domain from "issue-flow/domain"

import { getProviderIssueSnapshot, updateProviderIssue } from "./issue-provider.js"

function labelNames(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === "string" ? label : label && (label.name || label.title))
    .map((label) => String(label || "").trim())
    .filter(Boolean)
}

function optimizationIssueLifecycle(issue = {}) {
  const labels = labelNames(issue.labels)
  const sourceIssueNumber = Number(domain.optimizationSourceIssueNumber(issue.body || issue.description || "") || 0)
  if (!sourceIssueNumber) return undefined
  const state = issue.state === "closed" ? "closed" : issue.state === "open" || issue.state === "opened" ? "open" : ""
  if (!state) return undefined
  return {
    issueNumber: Number(issue.number || issue.iid || 0),
    sourceIssueNumber,
    state,
    completed: state === "closed" && labels.includes("status::done"),
  }
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

function labelsForLifecycle(sourceLabels, lifecycle) {
  if (lifecycle.state === "open") {
    return domain.applyManagedLabels(sourceLabels, { optimizationState: "optimization::analyzing" })
  }
  if (lifecycle.completed) {
    return domain.applyManagedLabels(sourceLabels, { optimizationState: "optimization::analyzed" })
  }
  return domain.applyManagedLabels(sourceLabels, {}, ["optimizationState"])
}

function sameLabels(left, right) {
  const normalize = (labels) => [...new Set(labels.map(String))].sort()
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

async function applyOptimizationIssueLifecycle({ server, repo, issue, lifecycle: rawLifecycle }) {
  const lifecycle = rawLifecycle || optimizationIssueLifecycle(issue)
  if (!lifecycle) return undefined
  const sourceIssue = await getProviderIssueSnapshot(server, repo, lifecycle.sourceIssueNumber)
  const sourceLabels = labelNames(sourceIssue.labels)
  const labels = labelsForLifecycle(sourceLabels, lifecycle)
  const transition = lifecycle.state === "open" ? "analyzing" : lifecycle.completed ? "analyzed" : "cleared"
  if (!sameLabels(sourceLabels, labels)) {
    await updateProviderIssue(server, repo, lifecycle.sourceIssueNumber, { labels })
  }
  return `optimization_source_${transition}`
}

export {
  applyOptimizationIssueLifecycle,
  optimizationIssueLifecycle,
  optimizationIssueLifecycleFromGitlabPayload,
}
