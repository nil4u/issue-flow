import type { FastifyInstance } from "fastify"

import {
  configureRepositoryAgentrix,
  createRepository,
  getRepository,
  listGitEvents,
  listRepositories,
  validateRepositoryToken,
} from "../core/repositories.js"
import { contextFromRequest, sessionFromRequest } from "../services/issue-flow.js"
import { userCookieName } from "../utils/http.js"

async function userIdFromRequest(request: Parameters<typeof contextFromRequest>[0], gitServerId = "") {
  const session = gitServerId ? await sessionFromRequest(request, gitServerId) : undefined
  return session?.userId || request.cookies[userCookieName()] || ""
}

export async function repositoryRoutes(app: FastifyInstance) {
  app.get("/api/repositories", async (request, reply) => {
    const input = (request.query || {}) as Record<string, unknown>
    const gitServerId = String(input.gitServerId || "")
    const result = await listRepositories({
      ...contextFromRequest(request),
      input,
      userId: await userIdFromRequest(request, gitServerId),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const result = await createRepository({
      ...contextFromRequest(request),
      input,
      userId: await userIdFromRequest(request, String(input.gitServerId || "")),
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await getRepository({
      ...contextFromRequest(request),
      repoId,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId/git-events", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await listGitEvents({
      ...contextFromRequest(request),
      repoId,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/validate-token", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await validateRepositoryToken({
      ...contextFromRequest(request),
      repoId,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/configure-agentrix", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await configureRepositoryAgentrix({
      ...contextFromRequest(request),
      repoId,
      userId: await userIdFromRequest(request),
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })
}
