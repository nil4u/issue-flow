import type { FastifyInstance } from "fastify"

import {
  createGitlabOAuthAuthorize,
  finishGitlabOAuth,
  logoutGitlabSession,
  startGitlabOAuth,
} from "../../core/gitlab-auth.js"
import { consoleSessionFromRequest, contextFromRequest, currentUserIdFromRequest } from "../../services/issue-flow.js"
import { consoleSessionCookieName, cookie, cookieSecure, firstAppOrigin, userCookieName } from "../../utils/http.js"

function safeReturnTo(value: unknown) {
  const path = String(value || "")
  if (!path.startsWith("/") || path.startsWith("//")) return "/repos"
  return path
}

export async function gitlabAuthRoutes(app: FastifyInstance) {
  app.post("/api/auth/gitlab/authorize", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>
    const result = await createGitlabOAuthAuthorize({
      ...contextFromRequest(request),
      input: {
        gitServerId: String(body.gitServerId || ""),
        returnTo: safeReturnTo(body.returnTo),
      },
    })
    return reply.code(result.status).send({
      authorizeUrl: result.authorizeUrl,
      gitServerId: result.gitServerId,
    })
  })

  app.get("/api/auth/gitlab/start", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const gitServerId = String(query.gitServerId || "")
    const result = await startGitlabOAuth({
      ...contextFromRequest(request),
      input: {
        gitServerId,
        returnTo: safeReturnTo(query.returnTo),
      },
    })
    return reply
      .code(302)
      .header("Location", result.location)
      .send()
  })

  app.get("/api/auth/gitlab/callback", async (request, reply) => {
    // 身份只信 console session;已登录用户走 OAuth = 给自己 link 新 git 账号。
    const consoleSession = await consoleSessionFromRequest(request)
    const result = await finishGitlabOAuth({
      ...contextFromRequest(request),
      query: {
        ...((request.query || {}) as Record<string, unknown>),
        currentUserId: consoleSession?.userId || "",
      },
    })
    if (result.status !== 302) {
      return reply.code(result.status).send(result.body)
    }
    const returnTo = safeReturnTo(result.returnTo)
    const redirectUrl = new URL(returnTo, firstAppOrigin())
    redirectUrl.searchParams.set("gitlab", "connected")

    const cookies = [
      // 明文 user id 不该继续留在浏览器里,顺手清除旧 cookie。
      cookie(userCookieName(), "", { maxAge: 0, secure: cookieSecure(request) }),
    ]
    if (!consoleSession) {
      const { token } = await request.server.issueFlowStore.createConsoleSession({
        userId: result.user?.id || result.session.userId || "",
        userAgent: String(request.headers["user-agent"] || ""),
      })
      cookies.push(cookie(consoleSessionCookieName(), token, {
        maxAge: 60 * 60 * 24 * 30,
        secure: cookieSecure(request),
      }))
    }

    return reply
      .code(302)
      .header("Location", redirectUrl.toString())
      .header("Set-Cookie", cookies)
      .send()
  })

  // 语义:断开某个 git 账号(删 git 凭证行),不影响控制台登录态。
  app.post("/api/auth/gitlab/logout", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>
    const gitServerId = String(body.gitServerId || (request.query as Record<string, unknown>).gitServerId || "")
    const userId = await currentUserIdFromRequest(request)
    if (!userId) {
      return reply.code(401).send({ error: "unauthorized" })
    }
    const result = await logoutGitlabSession({
      ...contextFromRequest(request),
      userId,
      gitServerId,
    })
    return reply.code(result.status).send(result.body)
  })
}
