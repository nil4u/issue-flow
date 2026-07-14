// @ts-nocheck
import { getGitlabPersonalAccessTokenSelf } from './gitlab.js'

const REQUIRED_GIT_PAT_SCOPES = ['api', 'read_repository', 'write_repository']

function gitPatCreateUrl(server = {}) {
  const baseUrl = String(server.baseUrl || '').replace(/\/+$/, '')
  if (!baseUrl) return ''
  const params = new URLSearchParams({
    name: 'issue-flow-agentrix',
    scopes: REQUIRED_GIT_PAT_SCOPES.join(','),
  })
  return `${baseUrl}/-/user_settings/personal_access_tokens?${params}`
}

function publicPat(pat = {}, server = {}) {
  return {
    gitServerId: server.id || pat.gitServerId || '',
    gitServerName: server.name || server.baseUrl || server.id || '',
    gitlabUserId: pat.gitlabUserId || '',
    gitlabUsername: pat.gitlabUsername || '',
    tokenFingerprint: pat.tokenFingerprint || '',
    scopes: pat.scopes || [],
    requiredScopes: REQUIRED_GIT_PAT_SCOPES,
    status: pat.status || 'missing',
    checkedAt: pat.checkedAt || '',
    expiresAt: pat.expiresAt || '',
    createUrl: gitPatCreateUrl(server),
  }
}

function requireUserId(userId) {
  if (userId) return userId
  const error = new Error('console login required')
  error.status = 401
  error.code = 'login_required'
  throw error
}

async function userGitPatContext(store, userId, gitServerId) {
  requireUserId(userId)
  if (!gitServerId) {
    return { status: 400, body: { error: 'git_server_id_required' } }
  }
  const [server, account] = await Promise.all([
    store.getGitServer(gitServerId),
    store.getUserGitAccount(userId, gitServerId),
  ])
  if (!server || server.type !== 'gitlab') {
    return { status: 404, body: { error: 'git_server_not_found' } }
  }
  if (!account) {
    return { status: 400, body: { error: 'git_account_required' } }
  }
  return { server, account }
}

async function getUserGitPats({ store, userId }) {
  requireUserId(userId)
  const accounts = await store.listUserGitAccounts(userId)
  const pats = await Promise.all(accounts
    .filter((account) => account.provider === 'gitlab' && account.gitServer)
    .map(async (account) => publicPat(
      await store.getUserGitPat(userId, account.gitServerId),
      account.gitServer,
    )))
  return { status: 200, body: { pats } }
}

async function getUserGitPat({ store, userId, gitServerId }) {
  const context = await userGitPatContext(store, userId, gitServerId)
  if (context.status) return context
  const pat = await store.getUserGitPat(userId, gitServerId)
  return {
    status: 200,
    body: { pat: publicPat(pat, context.server) },
  }
}

async function validateUserGitPat({ store, userId, gitServerId, input = {}, logger = undefined }) {
  const context = await userGitPatContext(store, userId, gitServerId)
  if (context.status) return context

  const saved = await store.getUserGitPat(userId, gitServerId, { includeSecret: true })
  const suppliedToken = String(input.token || input.pat || '').trim()
  const token = suppliedToken || saved && saved.token || ''
  if (!token) {
    return {
      status: 400,
      body: {
        error: 'user_git_pat_required',
        pat: publicPat({}, context.server),
      },
    }
  }

  const validation = await getGitlabPersonalAccessTokenSelf({
    apiUrl: context.server.apiUrl,
    token,
    authType: 'private-token',
    logger,
  })
  if (validation.status !== 'valid') {
    return {
      status: 400,
      body: {
        error: 'user_git_pat_invalid',
        detail: 'PAT 无效、已过期或已撤销。',
      },
    }
  }

  if (String(validation.userId || '') !== String(context.account.providerUserId || '')) {
    return {
      status: 400,
      body: {
        error: 'user_git_pat_user_mismatch',
        detail: `PAT 不属于当前关联账号 ${context.account.username || context.account.providerUserId}。`,
      },
    }
  }

  const scopes = new Set(validation.scopes || [])
  const missingScopes = REQUIRED_GIT_PAT_SCOPES.filter((scope) => !scopes.has(scope))
  if (missingScopes.length) {
    return {
      status: 400,
      body: {
        error: 'user_git_pat_scopes_required',
        detail: `PAT 缺少权限：${missingScopes.join(', ')}。`,
        missingScopes,
        requiredScopes: REQUIRED_GIT_PAT_SCOPES,
      },
    }
  }

  const pat = await store.saveUserGitPat(userId, gitServerId, {
    token,
    gitlabUserId: validation.userId,
    gitlabUsername: context.account.username,
    scopes: validation.scopes,
    status: 'valid',
    checkedAt: validation.lastValidatedAt,
    expiresAt: validation.expiresAt,
  })
  return {
    status: 200,
    body: { pat: publicPat(pat, context.server) },
  }
}

async function deleteUserGitPat({ store, userId, gitServerId }) {
  const context = await userGitPatContext(store, userId, gitServerId)
  if (context.status) return context
  await store.deleteUserGitPat(userId, gitServerId)
  return {
    status: 200,
    body: { ok: true, pat: publicPat({}, context.server) },
  }
}

export {
  REQUIRED_GIT_PAT_SCOPES,
  deleteUserGitPat,
  getUserGitPat,
  getUserGitPats,
  gitPatCreateUrl,
  validateUserGitPat,
}
