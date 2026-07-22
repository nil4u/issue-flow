import type { FastifyInstance, FastifyRequest } from "fastify"

import { createIssue, getIssue, getIssueMentionUsers, listIssueLabels, listIssues, renderIssueMarkdown, submitIssueComment, updateIssue, updateIssueState } from "../core/issues.js"
import { contextFromRequest, currentUserIdFromRequest, sessionFromRequest } from "../services/issue-flow.js"

async function providerSession(request: FastifyRequest, gitServerId: string) {
  const session = await sessionFromRequest(request, gitServerId)
  return { session, userId: session?.userId || await currentUserIdFromRequest(request) }
}

export async function issueRoutes(app: FastifyInstance) {
  app.get("/api/issues/:gitServerId/:projectId", async (request) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    return listIssues({ ...contextFromRequest(request), gitServerId, projectId, ...await providerSession(request, gitServerId), input: request.query || {} })
  })

  app.post("/api/issues/:gitServerId/:projectId", async (request, reply) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    const result = await createIssue({ ...contextFromRequest(request), gitServerId, projectId, ...await providerSession(request, gitServerId), input: request.body || {} })
    return reply.code(201).send(result)
  })

  app.get("/api/issues/:gitServerId/:projectId/metadata", async (request) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    return listIssueLabels({ ...contextFromRequest(request), gitServerId, projectId, ...await providerSession(request, gitServerId) })
  })

  app.post("/api/issues/:gitServerId/:projectId/markdown", async (request) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    return renderIssueMarkdown({ ...contextFromRequest(request), gitServerId, projectId, ...await providerSession(request, gitServerId), input: request.body || {} })
  })

  app.get("/api/issues/:gitServerId/:projectId/:issueNumber", async (request) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    return getIssue({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await providerSession(request, gitServerId) })
  })

  app.get("/api/issues/:gitServerId/:projectId/:issueNumber/mentions", async (request) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    return getIssueMentionUsers({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await providerSession(request, gitServerId) })
  })

  app.patch("/api/issues/:gitServerId/:projectId/:issueNumber", async (request) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    return updateIssue({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await providerSession(request, gitServerId), input: request.body || {} })
  })

  app.post("/api/issues/:gitServerId/:projectId/:issueNumber/comments", async (request, reply) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    const result = await submitIssueComment({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await providerSession(request, gitServerId), input: request.body || {} })
    return reply.code(201).send(result)
  })

  app.post("/api/issues/:gitServerId/:projectId/:issueNumber/state", async (request) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    return updateIssueState({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await providerSession(request, gitServerId), input: request.body || {} })
  })
}
