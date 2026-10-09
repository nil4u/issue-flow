// @ts-nocheck
import { publicSession, resolveGitServer } from './common.js'
import { githubOAuthToken } from './github/api.js'
import { refreshGitlabOAuthToken } from './gitlab.js'

const refreshes = new WeakMap()

const SESSION_REFRESH_SKEW_MS = 5 * 60 * 1000

function tokenExpiresAt(session) {
  const value = session && session.expiresAt ? Date.parse(session.expiresAt) : 0
  return Number.isFinite(value) ? value : 0
}

function shouldRefreshSession(session, now = Date.now()) {
  const expiresAt = tokenExpiresAt(session)
  return Boolean(expiresAt && expiresAt <= now + SESSION_REFRESH_SKEW_MS)
}

function scopesFromTokenResult(result = {}, fallback = []) {
  const scopes = String(result.scope || '')
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean)
  return scopes.length ? scopes : fallback
}

async function resolveFreshSession({ store, userId, gitServerId = '', logger = undefined }) {
  const session = await store.getGitCredential(userId, gitServerId, { allowExpired: true })
  if (!session) return undefined
  if (!shouldRefreshSession(session)) return session

  const expired = tokenExpiresAt(session) <= Date.now()
  if (!session.refreshToken) return expired ? undefined : session

  let pending = refreshes.get(store)
  if (!pending) { pending = new Map(); refreshes.set(store, pending) }
  if (!pending.has(session.id)) {
    pending.set(session.id, refreshSession({ store, session, gitServerId, logger, expired }).finally(() => pending.delete(session.id)))
  }
  return pending.get(session.id)
}

async function refreshSession({ store, session, gitServerId, logger, expired }) {
  try {
    const { server, config } = await resolveGitServer(store, {
      gitServerId: gitServerId || session.gitServerId,
    }, session, '')
    const result = server.type === 'github'
      ? await githubOAuthToken(server, { grant_type: 'refresh_token', refresh_token: session.refreshToken })
      : await refreshGitlabOAuthToken({
      config,
      refreshToken: session.refreshToken,
      logger,
    })
    const expiresAt = result.expires_in
      ? new Date(Date.now() + Number(result.expires_in) * 1000).toISOString()
      : session.expiresAt || ''
    return await store.updateSessionTokens(session.id, {
      token: result.access_token || session.token || '',
      refreshToken: result.refresh_token || session.refreshToken || '',
      scopes: scopesFromTokenResult(result, session.scopes || []),
      expiresAt,
    })
  } catch {
    return expired ? undefined : session
  }
}

async function getSession({ store, userId, gitServerId = '', logger = undefined }) {
  const session = await resolveFreshSession({ store, userId, gitServerId, logger });
  return {
    status: 200,
    body: session
      ? { authenticated: true, session: publicSession(session), user: session.user, gitServer: session.gitServer }
      : { authenticated: false },
  };
}

export {
  getSession,
  resolveFreshSession,
}
