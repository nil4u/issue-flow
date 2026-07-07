// @ts-nocheck

import { compactNulls, sanitize } from "./sanitize.js"

// Task facts are driven entirely by forwarded agentrix events. The plugin's
// dispatch passes `--issue-number` and `--metadata issue_flow_action=<action>`
// to agentrix-run; agentrix persists them on the task and the CLI daemon
// forwards a create-task/resume-task envelope projection carrying
// gitServerId (agentrix id) / serverRepoId (GitLab project id) / issueNumber /
// metadata, which is all the console needs to link a task to its issue.
const TASK_ACTIONS = new Set(["triage", "plan", "build", "review"])

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
  if (eventType === "worker-initializing" || eventType === "worker-ready" || eventType === "worker-running") {
    return { taskId, status: "running", startedAt: at }
  }
  if (eventType === "worker-exit") {
    return { taskId, status: "cancelled", weakStatus: true, finishedAt: at }
  }
  if (eventType === "task-usage-report") {
    // modelUsage is numeric usage data; sanitize() would redact *Tokens keys.
    return eventData.modelUsage ? { taskId, modelUsage: compactNulls(eventData.modelUsage) } : undefined
  }
  if (eventType === "task-message" && forwarded.direction === "outbound") {
    const message = eventData.message || {}
    if (message.type !== "result") return undefined
    const failed = message.is_error === true || (message.subtype && message.subtype !== "success")
    return {
      taskId,
      status: failed ? "failed" : "succeeded",
      finishedAt: at,
      turns: Number(message.num_turns || 0),
    }
  }
  return undefined
}

// Every task-message frame is stored (full conversation stream for analysis):
// human_input / agent_result mark the metric-relevant boundaries, everything
// else (assistant turns, tool results, system messages) lands as agent_message
// with the raw payload — eventData keeps senderType / from / message.type.
function forwardedTaskEvent(forwarded = {}) {
  if (String(forwarded.eventType || "") !== "task-message") return undefined
  const taskId = String(forwarded.taskId || "").trim()
  const eventId = String(forwarded.eventId || "").trim()
  if (!taskId || !eventId) return undefined
  const eventData = forwarded.eventData || {}
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
  return Boolean(runtime || link || event)
}

export {
  applyForwardedEventToTaskFacts,
  forwardedTaskEvent,
  forwardedTaskLink,
  forwardedTaskRuntime,
  normalizeTaskAction,
}
