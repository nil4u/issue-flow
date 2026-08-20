const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { drillParamsFromChartEvent } = require("../src/lib/metrics-drill-selection.ts")

test("wait segment in a percent-stacked chart opens its drilldown", () => {
  const params = drillParamsFromChartEvent(
    {
      drillConfig: {
        xParam: "week",
        seriesParam: "component",
        allowedSeries: ["wait"],
      },
    },
    {
      seriesId: "percent:seconds:wait",
      seriesName: "wait",
      name: "2026-08-17",
    },
  )

  assert.deepEqual(params, { week: "2026-08-17", component: "wait" })
})

test("agent segment remains non-interactive when only wait is allowed", () => {
  const params = drillParamsFromChartEvent(
    {
      drillConfig: {
        xParam: "week",
        seriesParam: "component",
        allowedSeries: ["wait"],
      },
    },
    {
      seriesId: "percent:seconds:agent",
      seriesName: "agent",
      name: "2026-08-17",
    },
  )

  assert.equal(params, undefined)
})
