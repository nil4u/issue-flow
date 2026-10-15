// Agentrix task links share one rule: `${baseUrl}/tasks/${taskId}`. A missing
// base URL yields no link rather than a broken relative path.
export function agentrixTaskUrl(baseUrl: string, taskId: string) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "")
  if (!base || !taskId) return ""
  return `${base}/tasks/${encodeURIComponent(taskId)}`
}

export function shortTaskId(taskId: string) {
  if (taskId.length <= 18) return taskId
  return `${taskId.slice(0, 8)}…${taskId.slice(-7)}`
}

// Projected titles may be empty for historical tasks; fall back to a stable,
// ID-based label so the link stays visible.
export function agentrixTaskLabel(task: { taskId: string; title?: string }) {
  const title = String(task.title || "").trim()
  return title || `Task ${shortTaskId(task.taskId)}`
}
