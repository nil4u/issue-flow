import type { FastifyInstance } from "fastify"

import { listInstalledAutomations } from "../core/insights.js"
import { contextFromRequest, currentUserIdFromRequest } from "../services/issue-flow.js"

export async function insightsRoutes(app: FastifyInstance) {
  app.get("/api/insights/installations", async (request, reply) => {
    const query = request.query as { page?: string; perPage?: string }
    const result = await listInstalledAutomations({
      ...contextFromRequest(request),
      userId: await currentUserIdFromRequest(request),
      page: query.page,
      perPage: query.perPage,
    })
    return reply.code(result.status).send(result.body)
  })
}
