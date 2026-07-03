import type { FastifyInstance } from "fastify"

import { handleGitlabWebhook } from "../../core/gitlab-webhook.js"
import { contextFromRequest } from "../../services/issue-flow.js"

export async function gitlabWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/gitlab/:repoId", async (request, reply) => {
    const { repoId } = request.params as { repoId: string }
    const rawBody = request.rawBody
      ? request.rawBody.toString("utf8")
      : JSON.stringify(request.body || {})
    const result = await handleGitlabWebhook({
      ...contextFromRequest(request),
      repoId,
      headers: request.headers,
      rawBody,
    })
    return reply.code(result.status).send(result.body)
  })
}
