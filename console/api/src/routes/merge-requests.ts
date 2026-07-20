import type { FastifyInstance, FastifyRequest } from "fastify"

import { getMergeRequest, listMergeRequests, mergeMergeRequest, submitMergeRequestReview, updateMergeRequestState } from "../core/merge-requests.js"
import { contextFromRequest, currentUserIdFromRequest, sessionFromRequest } from "../services/issue-flow.js"

async function providerSession(request: FastifyRequest, gitServerId: string) {
  const session = await sessionFromRequest(request, gitServerId)
  return { session, userId: session?.userId || await currentUserIdFromRequest(request) }
}

export async function mergeRequestRoutes(app: FastifyInstance) {
  app.get("/api/merge-requests/:gitServerId/:projectId", async (request) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    return listMergeRequests({ ...contextFromRequest(request), gitServerId, projectId, ...await providerSession(request, gitServerId), input: request.query || {} })
  })

  app.get("/api/merge-requests/:gitServerId/:projectId/:mergeRequestNumber", async (request) => {
    const { gitServerId, projectId, mergeRequestNumber } = request.params as Record<string, string>
    return getMergeRequest({ ...contextFromRequest(request), gitServerId, projectId, mergeRequestNumber, ...await providerSession(request, gitServerId) })
  })

  app.post("/api/merge-requests/:gitServerId/:projectId/:mergeRequestNumber/reviews", async (request, reply) => {
    const { gitServerId, projectId, mergeRequestNumber } = request.params as Record<string, string>
    const result = await submitMergeRequestReview({ ...contextFromRequest(request), gitServerId, projectId, mergeRequestNumber, ...await providerSession(request, gitServerId), input: request.body || {} })
    return reply.code(201).send(result)
  })

  app.post("/api/merge-requests/:gitServerId/:projectId/:mergeRequestNumber/merge", async (request) => {
    const { gitServerId, projectId, mergeRequestNumber } = request.params as Record<string, string>
    return mergeMergeRequest({ ...contextFromRequest(request), gitServerId, projectId, mergeRequestNumber, ...await providerSession(request, gitServerId) })
  })

  app.post("/api/merge-requests/:gitServerId/:projectId/:mergeRequestNumber/state", async (request) => {
    const { gitServerId, projectId, mergeRequestNumber } = request.params as Record<string, string>
    return updateMergeRequestState({ ...contextFromRequest(request), gitServerId, projectId, mergeRequestNumber, ...await providerSession(request, gitServerId), input: request.body || {} })
  })
}
