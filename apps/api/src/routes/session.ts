import type { FastifyInstance, FastifyRequest } from "fastify"

import { getSession } from "../core/session.js"
import { publicSession } from "../core/common.js"
import { contextFromRequest } from "../services/issue-flow.js"
import { cookie, cookieSecure, sessionCookieName } from "../utils/http.js"

async function userSessionsFromRequest(request: FastifyRequest) {
  const store = request.server.issueFlowStore
  const gitServers = await store.listGitServers()
  const accounts = []
  for (const server of gitServers) {
    const sessionId = request.cookies[sessionCookieName(server.id)] || ""
    const session = await store.getSession(sessionId)
    if (session) {
      accounts.push({
        session: publicSession(session),
        user: session.user || {},
        gitServer: session.gitServer || server,
      })
    }
  }
  return {
    authenticated: accounts.length > 0,
    user: accounts[0] && accounts[0].user || undefined,
    accounts,
  }
}

export async function sessionRoutes(app: FastifyInstance) {
  app.get("/api/session", async (request, reply) => {
    const gitServerId = String((request.query as Record<string, unknown>).gitServerId || "")
    const result = await getSession({
      ...contextFromRequest(request),
      sessionId: request.cookies[sessionCookieName(gitServerId)] || "",
    })
    return reply.code(result.status).send(result.body)
  })

  app.get("/api/user/session", async (request, reply) => {
    return reply.code(200).send(await userSessionsFromRequest(request))
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
    return reply.header("Set-Cookie", headers).code(200).send({ ok: true })
  })
}
