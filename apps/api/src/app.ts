import Fastify, { type FastifyRequest } from "fastify"
import cors from "@fastify/cors"

import { gitlabAuthRoutes } from "./routes/auth/gitlab.js"
import { gitServerRoutes } from "./routes/git-servers.js"
import { gitlabRoutes } from "./routes/gitlab.js"
import { healthRoutes } from "./routes/health.js"
import { repositoryRoutes } from "./routes/repositories.js"
import { sessionRoutes } from "./routes/session.js"
import { setupRoutes } from "./routes/setup.js"
import { userAgentrixConfigRoutes } from "./routes/user/agentrix-config.js"
import { gitlabWebhookRoutes } from "./routes/webhooks/gitlab.js"
import { errorResponse } from "./core/responses.js"
import { createIssueFlowStore, type IssueFlowStore } from "./storage/store.js"
import { allowedOrigin, parseCookies, requiredBaseUrl, setNoStore } from "./utils/http.js"

export type CreateAppOptions = {
  store?: IssueFlowStore
  storeOptions?: Record<string, unknown>
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

  app.decorate("issueFlowStore", options.store || createIssueFlowStore(options.storeOptions || {}))

  app.addHook("onRequest", async (request) => {
    request.cookies = parseCookies(request.headers.cookie || "")
  })

  app.addHook("onSend", async (_request, reply, payload) => {
    setNoStore(reply)
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
    methods: ["GET", "POST", "OPTIONS"],
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
  await app.register(userAgentrixConfigRoutes)
  await app.register(repositoryRoutes)
  await app.register(gitlabRoutes)
  await app.register(gitlabWebhookRoutes)

  app.get("/api", async () => ({
    name: "issue-flow API",
    version: "0.2.0",
  }))

  if (app.issueFlowStore.ready) {
    await app.issueFlowStore.ready
  }

  return app
}
