import type { FastifyInstance } from "fastify"

import {
  configureRepositoryAgentrix,
  createRepository,
  getRepository,
  listDeliveries,
  listDispatchRuns,
  listRepositories,
  rotateRepositoryWebhookSecret,
  validateRepositoryToken,
} from "../core/repositories.js"
import { contextFromRequest } from "../services/issue-flow.js"

export async function repositoryRoutes(app: FastifyInstance) {
  app.get("/api/repositories", async (request, reply) => {
    const result = await listRepositories(contextFromRequest(request))
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories", async (request, reply) => {
    const result = await createRepository({
      ...contextFromRequest(request),
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await getRepository({
      ...contextFromRequest(request),
      repoId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId/deliveries", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await listDeliveries({
      ...contextFromRequest(request),
      repoId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId/runs", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await listDispatchRuns({
      ...contextFromRequest(request),
      repoId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/validate-token", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await validateRepositoryToken({
      ...contextFromRequest(request),
      repoId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/rotate-webhook-secret", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await rotateRepositoryWebhookSecret({
      ...contextFromRequest(request),
      repoId,
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/configure-agentrix", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const result = await configureRepositoryAgentrix({
      ...contextFromRequest(request),
      repoId,
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })
}
