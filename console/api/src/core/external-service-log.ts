type ExternalServiceLogger = {
  info?: (payload: Record<string, unknown>, message?: string) => void
  warn?: (payload: Record<string, unknown>, message?: string) => void
  error?: (payload: Record<string, unknown>, message?: string) => void
}

type ExternalServiceLogLevel = keyof ExternalServiceLogger

type ExternalServiceCall = {
  startedAt: string
  startedAtMs: number
}

type ExternalServiceLogInput = {
  logger?: ExternalServiceLogger
  service: string
  method: string
  url: string | URL
  call: ExternalServiceCall
  status?: number
  error?: unknown
}

const SECRET_QUERY_PATTERN = /([?&](?:access_token|api_key|client_secret|code|private_token|refresh_token|token)=)[^&]+/gi

function externalServiceCallStarted(): ExternalServiceCall {
  return {
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
  }
}

function externalServiceTarget(value: string | URL) {
  try {
    const url = value instanceof URL ? value : new URL(String(value))
    return {
      origin: url.origin,
      path: `${url.pathname}${url.search}`.replace(SECRET_QUERY_PATTERN, "$1[redacted]"),
    }
  } catch {
    return {
      origin: "",
      path: String(value || "").replace(SECRET_QUERY_PATTERN, "$1[redacted]"),
    }
  }
}

function externalServiceError(error: unknown) {
  if (!error || typeof error !== "object") {
    return {
      message: error ? String(error) : "external service request failed",
    }
  }
  const detail = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown }
  return {
    name: String(detail.name || "Error"),
    message: String(detail.message || "external service request failed"),
    code: detail.code === undefined ? undefined : String(detail.code),
    status: detail.status === undefined ? undefined : Number(detail.status),
  }
}

function writeExternalServiceLog(
  logger: ExternalServiceLogger,
  levels: ExternalServiceLogLevel[],
  payload: Record<string, unknown>,
  message: string,
) {
  for (const level of levels) {
    const write = logger[level]
    if (write) {
      write.call(logger, payload, message)
      return
    }
  }
}

function logExternalServiceCall(input: ExternalServiceLogInput) {
  const logger = input.logger
  if (!logger) return

  const finishedAtMs = Date.now()
  const payload: Record<string, unknown> = {
    externalService: input.service,
    method: input.method,
    ...externalServiceTarget(input.url),
    status: input.status,
    durationMs: Math.max(0, finishedAtMs - input.call.startedAtMs),
    startedAt: input.call.startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
  }

  if (input.error) {
    payload.error = externalServiceError(input.error)
    const status = Number(input.status || (payload.error as { status?: number }).status || 0)
    const level = status >= 400 && status < 500 ? "warn" : "error"
    writeExternalServiceLog(
      logger,
      level === "error" ? ["error", "warn", "info"] : ["warn", "info"],
      payload,
      `${input.service} external call failed`,
    )
    return
  }

  writeExternalServiceLog(logger, ["info"], payload, `${input.service} external call completed`)
}

export {
  externalServiceCallStarted,
  logExternalServiceCall,
}
