const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { isManagedIssueLabel, isManagedMergeRequestLabel, labelMatchesQuery } = require("../src/lib/label-search.ts")

const visualPlanLabel = {
  name: "feature:visual-plan:on",
  description: "Use Visual Decision and Visual Plan for this issue",
}

test("label search matches text at any position", () => {
  assert.equal(labelMatchesQuery(visualPlanLabel, "visual"), true)
  assert.equal(labelMatchesQuery(visualPlanLabel, "sual-pl"), true)
  assert.equal(labelMatchesQuery(visualPlanLabel, "plan:on"), true)
})

test("label search matches across separators and keyword order", () => {
  assert.equal(labelMatchesQuery(visualPlanLabel, "visual plan"), true)
  assert.equal(labelMatchesQuery(visualPlanLabel, "plan visual"), true)
  assert.equal(labelMatchesQuery(visualPlanLabel, "featurevisualplan"), true)
})

test("label search includes descriptions and rejects unrelated queries", () => {
  assert.equal(labelMatchesQuery(visualPlanLabel, "decision issue"), true)
  assert.equal(labelMatchesQuery(visualPlanLabel, "deployment"), false)
})

test("managed issue label detection keeps ordinary labels in the generic picker", () => {
  assert.equal(isManagedIssueLabel("status::active"), true)
  assert.equal(isManagedIssueLabel("feature:visual-plan:on"), true)
  assert.equal(isManagedIssueLabel("backend"), false)
})

test("managed merge request label detection reserves MR By and Review labels", () => {
  assert.equal(isManagedMergeRequestLabel("mr-by::plan"), true)
  assert.equal(isManagedMergeRequestLabel("mr-by::build"), true)
  assert.equal(isManagedMergeRequestLabel("review::off"), true)
  assert.equal(isManagedMergeRequestLabel("backend"), false)
})
