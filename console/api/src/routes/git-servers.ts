import type { FastifyInstance, FastifyRequest } from "fastify"

import { deleteGitServer, listGitServers, saveGitServer } from "../core/git-servers.js"
import { resolveFreshSession } from "../core/session.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { sessionCookieName, userCookieName } from "../utils/http.js"

async function adminUserIdFromRequest(request: FastifyRequest) {
  const store = request.server.issueFlowStore
  const hintedUserId = request.cookies[userCookieName()] || ""
  const gitServers = await store.listGitServers()
  for (const server of gitServers) {
    const session = await resolveFreshSession({
      store,
      sessionId: request.cookies[sessionCookieName(server.id)] || "",
      gitServerId: server.id,
      logger: request.log,
    })
    const userId = session?.userId || ""
    if (!userId || hintedUserId && userId !== hintedUserId) continue
    const user = await store.getUser(userId)
    if (user?.role === "admin") return userId
  }
  return ""
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
