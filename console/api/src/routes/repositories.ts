import type { FastifyInstance } from "fastify"

import {
  configureRepositoryAgentrix,
  createRepository,
  getRepository,
  listGitEvents,
  listIssues,
  listTasks,
  listRepositories,
  syncIssuesSnapshot,
  validateRepositoryToken,
} from "../core/repositories.js"
import { contextFromRequest, currentUserIdFromRequest } from "../services/issue-flow.js"

async function userIdFromRequest(request: Parameters<typeof contextFromRequest>[0]) {
  return currentUserIdFromRequest(request)
}

export async function repositoryRoutes(app: FastifyInstance) {
  app.get("/api/repositories", async (request, reply) => {
    const input = (request.query || {}) as Record<string, unknown>
    const result = await listRepositories({
      ...contextFromRequest(request),
      input,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const result = await createRepository({
      ...contextFromRequest(request),
      input,
      userId: await userIdFromRequest(request),
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

  app.get("/api/repositories/:repoId/issues", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await listIssues({
      ...contextFromRequest(request),
      repoId,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId/tasks", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await listTasks({
      ...contextFromRequest(request),
      repoId,
      input: (request.query || {}) as Record<string, unknown>,
      userId: await userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/issues/sync", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await syncIssuesSnapshot({
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
