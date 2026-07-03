import type { FastifyInstance } from "fastify"

import { getSetupStatus, initializeSetup } from "../core/setup.js"
import { contextFromRequest } from "../services/issue-flow.js"

export async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async (request, reply) => {
    const result = await getSetupStatus(contextFromRequest(request))
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/setup/initialize", async (request, reply) => {
    const result = await initializeSetup({
      ...contextFromRequest(request),
      input: request.body || {},
    })
    if (result.status !== 201) {
      return reply.code(result.status).send(result.body)
    }
    return reply
      .code(result.status)
      .send({
        ok: true,
        gitServer: result.body.gitServer,
        authorizeUrl: result.body.authorizeUrl,
      })
  })
}
