import type { FastifyInstance } from "fastify"

import {
  createRunnerGitlabToken,
  getAgentrixPrivateCloudConfig,
  validatePrivateCloudGitServer,
} from "../core/agentrix-private-cloud.js"
import { contextFromRequest, sessionFromRequest } from "../services/issue-flow.js"

export async function agentrixPrivateCloudRoutes(app: FastifyInstance) {
  app.get("/api/agentrix/private-cloud", async (request, reply) => {
    const input = (request.query || {}) as Record<string, unknown>
    const gitServerId = String(input.gitServerId || "")
    const session = await sessionFromRequest(request, gitServerId)
    const result = await getAgentrixPrivateCloudConfig({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/agentrix/private-cloud/gitlab-token", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await createRunnerGitlabToken({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

  app.post("/api/agentrix/private-cloud/git-server/validate", async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const session = await sessionFromRequest(request, String(input.gitServerId || ""))
    const result = await validatePrivateCloudGitServer({
      ...contextFromRequest(request),
      input,
      session,
    })
    return reply.code(result.status).send(result.body)
  })

}
