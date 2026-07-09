import type { FastifyInstance, FastifyRequest } from "fastify"

import { deleteGitServer, listGitServers, saveGitServer } from "../core/git-servers.js"
import { contextFromRequest, currentUserIdFromRequest } from "../services/issue-flow.js"

async function adminUserIdFromRequest(request: FastifyRequest) {
  const userId = await currentUserIdFromRequest(request)
  if (!userId) return ""
  const user = await request.server.issueFlowStore.getUser(userId)
  return user?.role === "admin" ? userId : ""
}

export async function gitServerRoutes(app: FastifyInstance) {
  app.get("/api/git-servers", async (request, reply) => {
    const result = await listGitServers(contextFromRequest(request))
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/git-servers", async (request, reply) => {
    const result = await saveGitServer({
      ...contextFromRequest(request),
      userId: await adminUserIdFromRequest(request),
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })

  app.delete("/api/git-servers/:gitServerId", async (request, reply) => {
    const result = await deleteGitServer({
      ...contextFromRequest(request),
      userId: await adminUserIdFromRequest(request),
      gitServerId: String((request.params as Record<string, unknown>).gitServerId || ""),
    })
    return reply.code(result.status).send(result.body)
  })
}
