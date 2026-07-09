import type { FastifyReply, FastifyRequest } from "fastify"

const DEFAULT_APP_URL = "http://127.0.0.1:8787"

export function configuredAppOrigins(env = process.env) {
  return String(env.ISSUE_FLOW_APP_URL || DEFAULT_APP_URL)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function firstAppOrigin(env = process.env) {
  return configuredAppOrigins(env)[0] || DEFAULT_APP_URL
}

export function allowedOrigin(origin = "") {
  const configured = configuredAppOrigins()
  if (!origin) {
    return configured[0] || "*"
  }
  if (configured.includes("*") || configured.includes(origin)) {
    return origin
  }
  return configured[0] || origin
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=")
        if (index === -1) {
          return [item, ""]
        }
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))]
      }),
  )
}

type CookieSameSite = "Lax" | "None" | "Strict"

function sameSiteKey(value = "") {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}`
  } catch {
    return ""
  }
}

export function cookieSameSite(env = process.env): CookieSameSite {
  const apiSite = sameSiteKey(requiredBaseUrl(env))
  const appSite = sameSiteKey(appBaseUrl(env))
  return apiSite && appSite && apiSite !== appSite && requiredBaseUrl(env).startsWith("https://") ? "None" : "Lax"
}

export function cookie(name: string, value: string, options: { maxAge?: number; secure?: boolean; sameSite?: CookieSameSite } = {}) {
  const sameSite = options.sameSite || cookieSameSite()
  const parts = [`${name}=${encodeURIComponent(value || "")}`, "Path=/", "HttpOnly", `SameSite=${sameSite}`]
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`)
  }
  if (options.secure || sameSite === "None") {
    parts.push("Secure")
  }
  return parts.join("; ")
}

export function consoleSessionCookieName() {
  return "issue_flow_sid"
}

export function sessionCookieName(gitServerId = "") {
  const safe = String(gitServerId || "default").replace(/[^a-zA-Z0-9_-]/g, "_")
  return `issue_flow_session_${safe}`
}

// legacy, 仅用于清除旧明文 cookie,绝不读取
export function userCookieName() {
  return "issue_flow_user"
}

export function requiredBaseUrl(env = process.env) {
  const baseUrl = String(env.ISSUE_FLOW_BASE_URL || "").trim().replace(/\/+$/, "")
  if (!baseUrl) {
    throw new Error("ISSUE_FLOW_BASE_URL is required")
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("ISSUE_FLOW_BASE_URL must start with http:// or https://")
  }
  return baseUrl
}

export function appBaseUrl(env = process.env) {
  const firstUrl = String(env.ISSUE_FLOW_APP_URL || firstAppOrigin(env)).split(",")[0] || firstAppOrigin(env)
  const baseUrl = firstUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error("ISSUE_FLOW_APP_URL must start with http:// or https://")
  }
  return baseUrl
}

export function cookieSecure(_request: FastifyRequest) {
  return requiredBaseUrl().startsWith("https://")
}

export function publicBaseUrl() {
  return requiredBaseUrl()
}

export function setNoStore(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store")
}
