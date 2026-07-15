const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const {
  findSelectedRepository,
  retainedSelectedProjectId,
  selectedRepositoryForWorkspace,
} = require("../src/lib/repository-selection.ts")

const route = {
  view: "repos",
  gitServerId: "gitlab-main",
  projectId: "42853",
  tab: "overview",
  settingsSection: "account",
}

const selected = {
  id: "repo-user-agent",
  gitServerId: "gitlab-main",
  serverRepoId: "42853",
  projectPath: "aisearch/user_agent",
}

test("route selection survives when the visible page does not contain the repository", () => {
  assert.equal(retainedSelectedProjectId({
    route,
    currentProjectId: "42853",
    projects: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1) })),
    fallbackProject: "none",
  }), "42853")
})

test("selected repository snapshot is independent from visible search results", () => {
  assert.equal(findSelectedRepository([], "42853", "gitlab-main"), undefined)
  assert.equal(selectedRepositoryForWorkspace([], selected, "42853", "gitlab-main"), selected)
  assert.equal(selectedRepositoryForWorkspace([], selected, "42853", "gitlab-other"), undefined)
})

test("empty selection still respects explicit fallback policy", () => {
  const emptyRoute = { ...route, projectId: "" }
  assert.equal(retainedSelectedProjectId({
    route: emptyRoute,
    currentProjectId: "",
    projects: [{ id: "first" }],
    fallbackProject: "none",
  }), "")
  assert.equal(retainedSelectedProjectId({
    route: emptyRoute,
    currentProjectId: "",
    projects: [{ id: "first" }],
    fallbackProject: "first",
  }), "first")
})
