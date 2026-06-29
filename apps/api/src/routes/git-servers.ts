import type { FastifyInstance } from "fastify"

import { listGitServers } from "../core/git-servers.js"
import { contextFromRequest } from "../services/issue-flow.js"

export async function gitServerRoutes(app: FastifyInstance) {
  app.get("/api/git-servers", async (request, reply) => {
    const result = await listGitServers(contextFromRequest(request))
    return reply.code(result.status).send(result.body)
  })
}
