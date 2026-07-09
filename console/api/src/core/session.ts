// @ts-nocheck
import { publicSession, resolveGitServer } from './common.js'
import { refreshGitlabOAuthToken } from './gitlab.js'

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

async function resolveFreshSession({ store, sessionId, gitServerId = '', logger = undefined }) {
  const session = await store.getSession(sessionId, { allowExpired: true })
  if (!session) return undefined
  if (!shouldRefreshSession(session)) return session

  const expired = tokenExpiresAt(session) <= Date.now()
  if (!session.refreshToken) return expired ? undefined : session

  try {
    const { config } = await resolveGitServer(store, {
      gitServerId: gitServerId || session.gitServerId,
    }, session, 'gitlab')
    const result = await refreshGitlabOAuthToken({
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

async function getSession({ store, sessionId, gitServerId = '', logger = undefined }) {
  const session = await resolveFreshSession({ store, sessionId, gitServerId, logger });
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
