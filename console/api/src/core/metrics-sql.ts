// @ts-nocheck

const METRICS_SQL_SOURCES = new Set([
  "issue_stats",
  "issues",
  "weekly_issue_metrics",
  "issue_flow_metrics",
  "task_execution_metrics",
  "wip_aging_metrics",
  "metric_size_weights",
])

const METRICS_SQL_PARAMS = new Set([
  "from",
  "to",
  "weeks",
  "git_server_id",
  "repository_id",
  "week",
  "bucket",
  "type",
  "priority",
  "size",
])

const METRICS_STATEMENT_TIMEOUT_MS = 5000
const METRICS_MAX_ROWS = 5000

const BLOCKED_STATEMENT_PATTERN = /\b(insert|update|delete|merge|drop|alter|create|truncate|copy|grant|revoke|call|do|execute|listen|notify|lock|vacuum|reset|set|comment|prepare|deallocate|declare|fetch|import|refresh)\b/i
const BLOCKED_FUNCTION_PATTERN = /\bpg_[a-z_]*\s*\(/i
const CTE_NAME_PATTERN = /(?:\bwith|,)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+as\s*\(/gi
const SOURCE_PATTERN = /(?<!:)\b(from|join)\s+("?[a-zA-Z_][a-zA-Z0-9_".]*)/gi
const PARAM_PATTERN = /(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g
const EXTRACT_FIELDS = new Set([
  "epoch", "century", "day", "decade", "dow", "doy", "hour", "isodow", "isoyear",
  "julian", "microseconds", "millennium", "milliseconds", "minute", "month",
  "quarter", "second", "timezone", "timezone_hour", "timezone_minute", "week", "year",
])

function metricsSqlError(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code)
  error.status = 400
  error.code = code
  return error
}

function normalizeMetricsSql(sql) {
  return String(sql || "").trim().replace(/;+\s*$/, "")
}

function precedingWord(sql, offset) {
  const head = sql.slice(0, offset)
  const match = head.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*$/)
  return match ? match[1].toLowerCase() : ""
}

function assertReadOnlyMetricsSql(sql) {
  const normalized = normalizeMetricsSql(sql)
  if (!normalized) {
    throw metricsSqlError("metrics_sql_required")
  }
  if (normalized.includes(";")) {
    throw metricsSqlError("metrics_sql_single_statement_required")
  }
  if (normalized.includes("--") || normalized.includes("/*")) {
    throw metricsSqlError("metrics_sql_comment_blocked")
  }
  if (!/^(select|with)\b/i.test(normalized)) {
    throw metricsSqlError("metrics_sql_select_only")
  }
  const blocked = normalized.match(BLOCKED_STATEMENT_PATTERN)
  if (blocked) {
    throw metricsSqlError("metrics_sql_statement_blocked", blocked[1].toLowerCase())
  }
  if (BLOCKED_FUNCTION_PATTERN.test(normalized)) {
    throw metricsSqlError("metrics_sql_function_blocked")
  }

  const cteNames = new Set()
  for (const match of normalized.matchAll(CTE_NAME_PATTERN)) {
    cteNames.add(match[1].toLowerCase())
  }
  for (const match of normalized.matchAll(SOURCE_PATTERN)) {
    if (EXTRACT_FIELDS.has(precedingWord(normalized, match.index))) continue
    const raw = match[2].replace(/"/g, "")
    const name = raw.toLowerCase()
    if (raw.includes(".") || (!METRICS_SQL_SOURCES.has(name) && !cteNames.has(name))) {
      throw metricsSqlError("metrics_sql_source_blocked", raw)
    }
  }
  return normalized
}

function metricsParamValue(name, value) {
  if (name === "weeks") {
    const weeks = Number(value)
    if (!Number.isInteger(weeks) || weeks <= 0 || weeks > 104) {
      throw metricsSqlError("metrics_sql_param_invalid", name)
    }
    return weeks
  }
  return String(value)
}

function metricsParamCast(name) {
  return name === "from" || name === "to" ? "::timestamp" : ""
}

function bindMetricsParams(sql, params = {}) {
  const values = []
  const indexByName = new Map()
  const text = String(sql || "").replace(PARAM_PATTERN, (_matched, name) => {
    if (!METRICS_SQL_PARAMS.has(name)) {
      throw metricsSqlError("metrics_sql_param_blocked", name)
    }
    const value = params[name]
    if (value === undefined || value === null || value === "") {
      throw metricsSqlError("metrics_sql_param_required", name)
    }
    if (!indexByName.has(name)) {
      values.push(metricsParamValue(name, value))
      indexByName.set(name, values.length)
    }
    return `$${indexByName.get(name)}${metricsParamCast(name)}`
  })
  return { text, values }
}

function metricsCellValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === "bigint") return Number(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object" && typeof value.toNumber === "function") return value.toNumber()
  return value
}

function metricsColumnType(value) {
  if (value === null || value === undefined) return ""
  if (typeof value === "bigint") return "number"
  if (value instanceof Date) return "date"
  if (typeof value === "object" && typeof value.toNumber === "function") return "number"
  if (typeof value === "number") return "number"
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "object") return "json"
  return "string"
}

function metricsResultFromRows(rawRows = [], maxRows = METRICS_MAX_ROWS) {
  const truncated = rawRows.length > maxRows
  const limited = truncated ? rawRows.slice(0, maxRows) : rawRows
  const columnNames = limited.length ? Object.keys(limited[0]) : []
  const columns = columnNames.map((name) => {
    let type = ""
    for (const row of limited) {
      type = metricsColumnType(row[name])
      if (type) break
    }
    return { name, type: type || "string" }
  })
  const rows = limited.map((row) => {
    const next = {}
    for (const name of columnNames) {
      next[name] = metricsCellValue(row[name])
    }
    return next
  })
  return { columns, rows, truncated }
}

export {
  METRICS_MAX_ROWS,
  METRICS_SQL_PARAMS,
  METRICS_SQL_SOURCES,
  METRICS_STATEMENT_TIMEOUT_MS,
  assertReadOnlyMetricsSql,
  bindMetricsParams,
  metricsResultFromRows,
  normalizeMetricsSql,
}
