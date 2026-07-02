import type { FastifyRequest } from "fastify"

import type { IssueFlowStore } from "../storage/store.js"
import { resolveFreshSession } from "../core/session.js"
import { appBaseUrl, publicBaseUrl, sessionCookieName } from "../utils/http.js"

export type ServiceContext = {
  store: IssueFlowStore
  basePublicUrl: string
  appUrl: string
}

export function contextFromRequest(request: FastifyRequest): ServiceContext {
  return {
    store: request.server.issueFlowStore,
    basePublicUrl: publicBaseUrl(),
    appUrl: appBaseUrl(),
  }
}

export function sessionFromRequest(request: FastifyRequest, gitServerId = "") {
  const sessionId = request.cookies[sessionCookieName(gitServerId)] || ""
  return resolveFreshSession({
    store: request.server.issueFlowStore,
    sessionId,
    gitServerId,
  })
}
