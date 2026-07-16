import type { FastifyInstance } from "fastify"

import {
  getUserAgentrixCloudMachines,
  getUserAgentrixConfig,
  getUserAgentrixResources,
  updateUserAgentrixConfig,
} from "../../core/user-agentrix-config.js"
import { contextFromRequest, currentUserIdFromRequest } from "../../services/issue-flow.js"

// gitServerId query/body 参数不再参与身份解析:继续接受但忽略(前端兼容)。
export async function userAgentrixConfigRoutes(app: FastifyInstance) {
  app.get("/api/user/agentrix-config", async (request, reply) => {
    const userId = await currentUserIdFromRequest(request)
    const user = userId ? await request.server.issueFlowStore.getUser(userId, { includeAccounts: true }) : undefined
    const result = await getUserAgentrixConfig({
      ...contextFromRequest(request),
      userId,
      user,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/user/agentrix-resources", async (request, reply) => {
    const userId = await currentUserIdFromRequest(request)
    const user = userId ? await request.server.issueFlowStore.getUser(userId, { includeAccounts: true }) : undefined
    const result = await getUserAgentrixResources({
      ...contextFromRequest(request),
      userId,
      user,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get<{ Params: { cloudId: string } }>("/api/user/agentrix-resources/clouds/:cloudId/machines", async (request, reply) => {
    const userId = await currentUserIdFromRequest(request)
    const user = userId ? await request.server.issueFlowStore.getUser(userId, { includeAccounts: true }) : undefined
    const result = await getUserAgentrixCloudMachines({
      ...contextFromRequest(request),
      userId,
      user,
      cloudId: request.params.cloudId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/user/agentrix-config", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const userId = await currentUserIdFromRequest(request)
    const result = await updateUserAgentrixConfig({
      ...contextFromRequest(request),
      userId,
      input,
    })
    return reply.code(result.status).send(result.body)
  })
}
