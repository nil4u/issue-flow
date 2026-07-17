// @ts-nocheck

const SOURCE_ISSUE_MARKER_PATTERN = /<!--\s*issue-flow:source-issue=(\d+)\s*-->/i
const SOURCE_MARKER_PATTERN = /<!--\s*issue-flow:source\s+([^>]*?)\s*-->/i

function sourceMarkerFields(body = "") {
  const match = String(body || "").match(SOURCE_MARKER_PATTERN)
  if (!match) return {}
  const fields = {}
  for (const field of String(match[1] || "").trim().split(/\s+/)) {
    const separator = field.indexOf("=")
    if (separator <= 0) continue
    const key = field.slice(0, separator)
    const value = field.slice(separator + 1).trim()
    if ((key === "source_task_id" || key === "source_agent" || key === "source_runtime") && value) {
      fields[key] = value
    }
  }
  return fields
}

function issueFlowMarkers(body = "") {
  const content = String(body || "")
  const issueMatch = content.match(SOURCE_ISSUE_MARKER_PATTERN)
  const source = sourceMarkerFields(content)
  const sourceTaskId = String(source.source_task_id || "").trim()
  return {
    sourceIssueNumber: issueMatch ? Number(issueMatch[1]) : 0,
    sourceTaskId,
    sourceAgent: String(source.source_agent || "").trim(),
    sourceRuntime: String(source.source_runtime || "").trim(),
    taskId: sourceTaskId,
  }
}

export {
  issueFlowMarkers,
  sourceMarkerFields,
}
