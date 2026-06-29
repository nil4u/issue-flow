import type { FastifyReply, FastifyRequest } from "fastify"

const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:8787"

export function configuredWebOrigins() {
  return String(process.env.ISSUE_FLOW_WEB_ORIGIN || DEFAULT_WEB_ORIGIN)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
}

export function firstWebOrigin() {
  return configuredWebOrigins()[0] || DEFAULT_WEB_ORIGIN
}

export function allowedOrigin(origin = "") {
  const configured = configuredWebOrigins()
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

export function cookie(name: string, value: string, options: { maxAge?: number; secure?: boolean } = {}) {
  const parts = [`${name}=${encodeURIComponent(value || "")}`, "Path=/", "HttpOnly", "SameSite=Lax"]
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`)
  }
  if (options.secure) {
    parts.push("Secure")
  }
  return parts.join("; ")
}

export function sessionCookieName(gitServerId = "") {
  const safe = String(gitServerId || "default").replace(/[^a-zA-Z0-9_-]/g, "_")
  return `issue_flow_session_${safe}`
}

export function cookieSecure(request: FastifyRequest) {
  const publicUrl = process.env.ISSUE_FLOW_PUBLIC_URL || ""
  return publicUrl.startsWith("https://") || request.headers["x-forwarded-proto"] === "https"
}

export function publicBaseUrl(request: FastifyRequest) {
  if (process.env.ISSUE_FLOW_PUBLIC_URL) {
    return process.env.ISSUE_FLOW_PUBLIC_URL.replace(/\/+$/, "")
  }
  const forwardedProto = request.headers["x-forwarded-proto"]
  const forwardedHost = request.headers["x-forwarded-host"]
  const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "http"
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || request.headers.host || "127.0.0.1:8788"
  return `${protocol}://${host}`.replace(/\/+$/, "")
}

export function setNoStore(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store")
}
