import type { FastifyInstance } from "fastify"

import { connectGitlabSession } from "../core/gitlab-auth.js"
import {
  checkGitlabProjectInstall,
  getGitlabProjectRole,
  installGitlabProject,
  listGitlabProjectsWithInstallStatus,
  setGitlabProjectInstallVariable,
  setGitlabProjectInstallWebhook,
} from "../core/gitlab-projects.js"
import { contextFromRequest, sessionFromRequest } from "../services/issue-flow.js"

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

  app.post("/api/gitlab/install", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await installGitlabProject({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })
}
