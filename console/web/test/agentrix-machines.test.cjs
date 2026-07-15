const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { machineCliVersion } = require("../src/lib/agentrix-machines.ts")

test("reads CLI version from a machine field or metadata", () => {
  assert.equal(machineCliVersion({ cliVersion: "2.44.0" }), "2.44.0")
  assert.equal(machineCliVersion({ metadata: JSON.stringify({ cliVersion: "2.43.1" }) }), "2.43.1")
})

test("returns an empty version for missing or malformed metadata", () => {
  assert.equal(machineCliVersion({ metadata: null }), "")
  assert.equal(machineCliVersion({ metadata: "encrypted-value" }), "")
})
