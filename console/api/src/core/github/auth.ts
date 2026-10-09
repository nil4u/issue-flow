// @ts-nocheck
import { resolveFreshSession } from '../session.js'
import { syncGithubConnection } from './projects.js'
import { signOAuthState, verifyOAuthState } from '../auth/oauth-state.js'
import { publicSession, resolveGitServer } from '../common.js'
import { providerFetch } from '../provider-api.js'
import { githubClient, githubError, githubOAuthToken } from './api.js'

export async function createGithubOAuthAuthorize({ store, basePublicUrl, input = {} }) {
  const { server } = await resolveGitServer(store, input, undefined, 'github')
  if (!server.oauth.clientId || !server.oauth.clientSecret) throw githubError('github_oauth_configuration_required')
  const state = signOAuthState(store, { ...input, gitServerId: server.id })
  const url = new URL(`${server.baseUrl}/login/oauth/authorize`)
  url.searchParams.set('client_id', server.oauth.clientId)
  url.searchParams.set('redirect_uri', `${basePublicUrl}/api/auth/github/callback`)
  url.searchParams.set('state', state)
  return { status: 200, state, gitServerId: server.id, authorizeUrl: url.toString() }
}

export async function finishGithubOAuth({ store, basePublicUrl, query = {} }) {
  const state = verifyOAuthState(store, query.state)
  if (!state) throw githubError('github_oauth_state_invalid', 401)
  const { server } = await resolveGitServer(store, { gitServerId: state.gitServerId }, undefined, 'github')
  if (!query.code) {
    if (state.flow !== 'install' || !query.currentUserId) throw githubError('github_oauth_code_required')
    const session = await resolveFreshSession({ store, userId: query.currentUserId, gitServerId: server.id })
    if (!session?.token) throw githubError('github_login_required', 401)
    return finishGithubConnection({ store, server, session, user: { id: query.currentUserId }, state })
  }
  const token = await githubOAuthToken(server, { code: String(query.code), redirect_uri: `${basePublicUrl}/api/auth/github/callback` })
  const user = await providerFetch(githubClient(server, token.access_token), 'GET', '/user')
  const identity = await store.resolveUserForGitAccount({
    currentUserId: query.currentUserId || '', setupAdminEligible: state.setupAdminEligible,
    account: { provider: 'github', gitServerId: server.id, providerUserId: String(user.id), username: user.login, displayName: user.name || user.login, email: user.email || '', avatarUrl: user.avatar_url || '', scopes: [] },
  })
  const session = await store.createSession({
    userId: identity.user.id, token: token.access_token, refreshToken: token.refresh_token || '',
    expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : '', scopes: [],
    user: { username: user.login, name: user.name || user.login, avatarUrl: user.avatar_url || '' },
    account: identity.account, provider: 'github', gitServerId: server.id, gitServer: store.publicGitServer(server),
  })
  return finishGithubConnection({ store, server, session, user: identity.user, state })
}

async function finishGithubConnection({ store, server, session, user, state }) {
  let connection
  try {
    connection = (await syncGithubConnection(store, server, session.token, user.id)).connection
  } catch {
    // --- 登录成功与仓库同步分别呈现，API 失败不能伪装成未授权 ---
    connection = { status: 'sync_failed' }
  }
  const returnTo = ['/', '/repos'].includes(state.returnTo) ? `/repos/${encodeURIComponent(server.id)}` : state.returnTo
  return { status: 302, session: publicSession(session), user, returnTo, connection, flow: state.flow, gitServerId: server.id }
}
