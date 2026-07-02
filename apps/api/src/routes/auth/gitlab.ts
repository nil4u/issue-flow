import type { FastifyInstance } from "fastify"

import {
  createGitlabOAuthAuthorize,
  finishGitlabOAuth,
  logoutGitlabSession,
  startGitlabOAuth,
} from "../../core/gitlab-auth.js"
import { contextFromRequest } from "../../services/issue-flow.js"
import { cookie, cookieSecure, firstAppOrigin, sessionCookieName, userCookieName } from "../../utils/http.js"

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
    const result = await finishGitlabOAuth({
      ...contextFromRequest(request),
      query: {
        ...((request.query || {}) as Record<string, unknown>),
        currentUserId: request.cookies[userCookieName()] || "",
      },
    })
    if (result.status !== 302) {
      return reply.code(result.status).send(result.body)
    }
    const gitServerId = result.session.gitServerId || result.session.gitServer?.id || ""
    const returnTo = safeReturnTo(result.returnTo)
    const redirectUrl = new URL(returnTo, firstAppOrigin())
    redirectUrl.searchParams.set("gitlab", "connected")

    return reply
      .code(302)
      .header("Location", redirectUrl.toString())
      .header("Set-Cookie", [
        cookie(userCookieName(), result.user?.id || result.session.userId || "", {
          maxAge: 60 * 60 * 24 * 30,
          secure: cookieSecure(request),
        }),
        cookie(sessionCookieName(gitServerId), result.session.id, {
          maxAge: 60 * 60 * 24 * 30,
          secure: cookieSecure(request),
        }),
      ])
      .send()
  })

  app.post("/api/auth/gitlab/logout", async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>
    const gitServerId = String(body.gitServerId || (request.query as Record<string, unknown>).gitServerId || "")
    const result = await logoutGitlabSession({
      ...contextFromRequest(request),
      sessionId: request.cookies[sessionCookieName(gitServerId)] || "",
    })
    return reply
      .header("Set-Cookie", cookie(sessionCookieName(gitServerId), "", {
        maxAge: 0,
        secure: cookieSecure(request),
      }))
      .code(result.status)
      .send(result.body)
  })
}
