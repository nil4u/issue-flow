const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { hasRepoSettingsData } = require("../src/lib/repo-settings.ts")

test("empty repository settings have no checked data", () => {
  assert.equal(hasRepoSettingsData(undefined), false)
  assert.equal(hasRepoSettingsData({}), false)
  assert.equal(
    hasRepoSettingsData({
      permissions: { items: [] },
      variables: { items: [] },
      webhook: {},
      plugins: { items: [] },
      runners: { items: [] },
    }),
    false
  )
})

test("repository settings count timestamps, items, and webhook fields as data", () => {
  assert.equal(
    hasRepoSettingsData({
      permissions: { items: [], checkedAt: "2026-07-15T00:00:00Z" },
    }),
    true
  )
  assert.equal(
    hasRepoSettingsData({
      variables: { items: [{ key: "AGENTRIX_API_KEY" }] },
    }),
    true
  )
  assert.equal(
    hasRepoSettingsData({ webhook: { checkedAt: "2026-07-15T00:00:00Z" } }),
    true
  )
})
