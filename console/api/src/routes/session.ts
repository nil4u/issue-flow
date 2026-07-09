import type { FastifyInstance, FastifyRequest } from "fastify"

import { getSession, resolveFreshSession } from "../core/session.js"
import { publicSession } from "../core/common.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { cookie, cookieSecure, sessionCookieName, userCookieName } from "../utils/http.js"

async function userSessionsFromRequest(request: FastifyRequest) {
  const store = request.server.issueFlowStore
  const gitServers = await store.listGitServers()
  const sessionAccounts = []
  let currentUserId = request.cookies[userCookieName()] || ""
  for (const server of gitServers) {
    const sessionId = request.cookies[sessionCookieName(server.id)] || ""
    let session = await resolveFreshSession({ store, sessionId, gitServerId: server.id, logger: request.log })
    if (session && (!session.userId || !session.account?.gitServerId)) {
      const identity = await store.resolveUserForGitAccount({
        currentUserId,
        account: {
          provider: session.provider || server.type,
          gitServerId: session.gitServerId || server.id,
          providerUserId: session.account?.providerUserId || session.user?.id || session.user?.username,
          username: session.user?.username || "",
          displayName: session.user?.name || session.user?.username || "",
          email: session.user?.email || "",
          avatarUrl: session.user?.avatarUrl || "",
          scopes: session.scopes || [],
        },
      })
      currentUserId = identity.user.id
      session = await store.updateSessionIdentity(sessionId, {
        userId: identity.user.id,
        user: {
          username: identity.account.username,
          name: identity.account.displayName,
          avatarUrl: identity.account.avatarUrl,
        },
        account: identity.account,
      })
    }
    if (session) {
      currentUserId = currentUserId || session.userId || ""
      sessionAccounts.push({
        session: publicSession(session),
        user: session.user || {},
        gitServer: session.gitServer || server,
      })
    }
  }
  const userId = currentUserId || sessionAccounts.find((account) => account.session.userId)?.session.userId || ""
  const user = userId ? await store.getUser(userId, { includeAccounts: true }) : undefined
  const sessionByServerId = new Map(sessionAccounts.map((account) => [
    account.session.gitServerId || account.gitServer.id,
    account,
  ]))
  const linkedAccounts = user?.accounts?.map((account: Record<string, any>) => {
    const sessionAccount = sessionByServerId.get(account.gitServerId)
    return {
      account,
      session: sessionAccount?.session,
      user: {
        username: account.username,
        name: account.displayName,
        avatarUrl: account.avatarUrl,
      },
      gitServer: account.gitServer || gitServers.find((server) => server.id === account.gitServerId),
    }
  }) || []
  const linkedKeys = new Set(linkedAccounts.map((account: Record<string, any>) => account.gitServer?.id || account.account?.gitServerId))
  const legacyAccounts = sessionAccounts.filter((account) => !linkedKeys.has(account.gitServer?.id || account.session.gitServerId))
  return {
    authenticated: Boolean(user || linkedAccounts.length || legacyAccounts.length),
    user: user || sessionAccounts[0]?.user || undefined,
    accounts: [...linkedAccounts, ...legacyAccounts],
  }
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/session", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const result = await getSession({
      ...contextFromRequest(request),
      sessionId: request.cookies[sessionCookieName(gitServerId)] || "",
      gitServerId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/user/session", async (request, reply) => {
    const body = await userSessionsFromRequest(request)
    if (body.user?.id) {
      reply.header("Set-Cookie", cookie(userCookieName(), body.user.id, {
        maxAge: 60 * 60 * 24 * 30,
        secure: cookieSecure(request),
      }))
    }
    return reply.code(200).send(body)
  })

  app.post("/api/user/logout", async (request, reply) => {
    const store = request.server.issueFlowStore
    const gitServers = await store.listGitServers()
    const headers = []
    for (const server of gitServers) {
      const name = sessionCookieName(server.id)
      const sessionId = request.cookies[name] || ""
      if (sessionId) {
        await store.deleteSession(sessionId)
      }
      headers.push(cookie(name, "", {
        maxAge: 0,
        secure: cookieSecure(request),
      }))
    }
    headers.push(cookie(userCookieName(), "", {
      maxAge: 0,
      secure: cookieSecure(request),
    }))
    return reply.header("Set-Cookie", headers).code(200).send({ ok: true })
  })
}
