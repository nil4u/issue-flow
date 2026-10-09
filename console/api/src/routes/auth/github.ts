import type { FastifyInstance } from 'fastify'
import { createGithubOAuthAuthorize, finishGithubOAuth } from '../../core/github/auth.js'
import { githubInstallUrl } from '../../core/github/api.js'
import { timingSafeEqualString } from '../../core/auth/oauth-state.js'
import { consoleSessionFromRequest, contextFromRequest } from '../../services/issue-flow.js'
import { consoleSessionCookieName, cookie, cookieSecure, firstAppOrigin } from '../../utils/http.js'

const stateCookie = 'issue_flow_github_oauth'
function safeReturnTo(value: unknown) {
  const path = String(value || '')
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/repos'
}

export async function githubAuthRoutes(app: FastifyInstance) {
  for (const action of ['start', 'install']) {
    app.get(`/api/auth/github/${action}`, async (request, reply) => {
      const query = (request.query || {}) as Record<string, unknown>
      const result = await createGithubOAuthAuthorize({ ...contextFromRequest(request), input: { gitServerId: query.gitServerId, returnTo: safeReturnTo(query.returnTo), flow: action } })
      const server = await request.server.issueFlowStore.getGitServer(result.gitServerId)
      const url = new URL(action === 'install' ? githubInstallUrl(server) : result.authorizeUrl)
      url.searchParams.set('state', result.state)
      return reply.header('Set-Cookie', cookie(stateCookie, result.state, { maxAge: 600, secure: cookieSecure(request) })).redirect(url.toString())
    })
  }

  app.post('/api/auth/github/authorize', async (request, reply) => {
    const input = (request.body || {}) as Record<string, unknown>
    const result = await createGithubOAuthAuthorize({ ...contextFromRequest(request), input: { gitServerId: input.gitServerId, returnTo: safeReturnTo(input.returnTo) } })
    reply.header('Set-Cookie', cookie(stateCookie, result.state, { maxAge: 600, secure: cookieSecure(request) }))
    return { authorizeUrl: result.authorizeUrl, gitServerId: result.gitServerId }
  })
  app.get('/api/auth/github/callback', async (request, reply) => {
    const query = (request.query || {}) as Record<string, unknown>
    if (!query.state && query.installation_id) return reply.redirect(new URL('/repos', firstAppOrigin()).toString())
    if (!query.state || !request.cookies[stateCookie] || !timingSafeEqualString(String(query.state), request.cookies[stateCookie])) {
      return reply.code(401).send({ error: 'github_oauth_state_invalid' })
    }
    const current = await consoleSessionFromRequest(request)
    const result = await finishGithubOAuth({ ...contextFromRequest(request), query: { ...query, currentUserId: current?.userId || '' } })
    const cookies = [cookie(stateCookie, '', { maxAge: 0, secure: cookieSecure(request) })]
    if (!current) {
      const { token } = await request.server.issueFlowStore.createConsoleSession({ userId: result.user.id, userAgent: String(request.headers['user-agent'] || '') })
      cookies.push(cookie(consoleSessionCookieName(), token, { maxAge: 60 * 60 * 24 * 30, secure: cookieSecure(request) }))
    }
    if (result.flow !== 'install' && result.connection.status === 'needs_authorization') {
      const next = await createGithubOAuthAuthorize({ ...contextFromRequest(request), input: { gitServerId: result.gitServerId, returnTo: result.returnTo, flow: 'install' } })
      const server = await request.server.issueFlowStore.getGitServer(result.gitServerId)
      const installation = new URL(githubInstallUrl(server))
      installation.searchParams.set('state', next.state)
      cookies[0] = cookie(stateCookie, next.state, { maxAge: 600, secure: cookieSecure(request) })
      return reply.header('Set-Cookie', cookies).redirect(installation.toString())
    }
    const target = new URL(safeReturnTo(result.returnTo), firstAppOrigin())
    target.searchParams.set('githubConnection', result.connection.status)
    return reply.header('Set-Cookie', cookies).redirect(target.toString())
  })
}
