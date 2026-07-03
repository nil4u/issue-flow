import type { FastifyInstance } from "fastify"

import { connectGitlabSession } from "../core/gitlab-auth.js"
import {
  checkGitlabProjectInstall,
  getGitlabProjectRole,
  installGitlabProjectPlugin,
  listGitlabProjectsWithInstallStatus,
  setGitlabProjectInstallPermission,
  setGitlabProjectInstallRunner,
  setGitlabProjectInstallVariable,
  setGitlabProjectInstallWebhook,
} from "../core/gitlab-projects.js"
import { contextFromRequest, sessionFromRequest } from "../services/issue-flow.js"
import { allowedOrigin } from "../utils/http.js"

export async function gitlabRoutes(app: FastifyInstance) {
  app.post("/api/gitlab/connect", async (request, reply) => {
    const result = await connectGitlabSession({
      ...contextFromRequest(request),
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/gitlab/projects", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const session = await sessionFromRequest(request, gitServerId)
    const result = await listGitlabProjectsWithInstallStatus({
      ...contextFromRequest(request),
      input: { gitServerId },
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/projects", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await listGitlabProjectsWithInstallStatus({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/gitlab/install-check", async (request, reply) => {
    const input = (request.query || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await checkGitlabProjectInstall({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-check", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await checkGitlabProjectInstall({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/project-role", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await getGitlabProjectRole({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-permission", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await setGitlabProjectInstallPermission({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-variable", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await setGitlabProjectInstallVariable({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-webhook", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await setGitlabProjectInstallWebhook({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-runner", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await setGitlabProjectInstallRunner({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-plugin", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await installGitlabProjectPlugin({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/gitlab/install-plugin/stream", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))

    reply.hijack()
    const origin = String(request.headers.origin || "")
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowedOrigin(origin),
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    })

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`)
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const result = await installGitlabProjectPlugin({
        ...contextFromRequest(request),
        input: {
          ...input,
          onProgress: (step: unknown) => send("progress", step),
        },
        session,
      })
      if (result.status >= 400) {
        send("error", result.body)
      } else {
        send("complete", result.body)
      }
    } catch (error) {
      send("error", {
        error: error instanceof Error ? error.message : "install_plugin_stream_failed",
      })
    } finally {
      reply.raw.end()
    }
  })

}
