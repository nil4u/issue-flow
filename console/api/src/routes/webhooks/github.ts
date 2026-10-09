import type { FastifyInstance } from 'fastify'
import { handleGithubWebhook } from '../../core/github/webhook.js'

export async function githubWebhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/github', async (request, reply) => {
    const result = await handleGithubWebhook({ store: request.server.issueFlowStore, headers: request.headers, rawBody: request.rawBody || Buffer.alloc(0) })
    return reply.code(result.status).send(result.body)
  })
}
