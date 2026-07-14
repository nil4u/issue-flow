import fs from "node:fs"
import path from "node:path"
import Fastify, { type FastifyRequest } from "fastify"
import cors from "@fastify/cors"

import { agentrixPrivateCloudRoutes } from "./routes/agentrix-private-cloud.js"
import { gitlabAuthRoutes } from "./routes/auth/gitlab.js"
import { dashboardRoutes } from "./routes/dashboards.js"
import { gitServerRoutes } from "./routes/git-servers.js"
import { gitlabRoutes } from "./routes/gitlab.js"
import { healthRoutes } from "./routes/health.js"
import { repositoryRoutes } from "./routes/repositories.js"
import { sessionRoutes } from "./routes/session.js"
import { setupRoutes } from "./routes/setup.js"
import { userAgentrixConfigRoutes } from "./routes/user/agentrix-config.js"
import { userGitPatRoutes } from "./routes/user/git-pats.js"
import { gitlabWebhookRoutes } from "./routes/webhooks/gitlab.js"
import { attachAgentrixForwardServer } from "./core/agentrix-forward.js"
import { errorResponse } from "./core/responses.js"
import { ensureSetupCode } from "./core/setup.js"
import { createIssueFlowStore, type IssueFlowStore } from "./storage/store.js"
import { allowedOrigin, parseCookies, requiredBaseUrl, setNoStore } from "./utils/http.js"

export type CreateAppOptions = {
  store?: IssueFlowStore
  storeOptions?: Record<string, unknown>
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

function webDistDir() {
  const root = path.resolve(__dirname, "../../..")
  return path.resolve(process.env.ISSUE_FLOW_WEB_DIST_DIR || path.join(root, "console/web/dist"))
}

function staticCandidate(root: string, pathname: string) {
  const decoded = decodeURIComponent(pathname)
  const target = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`)
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : ""
}

async function readableStaticFile(root: string, pathname: string) {
  const candidate = staticCandidate(root, pathname)
  if (candidate) {
    const stat = await fs.promises.stat(candidate).catch(() => undefined)
    if (stat?.isFile()) return candidate
  }
  if (path.extname(pathname)) return ""
  const fallback = path.join(root, "index.html")
  const stat = await fs.promises.stat(fallback).catch(() => undefined)
  return stat?.isFile() ? fallback : ""
}

async function sendStaticWeb(request: FastifyRequest, reply: any) {
  const pathname = new URL(request.url, "http://issue-flow.local").pathname
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return reply.code(404).send({ error: "not_found" })
  }
  const file = await readableStaticFile(webDistDir(), pathname)
  if (!file) return reply.code(404).send({ error: "web_dist_not_found" })
  const isIndex = path.basename(file) === "index.html"
  reply.header("Cache-Control", isIndex ? "no-cache" : "public, max-age=31536000, immutable")
  reply.type(MIME_TYPES[path.extname(file)] || "application/octet-stream")
  return reply.send(fs.createReadStream(file))
}

export async function createApp(options: CreateAppOptions = {}) {
  requiredBaseUrl()

  const app = Fastify({
    logger: {
      level: process.env.ISSUE_FLOW_LOG_LEVEL || "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.private-token",
        "req.headers.x-gitlab-token",
        "res.headers.set-cookie",
        "*.token",
        "*.apiKey",
        "*.clientSecret",
        "*.secret",
        "*.webhookSecret",
      ],
    },
  })
  ensureSetupCode({ logger: app.log })

  app.decorate("issueFlowStore", options.store || createIssueFlowStore(options.storeOptions || {}))

  app.addHook("onRequest", async (request) => {
    request.cookies = parseCookies(request.headers.cookie || "")
  })

  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = new URL(request.url, "http://issue-flow.local").pathname
    if (pathname === "/health" || pathname.startsWith("/api/")) {
      setNoStore(reply)
    }
    return payload
  })

  app.setErrorHandler((error, _request, reply) => {
    const result = errorResponse(error)
    reply.code(result.status).send(result.body)
  })

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, async (request: FastifyRequest, body: Buffer) => {
    request.rawBody = body
    if (!body.length) {
      return {}
    }
    return JSON.parse(body.toString("utf8"))
  })

  await app.register(cors, {
    origin: (origin, callback) => callback(null, allowedOrigin(origin || "")),
    credentials: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "If-Modified-Since",
      "If-None-Match",
      "X-Gitlab-Token",
      "X-Gitlab-Event",
      "X-Gitlab-Event-UUID",
      "X-Gitlab-Delivery",
      "X-Request-Id",
    ],
  })

  await app.register(healthRoutes)
  await app.register(setupRoutes)
  await app.register(sessionRoutes)
  await app.register(gitServerRoutes)
  await app.register(gitlabAuthRoutes)
  await app.register(agentrixPrivateCloudRoutes)
  await app.register(userAgentrixConfigRoutes)
  await app.register(userGitPatRoutes)
  await app.register(repositoryRoutes)
  await app.register(dashboardRoutes)
  await app.register(gitlabRoutes)
  await app.register(gitlabWebhookRoutes)

  app.get("/api", async () => ({
    name: "issue-flow API",
    version: "0.2.0",
  }))

  app.get("/*", sendStaticWeb)

  attachAgentrixForwardServer(app)

  if (app.issueFlowStore.ready) {
    await app.issueFlowStore.ready
  }

  return app
}
