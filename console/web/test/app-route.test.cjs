const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { parseVisualArtifactRoute } = require("../src/app-route.ts")

test("visual artifact route is shared by Decision and Plan for one issue", () => {
  assert.deepEqual(
    parseVisualArtifactRoute("/repos/gitlab-main/43326/plan/42"),
    { gitServerId: "gitlab-main", projectId: "43326", issueNumber: 42 },
  )
})

test("visual artifact route rejects artifact-specific and invalid paths", () => {
  assert.equal(parseVisualArtifactRoute("/repos/gitlab-main/43326/plan/42/decision"), undefined)
  assert.equal(parseVisualArtifactRoute("/repos/gitlab-main/43326/plan/42/plan"), undefined)
  assert.equal(parseVisualArtifactRoute("/repos/gitlab-main/43326/plan/not-a-number"), undefined)
})
