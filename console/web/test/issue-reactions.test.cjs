const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { issueReactionSymbol } = require("../src/components/issues/issue-reactions.ts")

test("issue reactions use provider-compatible symbols and preserve unknown names", () => {
  assert.equal(issueReactionSymbol("+1"), "👍")
  assert.equal(issueReactionSymbol("thumbsup"), "👍")
  assert.equal(issueReactionSymbol("party_parrot"), ":party_parrot:")
})
