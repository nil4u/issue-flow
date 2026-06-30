import type { FastifyInstance } from "fastify"

import { getSession } from "../core/session.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { sessionCookieName } from "../utils/http.js"

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/session", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const result = await getSession({
      ...contextFromRequest(request),
      sessionId: request.cookies[sessionCookieName(gitServerId)] || "",
    })
    return reply.code(result.status).send(result.body)
  })
}
