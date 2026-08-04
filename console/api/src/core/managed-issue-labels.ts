// @ts-nocheck
import { applyManagedLabelChanges, managedLabelError, managedLabelGroupsForScope, normalizeManagedLabelChanges } from "./managed-labels.js"

const EDITABLE_CATALOG_GROUPS = Object.freeze({ type: "type", status: "status", flow: "flow", visualPlan: "visualPlanFeature", automation: "automation", optimization: "optimizationState", priority: "priority", size: "size" })

const MANAGED_ISSUE_LABEL_GROUPS = managedLabelGroupsForScope("issue", EDITABLE_CATALOG_GROUPS)

function normalizeWorkflowChanges(input = {}) {
  return normalizeManagedLabelChanges(input, MANAGED_ISSUE_LABEL_GROUPS, "workflow")
}

function applyWorkflowChanges(currentLabels = [], changes = {}) {
  const nextLabels = applyManagedLabelChanges(currentLabels, changes, MANAGED_ISSUE_LABEL_GROUPS)
  validateWorkflowLabels(nextLabels)
  return nextLabels
}

function validateWorkflowLabels(labels) {
  const flow = labels.find((label) => label.startsWith("flow::"))
  if (flow !== "flow::plan" && flow !== "flow::build") return
  const sizes = labels.filter((label) => label.startsWith("size::"))
  if (sizes.length !== 1) throw managedLabelError(`${flow} requires exactly one size label`, "workflow_size_required")
}

export { MANAGED_ISSUE_LABEL_GROUPS, applyWorkflowChanges, normalizeWorkflowChanges, validateWorkflowLabels }
