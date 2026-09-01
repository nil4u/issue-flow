const assert = require("node:assert/strict")
const test = require("node:test")

const {
  VISUAL_PLAN_LABEL,
  defaultNewIssueLabels,
  showDefaultVisionPlanNotice,
} = require("../src/lib/issue-create-labels.ts")

test("new issue labels follow the repository Visual Plan default", () => {
  assert.deepEqual(defaultNewIssueLabels(), [])
  assert.deepEqual(defaultNewIssueLabels(true), [VISUAL_PLAN_LABEL])
  assert.deepEqual(defaultNewIssueLabels(false), [])
})

test("Visual Plan default notice disappears when its label is removed", () => {
  assert.equal(showDefaultVisionPlanNotice(true, [VISUAL_PLAN_LABEL]), true)
  assert.equal(showDefaultVisionPlanNotice(true, []), false)
  assert.equal(showDefaultVisionPlanNotice(false, [VISUAL_PLAN_LABEL]), false)
})
