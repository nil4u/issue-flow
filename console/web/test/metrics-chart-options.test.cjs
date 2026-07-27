const assert = require("node:assert/strict")
const test = require("node:test")

require("tsx/cjs")

const { buildChartOption } = require("../src/lib/metrics-chart-options.ts")

test("docs issue type keeps its configured order, color, and tooltip identity", () => {
  const option = buildChartOption(
    {
      chartType: "stacked_bar",
      xField: "week",
      yFields: ["issue_count"],
      y2Fields: [],
      stackField: "issue_type",
      visualConfig: {
        stackOrder: ["type::feature", "type::docs", "未分类"],
        fieldLabels: { issue_count: "数量" },
      },
      drillQuerySql: "select 1",
    },
    {
      columns: [],
      rows: [
        { week: "2026-07-20", issue_type: "未分类", issue_count: 1 },
        { week: "2026-07-20", issue_type: "type::docs", issue_count: 2 },
        { week: "2026-07-20", issue_type: "type::feature", issue_count: 3 },
      ],
    },
  )
  const bars = option.series.filter((series) => String(series.id).startsWith("bar:"))

  assert.deepEqual(bars.map((series) => series.name), ["type::feature", "type::docs", "未分类"])
  assert.equal(bars[1].color, "#d97706")
  assert.equal(bars[1].cursor, "pointer")
  const tooltip = option.tooltip.formatter({
    seriesId: bars[1].id,
    seriesName: "type::docs",
    name: "2026-07-20",
    value: 2,
  })
  assert.match(tooltip, /type::docs/)
  assert.match(tooltip, /background:#d97706/)
});
