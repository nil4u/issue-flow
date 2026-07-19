const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

function createLocalStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

global.window = { localStorage: createLocalStorage() }

const {
  addStoredReviewDraft,
  clearReviewStorage,
  loadReviewStorage,
  saveSubmittedReview,
} = require("../src/vision-plan/review-storage.ts")

const decisionContext = { gitServerId: "gitlab-main", projectId: "43326", issueNumber: 42, artifactType: "decision" }
const planContext = { ...decisionContext, artifactType: "plan" }
const feedback = {
  targetType: "artifact",
  targetId: "decisions.storage",
  intent: "question",
  severity: "note",
  comment: "需要确认存储方案",
  sourceRefs: [{ type: "decision", path: ".issue-flow/issues/42-login/decision/data/decision-data.json" }],
}

test("local review storage separates Decision and Plan for the same issue", () => {
  addStoredReviewDraft(decisionContext, feedback)
  addStoredReviewDraft(planContext, { ...feedback, targetId: "plan.index", comment: "需要补充计划" })

  assert.equal(loadReviewStorage(decisionContext).drafts[0].comment, "需要确认存储方案")
  assert.equal(loadReviewStorage(planContext).drafts[0].comment, "需要补充计划")
})

test("submitted reviews stay local until approval clears the artifact history", () => {
  const stored = loadReviewStorage(decisionContext)
  const review = {
    id: "visual_review_1",
    state: "submitted",
    status: "changes-requested",
    kind: "decision",
    payload: { items: stored.drafts },
    createdAt: new Date().toISOString(),
  }
  saveSubmittedReview(decisionContext, review)

  assert.equal(loadReviewStorage(decisionContext).drafts.length, 0)
  assert.equal(loadReviewStorage(decisionContext).reviews[0].id, "visual_review_1")

  clearReviewStorage(decisionContext)
  assert.deepEqual(loadReviewStorage(decisionContext), { drafts: [], reviews: [] })
  assert.equal(loadReviewStorage(planContext).drafts.length, 1)
})
