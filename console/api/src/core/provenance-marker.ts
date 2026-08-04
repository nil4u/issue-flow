// @ts-nocheck

import domain from "issue-flow/domain"

const { parseSourceMarker, sourceIssueNumber } = domain

function sourceMarkerFields(body = "") {
  return parseSourceMarker(body)
}

function issueFlowMarkers(body = "") {
  const source = sourceMarkerFields(body)
  const sourceTaskId = String(source.source_task_id || "").trim()
  return {
    sourceIssueNumber: sourceIssueNumber(body),
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
