import type { FastifyInstance } from "fastify"

import {
  getUserAgentrixConfig,
  updateUserAgentrixConfig,
} from "../../core/user-agentrix-config.js"
import { contextFromRequest, sessionFromRequest } from "../../services/issue-flow.js"

export async function userAgentrixConfigRoutes(app: FastifyInstance) {
  app.get("/api/user/agentrix-config", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const session = await sessionFromRequest(request, gitServerId)
    const result = await getUserAgentrixConfig({
      ...contextFromRequest(request),
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/user/agentrix-config", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await updateUserAgentrixConfig({
      ...contextFromRequest(request),
      session,
      input,
    })
    return reply.code(result.status).send(result.body)
  })
}
