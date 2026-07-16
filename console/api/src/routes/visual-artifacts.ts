import type { FastifyInstance, FastifyRequest } from "fastify"

import { approveVisualPlan, getVisualArtifact, getVisualArtifactFile, listReviewablePlanArtifacts, submitVisualReview } from "../core/visual-artifacts.js"
import { contextFromRequest, currentUserIdFromRequest, sessionFromRequest } from "../services/issue-flow.js"

async function visualSession(request: FastifyRequest, gitServerId: string) {
  const session = await sessionFromRequest(request, gitServerId)
  return { session, userId: session && session.userId || await currentUserIdFromRequest(request) }
}

export async function visualArtifactRoutes(app: FastifyInstance) {
  app.get("/api/visual-artifacts/:gitServerId/:projectId/reviewable", async (request) => {
    const { gitServerId, projectId } = request.params as Record<string, string>
    return { artifacts: await listReviewablePlanArtifacts({ ...contextFromRequest(request), gitServerId, projectId, ...await visualSession(request, gitServerId) }) }
  })

  app.get("/api/visual-artifacts/:gitServerId/:projectId/:issueNumber/:type", async (request) => {
    const { gitServerId, projectId, issueNumber, type } = request.params as Record<string, string>
    return getVisualArtifact({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, type, ...await visualSession(request, gitServerId) })
  })

  app.get("/api/visual-artifacts/:gitServerId/:projectId/:issueNumber/:type/file", async (request, reply) => {
    const { gitServerId, projectId, issueNumber, type } = request.params as Record<string, string>
    const { path = "" } = request.query as Record<string, string>
    const result = await getVisualArtifactFile({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, type, requestedPath: path, ...await visualSession(request, gitServerId) })
    reply.type(result.contentType)
    return reply.send(result.body)
  })

  app.post("/api/visual-artifacts/:gitServerId/:projectId/:issueNumber/:type/reviews", async (request, reply) => {
    const { gitServerId, projectId, issueNumber, type } = request.params as Record<string, string>
    const result = await submitVisualReview({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, type, ...await visualSession(request, gitServerId), input: request.body || {} })
    return reply.code(201).send(result)
  })

  app.post("/api/visual-artifacts/:gitServerId/:projectId/:issueNumber/plan/approve", async (request) => {
    const { gitServerId, projectId, issueNumber } = request.params as Record<string, string>
    return approveVisualPlan({ ...contextFromRequest(request), gitServerId, projectId, issueNumber, ...await visualSession(request, gitServerId) })
  })
}
