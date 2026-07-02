import type { FastifyInstance } from "fastify"

import { getSetupStatus, initializeSetup, setupVerifiedCookieName } from "../core/setup.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { cookie, cookieSecure } from "../utils/http.js"

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
      .header("Set-Cookie", cookie(setupVerifiedCookieName(), result.body.setupToken, {
        maxAge: result.body.setupTokenMaxAge,
        secure: cookieSecure(request),
      }))
      .code(result.status)
      .send({
        ok: true,
        gitServer: result.body.gitServer,
      })
  })
}
