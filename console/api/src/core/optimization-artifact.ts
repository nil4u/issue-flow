// @ts-nocheck

const OPTIMIZATION_TYPES = new Set(["type::feature", "type::bug", "type::debt", "type::ops", "type::docs"])
const OPTIMIZATION_PROPOSAL_KINDS = new Set(["project-change", "project-developer-feedback", "issue-flow-feedback"])
const OPTIMIZATION_PRIORITIES = new Set(["priority::p0", "priority::p1", "priority::p2", "priority::p3"])
const OPTIMIZATION_SIZES = new Set(["size::XS", "size::S", "size::M", "size::L", "size::XL"])
const OPTIMIZATION_FLOWS = new Set(["flow::plan", "flow::build"])
const MANAGED_LABEL_PREFIXES = ["type::", "status::", "flow::", "automation::", "priority::", "size::", "mr-by::", "optimization::"]
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/
const TRACE_DETAIL_PATTERN = /(?:task[-_:][a-z0-9]|task\s+id|sequence|taskevent)/i
const SOURCE_PATTERN = /<!--\s*issue-flow:automation-optimization\s+source-issue=(\d+)\s*-->/i
const PROPOSAL_PATTERN = /<!--\s*issue-flow:optimization-proposal\s+optimization-issue=(\d+)\s+source-issue=(\d+)\s+proposal=([^\s>]+)(?:\s+action=([^\s>]+))?(?:\s+child-issue=(\d+))?\s*-->/i

function artifactError(message, status = 422) {
  const error = new Error(message)
  error.status = status
  error.code = "optimization_artifact_error"
  return error
}

function validateOptimizationArtifact(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw artifactError("Optimization artifact must be an object")
  if (data.schemaVersion !== 1 || data.artifact !== "optimization") throw artifactError('Optimization artifact must use schemaVersion 1 and artifact "optimization"')
  assertOnlyFields(data, ["schemaVersion", "artifact", "target", "proposals"], "Optimization artifact")
  if (!data.target || typeof data.target !== "object" || Array.isArray(data.target)) throw artifactError("Optimization artifact must contain target")
  assertOnlyFields(data.target, ["summary", "cause"], "Optimization target")
  const summary = String(data.target.summary || "").trim()
  if (!summary) throw artifactError("Optimization target must contain summary")
  if (summary.length > 120) throw artifactError("Optimization target summary must not exceed 120 characters")
  if (!Array.isArray(data.target.cause) || data.target.cause.length < 1 || data.target.cause.length > 3) throw artifactError("Optimization target cause must contain 1 to 3 items")
  for (const [index, cause] of data.target.cause.entries()) {
    const value = String(cause || "").trim()
    if (!value) throw artifactError(`Optimization target cause[${index}] must not be empty`)
    if (value.length > 80) throw artifactError(`Optimization target cause[${index}] must not exceed 80 characters`)
    if (TRACE_DETAIL_PATTERN.test(value)) throw artifactError(`Optimization target cause[${index}] must not contain Task IDs, sequence, or event trace details`)
  }
  return validateOptimizationProposals(data)
}

function validateOptimizationProposals(data) {
  if (!Array.isArray(data.proposals) || !data.proposals.length) throw artifactError("Optimization artifact must contain proposals")
  const ids = new Set()
  for (const [index, proposal] of data.proposals.entries()) {
    const id = String(proposal && proposal.id || "").trim()
    if (!SAFE_ID_PATTERN.test(id)) throw artifactError(`proposals[${index}] must have a path-safe id`)
    if (ids.has(id)) throw artifactError(`Optimization artifact contains duplicate proposal id: ${id}`)
    ids.add(id)
    assertOnlyFields(proposal, ["id", "kind", "title", "solution", "validation", "issue"], `Proposal ${id}`)
    if (!OPTIMIZATION_PROPOSAL_KINDS.has(proposal.kind)) throw artifactError(`Proposal ${id} has invalid kind`)
    if (!String(proposal.title || "").trim()) throw artifactError(`Proposal ${id} must contain title`)
    if (!String(proposal.solution || "").trim()) throw artifactError(`Proposal ${id} must contain solution`)
    if (!Array.isArray(proposal.validation) || !proposal.validation.length || proposal.validation.some((item) => !String(item || "").trim())) throw artifactError(`Proposal ${id} must contain validation`)
    if (proposal.kind === "project-developer-feedback") {
      if (proposal.issue !== undefined) throw artifactError(`Proposal ${id} project developer feedback must not contain issue`)
      continue
    }
    const issue = proposal.issue
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) throw artifactError(`Proposal ${id} must contain issue`)
    assertOnlyFields(issue, ["title", "body", "type", "priority", "size", "flow", "labels"], `Proposal ${id} issue`)
    if (!String(issue.title || "").trim() || !String(issue.body || "").trim()) throw artifactError(`Proposal ${id} issue must contain title and body`)
    if (!OPTIMIZATION_TYPES.has(issue.type)) throw artifactError(`Proposal ${id} has invalid issue type`)
    if (!OPTIMIZATION_PRIORITIES.has(issue.priority)) throw artifactError(`Proposal ${id} has invalid issue priority`)
    if (!OPTIMIZATION_SIZES.has(issue.size)) throw artifactError(`Proposal ${id} has invalid issue size`)
    if (proposal.kind === "project-change" && !OPTIMIZATION_FLOWS.has(issue.flow)) throw artifactError(`Proposal ${id} has invalid project issue flow`)
    if (proposal.kind === "project-change" && issue.type === "type::docs" && issue.flow !== "flow::build") throw artifactError(`Proposal ${id} type::docs must use flow::build`)
    if (proposal.kind === "issue-flow-feedback" && issue.type !== "type::bug") throw artifactError(`Proposal ${id} Issue Flow feedback must use type::bug`)
    if (proposal.kind === "issue-flow-feedback" && issue.flow !== "flow::triage") throw artifactError(`Proposal ${id} Issue Flow feedback must use flow::triage`)
    const labels = issue.labels === undefined ? [] : issue.labels
    if (!Array.isArray(labels) || labels.some((label) => !String(label || "").trim())) throw artifactError(`Proposal ${id} issue.labels must contain non-empty strings`)
    const managed = labels.find((label) => MANAGED_LABEL_PREFIXES.some((prefix) => String(label).startsWith(prefix)))
    if (managed) throw artifactError(`Proposal ${id} issue.labels cannot contain managed label: ${managed}`)
  }
  return data
}

function assertOnlyFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw artifactError(`${label} contains unsupported fields: ${unknown.join(", ")}`)
}

function optimizationSourceIssueNumber(body) {
  const match = String(body || "").match(SOURCE_PATTERN)
  return match ? Number.parseInt(match[1], 10) : 0
}

function proposalMarker({ optimizationIssueNumber, sourceIssueNumber, proposalId, action, childIssueNumber }) {
  return `<!-- issue-flow:optimization-proposal optimization-issue=${optimizationIssueNumber} source-issue=${sourceIssueNumber} proposal=${proposalId}${action ? ` action=${action}` : ""}${childIssueNumber ? ` child-issue=${childIssueNumber}` : ""} -->`
}

function parseProposalMarker(body) {
  const match = String(body || "").match(PROPOSAL_PATTERN)
  return match ? {
    optimizationIssueNumber: Number.parseInt(match[1], 10),
    sourceIssueNumber: Number.parseInt(match[2], 10),
    proposalId: match[3],
    action: match[4] || "created",
    ...(match[5] ? { childIssueNumber: Number.parseInt(match[5], 10) } : {}),
  } : undefined
}

function issueLabelNames(issue = {}) {
  return (Array.isArray(issue.labels) ? issue.labels : []).map((label) => typeof label === "string" ? label : label && label.name).filter(Boolean)
}

function childProposalState(issue) {
  const labels = issueLabelNames(issue)
  if (labels.includes("status::done")) return "completed"
  if (labels.includes("status::drop")) return "cancelled"
  if (labels.includes("flow::build") || labels.includes("flow::approve")) return "executing"
  return "created"
}

function deriveOptimizationProposalStates(data, optimizationIssueNumber, comments = [], issues = []) {
  const ignored = new Set(comments.map((comment) => parseProposalMarker(comment && comment.body)).filter((marker) => marker && marker.optimizationIssueNumber === optimizationIssueNumber && marker.action === "ignored").map((marker) => marker.proposalId))
  const children = new Map()
  for (const issue of issues) {
    const marker = parseProposalMarker(issue && issue.body)
    if (marker && marker.optimizationIssueNumber === optimizationIssueNumber && !children.has(marker.proposalId)) children.set(marker.proposalId, issue)
  }
  return data.proposals.map((proposal) => {
    const childIssue = children.get(proposal.id)
    const state = childIssue ? childProposalState(childIssue) : ignored.has(proposal.id) ? "ignored" : "pending"
    return {
      id: proposal.id,
      kind: proposal.kind || "project-change",
      state,
      childIssue: childIssue ? { number: childIssue.number, title: childIssue.title, state: childIssue.state, webUrl: childIssue.webUrl || "" } : null,
    }
  })
}

function allOptimizationProposalsTerminal(states = []) {
  const executable = states.filter((item) => item.kind === "project-change")
  return states.length > 0 && executable.every((item) => item.state === "ignored" || item.state === "completed" || item.state === "cancelled")
}

export {
  allOptimizationProposalsTerminal,
  deriveOptimizationProposalStates,
  optimizationSourceIssueNumber,
  parseProposalMarker,
  proposalMarker,
  validateOptimizationArtifact,
}
