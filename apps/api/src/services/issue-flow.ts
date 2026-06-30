import type { FastifyRequest } from "fastify"

import type { IssueFlowStore } from "../storage/store.js"
import { publicBaseUrl, sessionCookieName } from "../utils/http.js"

export type ServiceContext = {
  store: IssueFlowStore
  basePublicUrl: string
}

export function contextFromRequest(request: FastifyRequest): ServiceContext {
  return {
    store: request.server.issueFlowStore,
    basePublicUrl: publicBaseUrl(request),
  }
}

export function sessionFromRequest(request: FastifyRequest, gitServerId = "") {
  const sessionId = request.cookies[sessionCookieName(gitServerId)] || ""
  return request.server.issueFlowStore.getSession(sessionId)
}
