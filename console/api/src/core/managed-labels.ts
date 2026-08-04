// @ts-nocheck
import { issueFlowLabelsCatalogPath } from "./plugin-paths.js"

function managedLabelGroupsForScope(scope, groupMap) {
  const { labelGroupsForScope } = require(issueFlowLabelsCatalogPath())
  const catalog = labelGroupsForScope(scope)
  return Object.freeze(Object.fromEntries(Object.entries(groupMap).map(([group, catalogGroup]) => [group, catalog[catalogGroup]])))
}

function managedLabelError(message, code = "invalid_managed_label_change") {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

function normalizeManagedLabelChanges(input = {}, groups, subject = "managed label") {
  const changes = input && input.changes
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw managedLabelError(`${subject} changes are required`)
  const entries = Object.entries(changes)
  if (!entries.length) throw managedLabelError(`at least one ${subject} change is required`)

  for (const [group, value] of entries) {
    const definition = groups[group]
    if (!definition) throw managedLabelError(`unsupported ${subject} group: ${group}`)
    if (value !== null && !definition.values.includes(value)) throw managedLabelError(`invalid ${group} label: ${value}`)
  }
  return Object.fromEntries(entries)
}

function applyManagedLabelChanges(currentLabels = [], changes = {}, groups) {
  const changedGroups = Object.keys(changes)
  const prefixes = changedGroups.map((group) => groups[group].prefix)
  const preserved = currentLabels.filter((label) => !prefixes.some((prefix) => label.startsWith(prefix)))
  const desired = changedGroups.map((group) => changes[group]).filter(Boolean)
  return [...new Set([...preserved, ...desired])]
}

export { applyManagedLabelChanges, managedLabelError, managedLabelGroupsForScope, normalizeManagedLabelChanges }
