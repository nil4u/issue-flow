import type { FastifyInstance } from "fastify"

import {
  deleteUserGitPat,
  getUserGitPat,
  getUserGitPats,
  validateUserGitPat,
} from "../../core/user-git-pats.js"
import { contextFromRequest, currentUserIdFromRequest } from "../../services/issue-flow.js"

export async function userGitPatRoutes(app: FastifyInstance) {
  app.get("/api/user/git-pats", async (request, reply) => {
    const result = await getUserGitPats({
      ...contextFromRequest(request),
      userId: await currentUserIdFromRequest(request),
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/user/git-pats/:gitServerId", async (request, reply) => {
    const result = await getUserGitPat({
      ...contextFromRequest(request),
      userId: await currentUserIdFromRequest(request),
      gitServerId: String((request.params as Record<string, unknown>).gitServerId || ""),
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/user/git-pats/:gitServerId", async (request, reply) => {
    const result = await validateUserGitPat({
      ...contextFromRequest(request),
      userId: await currentUserIdFromRequest(request),
      gitServerId: String((request.params as Record<string, unknown>).gitServerId || ""),
      input: request.body || {},
    })
    return reply.code(result.status).send(result.body)
  })

  app.delete("/api/user/git-pats/:gitServerId", async (request, reply) => {
    const result = await deleteUserGitPat({
      ...contextFromRequest(request),
      userId: await currentUserIdFromRequest(request),
      gitServerId: String((request.params as Record<string, unknown>).gitServerId || ""),
    })
    return reply.code(result.status).send(result.body)
  })
}
