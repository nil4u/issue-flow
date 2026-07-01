import type { FastifyInstance } from "fastify"

import {
  finishGitlabOAuth,
  logoutGitlabSession,
  startGitlabOAuth,
} from "../../core/gitlab-auth.js"
import { contextFromRequest } from "../../services/issue-flow.js"
import { cookie, cookieSecure, firstWebOrigin, sessionCookieName, userCookieName } from "../../utils/http.js"

function safeReturnTo(value: unknown) {
  const path = String(value || "")
  if (!path.startsWith("/") || path.startsWith("//")) return "/repos"
  return path
}

export async function gitlabAuthRoutes(app: FastifyInstance) {
  app.get("/api/auth/gitlab/start", async (request, reply) => {
    const query = request.query as Record<string, unknown>
    const gitServerId = String(query.gitServerId || "")
    const result = await startGitlabOAuth({
      ...contextFromRequest(request),
      input: { gitServerId },
    })
    return reply
      .code(302)
      .header("Location", result.location)
      .header("Set-Cookie", [
        cookie("issue_flow_oauth_state", result.state, {
          maxAge: 600,
          secure: cookieSecure(request),
        }),
        cookie("issue_flow_oauth_git_server_id", result.gitServerId, {
          maxAge: 600,
          secure: cookieSecure(request),
        }),
        cookie("issue_flow_oauth_return_to", safeReturnTo(query.returnTo), {
          maxAge: 600,
          secure: cookieSecure(request),
        }),
      ])
      .send()
  })

  app.get("/api/auth/gitlab/callback", async (request, reply) => {
    const expectedState = request.cookies.issue_flow_oauth_state || ""
    const actualState = String((request.query as Record<string, unknown>).state || "")
    if (!expectedState || expectedState !== actualState) {
      return reply.code(401).send({ error: "gitlab_oauth_state_invalid" })
    }

    const result = await finishGitlabOAuth({
      ...contextFromRequest(request),
      query: {
        ...((request.query || {}) as Record<string, unknown>),
        gitServerId: request.cookies.issue_flow_oauth_git_server_id || "",
        currentUserId: request.cookies[userCookieName()] || "",
      },
    })
    if (result.status !== 302) {
      return reply.code(result.status).send(result.body)
    }
    const gitServerId = result.session.gitServerId || result.session.gitServer?.id || request.cookies.issue_flow_oauth_git_server_id || ""
    const returnTo = safeReturnTo(request.cookies.issue_flow_oauth_return_to)
    const redirectUrl = new URL(returnTo, firstWebOrigin())
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
        cookie("issue_flow_oauth_state", "", {
          maxAge: 0,
          secure: cookieSecure(request),
        }),
        cookie("issue_flow_oauth_git_server_id", "", {
          maxAge: 0,
          secure: cookieSecure(request),
        }),
        cookie("issue_flow_oauth_return_to", "", {
          maxAge: 0,
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
