// @ts-nocheck

import { compactNulls, sanitize } from "./sanitize.js"

// Agentrix forward owns task runtime facts. GitLab issue/MR provenance may
// create an unknown-status placeholder or fill a missing link, but never
// overwrites a non-empty link; a later forwarded envelope is authoritative.
const TASK_ACTIONS = new Set(["create", "general", "triage", "plan", "build", "review"])
const WORKER_STATE_EVENTS = new Set([
  "worker-initializing",
  "worker-initialized",
  "worker-ready",
  "worker-running",
  "worker-exit",
])

function normalizeTaskAction(action = "") {
  const value = String(action || "").trim().toLowerCase()
  if (value === "review_fix") return "build"
  return TASK_ACTIONS.has(value) ? value : ""
}

function forwardedAgent(eventData = {}) {
  if (eventData.agentType) return String(eventData.agentType)
  if (Array.isArray(eventData.taskAgents) && eventData.taskAgents[0]) {
    return String(eventData.taskAgents[0].type || eventData.taskAgents[0].name || "")
  }
  return String(eventData.agent || "")
}

function usageCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function forwardedMetadata(eventData = {}) {
  const metadata = eventData.metadata
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}
}

function forwardedTaskLink(forwarded = {}) {
  const taskId = String(forwarded.taskId || "").trim()
  if (!taskId) return undefined
  const eventType = String(forwarded.eventType || "")
  if (eventType !== "create-task" && eventType !== "resume-task") return undefined
  const eventData = forwarded.eventData || {}
  const action = normalizeTaskAction(forwardedMetadata(eventData).issue_flow_action)
  const agentrixGitServerId = String(eventData.gitServerId || "").trim()
  const repositoryId = String(eventData.serverRepoId || "").trim()
  const issueNumber = Number(eventData.issueNumber || 0)
  const linked = agentrixGitServerId && repositoryId && issueNumber
  if (!action && !linked) return undefined
  return {
    taskId,
    action,
    agentrixGitServerId,
    repositoryId,
    issueNumber,
    queuedAt: forwarded.createdAt,
  }
}

function forwardedTaskRuntime(forwarded = {}) {
  const taskId = String(forwarded.taskId || "").trim()
  if (!taskId) return undefined
  const eventType = String(forwarded.eventType || "")
  const eventData = forwarded.eventData || {}
  const at = forwarded.createdAt
  if (eventType === "create-task" || eventType === "resume-task") {
    return {
      taskId,
      status: "queued",
      queuedAt: at,
      agent: forwardedAgent(eventData),
      model: String(eventData.model || ""),
    }
  }
  if (eventType === "worker-initializing" || eventType === "worker-initialized" || eventType === "worker-running") {
    return { taskId, status: "running", startedAt: at }
  }
  if (eventType === "task-message" && forwarded.direction === "outbound") {
    const message = eventData.message || {}
    if (message.type !== "result") return undefined
    const failed = message.is_error === true || (message.subtype && message.subtype !== "success")
    return {
      taskId,
      status: failed ? "failed" : "succeeded",
      finishedAt: at,
    }
  }
  return undefined
}

// Task messages keep the full conversation stream; worker lifecycle changes
// share one worker_state type and retain their original state in eventData.
function forwardedTaskEvent(forwarded = {}) {
  const forwardedType = String(forwarded.eventType || "")
  const taskId = String(forwarded.taskId || "").trim()
  const eventId = String(forwarded.eventId || "").trim()
  if (!taskId || !eventId) return undefined
  const eventData = forwarded.eventData || {}
  if (WORKER_STATE_EVENTS.has(forwardedType)) {
    return {
      taskId,
      eventId,
      chatId: String(forwarded.chatId || eventData.chatId || ""),
      eventType: "worker_state",
      eventData: sanitize(compactNulls({
        ...eventData,
        state: forwardedType.slice("worker-".length),
      })),
      createdAt: forwarded.createdAt,
    }
  }
  if (forwardedType !== "task-message") return undefined
  const message = eventData.message || {}
  let eventType = "agent_message"
  if (forwarded.direction === "inbound" && String(eventData.senderType || "") === "human") {
    eventType = "human_input"
  } else if (forwarded.direction === "outbound" && message.type === "result") {
    eventType = "agent_result"
  }
  return {
    taskId,
    eventId,
    chatId: String(forwarded.chatId || eventData.chatId || ""),
    eventType,
    eventData: sanitize(compactNulls(eventData)),
    createdAt: forwarded.createdAt,
  }
}

function forwardedTaskUsageReport(forwarded = {}) {
  if (String(forwarded.eventType || "") !== "task-usage-report") return undefined
  const taskId = String(forwarded.taskId || "").trim()
  const eventId = String(forwarded.eventId || "").trim()
  const modelUsage = (forwarded.eventData || {}).modelUsage
  if (!taskId || !eventId || !modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return undefined
  }
  const reports = Object.entries(modelUsage)
    .filter(([model, usage]) => model.trim() && usage && typeof usage === "object" && !Array.isArray(usage))
    .map(([model, usage]) => ({
      model: model.trim(),
      inputTokens: usageCount(usage.inputTokens),
      outputTokens: usageCount(usage.outputTokens),
      cacheReadInputTokens: usageCount(usage.cacheReadInputTokens),
      cacheCreationInputTokens: usageCount(usage.cacheCreationInputTokens),
      webSearchRequests: usageCount(usage.webSearchRequests),
    }))
  if (!reports.length) return undefined
  return { taskId, eventId, reports, createdAt: forwarded.createdAt }
}

async function applyForwardedEventToTaskFacts(store, forwarded = {}) {
  const runtime = forwardedTaskRuntime(forwarded)
  if (runtime) {
    await store.upsertTaskRuntime(runtime)
  }
  const link = forwardedTaskLink(forwarded)
  if (link) {
    await store.upsertTaskLink(link)
  }
  const event = forwardedTaskEvent(forwarded)
  if (event) {
    await store.appendTaskEvent(event)
  }
  const usageReport = forwardedTaskUsageReport(forwarded)
  if (usageReport) {
    await store.appendTaskUsageReport(usageReport)
  }
  return Boolean(runtime || link || event || usageReport)
}

export {
  applyForwardedEventToTaskFacts,
  forwardedTaskEvent,
  forwardedTaskLink,
  forwardedTaskRuntime,
  forwardedTaskUsageReport,
  normalizeTaskAction,
}
