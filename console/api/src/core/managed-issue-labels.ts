// @ts-nocheck
import { issueFlowLabelsCatalogPath } from "./plugin-paths.js"

const EDITABLE_CATALOG_GROUPS = Object.freeze({ type: "type", status: "status", flow: "flow", visualPlan: "visualPlanFeature", automation: "automation", priority: "priority", size: "size" })

function managedIssueLabelGroups() {
  const { labelGroupsForScope } = require(issueFlowLabelsCatalogPath())
  const catalog = labelGroupsForScope("issue")
  return Object.freeze(Object.fromEntries(Object.entries(EDITABLE_CATALOG_GROUPS).map(([group, catalogGroup]) => [group, catalog[catalogGroup]])))
}

const MANAGED_ISSUE_LABEL_GROUPS = managedIssueLabelGroups()

function workflowError(message, code = "invalid_workflow_change") {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

function normalizeWorkflowChanges(input = {}) {
  const changes = input && input.changes
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw workflowError("workflow changes are required")
  const entries = Object.entries(changes)
  if (!entries.length) throw workflowError("at least one workflow change is required")

  for (const [group, value] of entries) {
    const definition = MANAGED_ISSUE_LABEL_GROUPS[group]
    if (!definition) throw workflowError(`unsupported workflow group: ${group}`)
    if (value !== null && !definition.values.includes(value)) throw workflowError(`invalid ${group} label: ${value}`)
  }
  return Object.fromEntries(entries)
}

function applyWorkflowChanges(currentLabels = [], changes = {}) {
  const changedGroups = Object.keys(changes)
  const prefixes = changedGroups.map((group) => MANAGED_ISSUE_LABEL_GROUPS[group].prefix)
  const preserved = currentLabels.filter((label) => !prefixes.some((prefix) => label.startsWith(prefix)))
  const desired = changedGroups.map((group) => changes[group]).filter(Boolean)
  const nextLabels = [...new Set([...preserved, ...desired])]
  validateWorkflowLabels(nextLabels)
  return nextLabels
}

function validateWorkflowLabels(labels) {
  const flow = labels.find((label) => label.startsWith("flow::"))
  if (flow !== "flow::plan" && flow !== "flow::build") return
  const sizes = labels.filter((label) => label.startsWith("size::"))
  if (sizes.length !== 1) throw workflowError(`${flow} requires exactly one size label`, "workflow_size_required")
}

export { MANAGED_ISSUE_LABEL_GROUPS, applyWorkflowChanges, normalizeWorkflowChanges, validateWorkflowLabels }
