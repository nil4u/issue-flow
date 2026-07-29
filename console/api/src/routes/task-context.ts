import type { FastifyInstance } from "fastify"

import { getTaskContext } from "../core/task-context.js"
import { contextFromRequest } from "../services/issue-flow.js"

export async function taskContextRoutes(app: FastifyInstance) {
  app.get("/api/repositories/:gitServerId/:projectId/issues/:issueNumber/task-context", async (request, reply) => {
    const { gitServerId, projectId, issueNumber } = request.params as { gitServerId: string; projectId: string; issueNumber: string }
    const { phase } = request.query as { phase?: string }
    const result = await getTaskContext({
      ...contextFromRequest(request),
      gitServerId,
      projectId,
      issueNumber,
      phase,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/repositories/:repoId/issues/:issueNumber/task-context", async (request, reply) => {
    const { repoId, issueNumber } = request.params as { repoId: string; issueNumber: string }
    const { phase } = request.query as { phase?: string }
    const result = await getTaskContext({
      ...contextFromRequest(request),
      repoId,
      issueNumber,
      phase,
    })
    return reply.code(result.status).send(result.body)
  })
}
