import type { FastifyInstance } from "fastify"

import { getDashboard, listDashboards, queryRepositoryDashboardPanel } from "../core/dashboards.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { userCookieName } from "../utils/http.js"

function userIdFromRequest(request: Parameters<typeof contextFromRequest>[0]) {
  return request.cookies[userCookieName()] || ""
}

export async function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboards", async (request, reply) => {
    const result = await listDashboards({
      ...contextFromRequest(request),
      userId: userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/dashboards/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const result = await getDashboard({
      ...contextFromRequest(request),
      slug,
      userId: userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/repositories/:repoId/dashboards/:slug/panels/:panelId/query", async (request, reply) => {
    const { repoId, slug, panelId } = request.params as { repoId: string; slug: string; panelId: string }
    const result = await queryRepositoryDashboardPanel({
      ...contextFromRequest(request),
      repoId,
      slug,
      panelId,
      input: (request.body || {}) as Record<string, unknown>,
      userId: userIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })
}
