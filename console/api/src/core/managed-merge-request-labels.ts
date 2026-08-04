// @ts-nocheck
import { applyManagedLabelChanges, managedLabelGroupsForScope, normalizeManagedLabelChanges } from "./managed-labels.js"

const MANAGED_MERGE_REQUEST_LABEL_GROUPS = managedLabelGroupsForScope("merge_request", { mrBy: "mr-by", review: "review" })

function normalizeMergeRequestLabelChanges(input = {}) {
  return normalizeManagedLabelChanges(input, MANAGED_MERGE_REQUEST_LABEL_GROUPS, "merge request label")
}

function applyMergeRequestLabelChanges(currentLabels = [], changes = {}) {
  return applyManagedLabelChanges(currentLabels, changes, MANAGED_MERGE_REQUEST_LABEL_GROUPS)
}

export { MANAGED_MERGE_REQUEST_LABEL_GROUPS, applyMergeRequestLabelChanges, normalizeMergeRequestLabelChanges }
