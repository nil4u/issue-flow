import type { FastifyInstance } from "fastify"

import { getSession, resolveFreshSession } from "../core/session.js"
import { publicSession } from "../core/common.js"
import { consoleSessionFromRequest, contextFromRequest, currentUserIdFromRequest } from "../services/issue-flow.js"
import { consoleSessionCookieName, cookie, cookieSecure, userCookieName } from "../utils/http.js"

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/session", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const userId = await currentUserIdFromRequest(request)
    const result = await getSession({
      ...contextFromRequest(request),
      userId,
      gitServerId,
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/user/session", async (request, reply) => {
    const store = request.server.issueFlowStore
    const consoleSession = await consoleSessionFromRequest(request)
    if (!consoleSession) {
      return reply.code(200).send({ authenticated: false })
    }
    const user = await store.getUser(consoleSession.userId, { includeAccounts: true })
    if (!user) {
      await store.deleteConsoleSession(consoleSession.id)
      return reply.code(200).send({ authenticated: false })
    }
    const accounts = []
    for (const account of user.accounts || []) {
      // git 凭证过期只让该 account 的 session 为空,不影响 authenticated。
      const credential = await resolveFreshSession({
        store,
        userId: user.id,
        gitServerId: account.gitServerId,
        logger: request.log,
      })
      accounts.push({
        account,
        session: credential ? publicSession(credential) : undefined,
        user: {
          username: account.username,
          name: account.displayName,
          avatarUrl: account.avatarUrl,
        },
        gitServer: account.gitServer,
      })
    }
    return reply.code(200).send({ authenticated: true, user, accounts })
  })

  app.post("/api/user/logout", async (request, reply) => {
    const store = request.server.issueFlowStore
    const consoleSession = await consoleSessionFromRequest(request)
    if (consoleSession) {
      await store.deleteConsoleSession(consoleSession.id)
    }
    // 登出只结束控制台会话;oauth_sessions 是 git 凭证,保留。
    return reply
      .header("Set-Cookie", [
        cookie(consoleSessionCookieName(), "", { maxAge: 0, secure: cookieSecure(request) }),
        cookie(userCookieName(), "", { maxAge: 0, secure: cookieSecure(request) }),
      ])
      .code(200)
      .send({ ok: true })
  })
}
