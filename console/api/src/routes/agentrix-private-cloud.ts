import type { FastifyInstance } from "fastify"

import {
  createRunnerGitlabToken,
  getAgentrixPrivateCloudConfig,
  validatePrivateCloudGitServer,
} from "../core/agentrix-private-cloud.js"
import { contextFromRequest, currentUserIdFromRequest } from "../services/issue-flow.js"

// 身份来自 console session;input.gitServerId 是"操作哪个 server"的业务参数,与登录态无关。
export async function agentrixPrivateCloudRoutes(app: FastifyInstance) {
  app.get("/api/agentrix/private-cloud", async (request, reply) => {
    const input = (request.query || {}) as Record<string, unknown>
    const userId = await currentUserIdFromRequest(request)
    const result = await getAgentrixPrivateCloudConfig({
      ...contextFromRequest(request),
      input,
      userId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/agentrix/private-cloud/gitlab-token", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const userId = await currentUserIdFromRequest(request)
    const result = await createRunnerGitlabToken({
      ...contextFromRequest(request),
      input,
      userId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/agentrix/private-cloud/git-server/validate", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const userId = await currentUserIdFromRequest(request)
    const result = await validatePrivateCloudGitServer({
      ...contextFromRequest(request),
      input,
      userId,
    })
    return reply.code(result.status).send(result.body)
  })

}
