import type { FastifyRequest } from "fastify"

import type { IssueFlowStore } from "../storage/store.js"
import { resolveFreshSession } from "../core/session.js"
import { appBaseUrl, consoleSessionCookieName, publicBaseUrl } from "../utils/http.js"

export type ServiceContext = {
  store: IssueFlowStore
  basePublicUrl: string
  appUrl: string
  logger?: FastifyRequest["log"]
}

export function contextFromRequest(request: FastifyRequest): ServiceContext {
  return {
    store: request.server.issueFlowStore,
    basePublicUrl: publicBaseUrl(),
    appUrl: appBaseUrl(),
    logger: request.log,
  }
}

export async function consoleSessionFromRequest(request: FastifyRequest) {
  const token = request.cookies[consoleSessionCookieName()] || ""
  if (!token) return undefined
  return request.server.issueFlowStore.getConsoleSessionByToken(token)
}

export async function currentUserIdFromRequest(request: FastifyRequest) {
  const session = await consoleSessionFromRequest(request)
  return session?.userId || ""
}

export async function sessionFromRequest(request: FastifyRequest, gitServerId = "") {
  const userId = await currentUserIdFromRequest(request)
  if (!userId || !gitServerId) return undefined
  return resolveFreshSession({
    store: request.server.issueFlowStore,
    userId,
    gitServerId,
    logger: request.log,
  })
}
