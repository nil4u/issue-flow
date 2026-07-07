// @ts-nocheck
import { llmProxyConfig, resolveGitServer, sessionUserKey } from './common.js'
import {
  createGitlabUserImpersonationToken,
  getGitlabCurrentUser,
} from './gitlab.js'
import { getAgentrixPrivateCloudRunnerSecret } from './agentrix-api.js'
import { savedAgentrixDefaults } from './user-agentrix-config.js'

const AGENTRIX_SERVER_URL = 'https://agentrix.xmz.ai'
const AGENTRIX_WEBAPP_URL = 'https://agentrix.xmz.ai'
const DEFAULT_TOKEN_SCOPES = ['api', 'read_repository', 'write_repository']

function shellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`
}

function dockerCommand(input = {}) {
  const lines = [
    'docker run -d \\',
    '  --name agentrix-runner \\',
    '  --restart unless-stopped \\',
    `  -e AGENTRIX_SERVER_URL=${shellQuote(AGENTRIX_SERVER_URL)} \\`,
    `  -e AGENTRIX_WEBAPP_URL=${shellQuote(AGENTRIX_WEBAPP_URL)} \\`,
    `  -e CLOUD_AUTH_TOKEN=${shellQuote(input.cloudAuthToken)} \\`,
    `  -e AGENTRIX_BASE_URL=${shellQuote(input.llmProxyBaseUrl)} \\`,
    `  -e AGENTRIX_API_KEY=${shellQuote(input.agentrixApiKey)} \\`,
    `  -e GITLAB_BASE_URL=${shellQuote(input.gitServer && input.gitServer.baseUrl || '')} \\`,
    ...(input.gitServer && input.gitServer.apiUrl ? [`  -e GITLAB_API_URL=${shellQuote(input.gitServer.apiUrl)} \\`] : []),
    `  -e GITLAB_TOKEN=${shellQuote(input.gitlabToken)} \\`,
    '  -v agentrix-home:/home/agentrix/.agentrix \\',
    '  -v agentrix-workspaces:/home/agentrix/.agentrix/workspaces \\',
    '  ghcr.io/xmz-ai/agentrix/agentrix-cli:latest',
  ]
  return lines.join('\n')
}

function requireSession(session) {
  if (!session || !session.userId) {
    const error = new Error('gitlab login required')
    error.status = 401
    error.code = 'gitlab_login_required'
    throw error
  }
  return session
}

function runnerIdFrom(input = {}) {
  return String(input.runnerId || input.cloudId || '').trim()
}

function tokenName(runnerId = '') {
  const suffix = String(runnerId || Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48)
  return `issue-flow-runner-${suffix}-${Date.now()}`
}

function tokenExpiresAt(input = {}) {
  const days = Number(input.expiresInDays || 365)
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + (Number.isFinite(days) && days > 0 ? days : 365))
  return date.toISOString().slice(0, 10)
}

function publicGitServer(server = {}) {
  return {
    id: server.id || '',
    type: server.type || '',
    name: server.name || '',
    baseUrl: server.baseUrl || '',
    apiUrl: server.apiUrl || '',
  }
}

async function getAgentrixPrivateCloudConfig({ store, input = {}, session, env = process.env }) {
  const current = requireSession(session)
  const gitServerId = String(input.gitServerId || current.gitServerId || '').trim()
  const gitServer = gitServerId ? await store.getGitServer(gitServerId) : undefined
  const defaults = await savedAgentrixDefaults(store, current, env)
  const tokens = await store.listRunnerGitlabTokens({
    userId: current.userId,
    gitServerId,
  })
  return {
    status: 200,
    body: {
      agentrix: {
        serverUrl: AGENTRIX_SERVER_URL,
        webappUrl: AGENTRIX_WEBAPP_URL,
      },
      llmProxy: llmProxyConfig(env),
      gitServer: publicGitServer(gitServer || current.gitServer || {}),
      defaults,
      runnerGitlabTokens: tokens,
    },
  }
}

async function createRunnerGitlabToken({ store, input = {}, session, env = process.env }) {
  const current = requireSession(session)
  const runnerId = runnerIdFrom(input)
  if (!runnerId) {
    return { status: 400, body: { error: 'runner_id_required' } }
  }
  const manualToken = String(input.token || input.gitlabToken || '').trim()
  if (manualToken) {
    return { status: 400, body: { error: 'runner_gitlab_token_manual_unsupported' } }
  }

  const { server, config } = await resolveGitServer(store, input, current, 'gitlab')
  const defaults = await savedAgentrixDefaults(store, current, env)
  const agentrixApiKey = input.agentrixApiKey || defaults.agentrix && defaults.agentrix.apiKey || ''
  let cloudAuthToken = String(input.cloudAuthToken || input.runnerSecret || '').trim()
  if (!cloudAuthToken) {
    try {
      cloudAuthToken = await getAgentrixPrivateCloudRunnerSecret({
        env,
        apiKey: agentrixApiKey,
        cloudId: runnerId,
      })
    } catch (error) {
      return {
        status: error && error.status || 502,
        body: {
          error: error && error.code || 'agentrix_cloud_secret_failed',
          detail: error && error.message || '',
        },
      }
    }
  }
  let tokenValue = ''
  let tokenId = ''
  let validation
  if (!config.adminPat) {
    return {
      status: 400,
      body: {
        error: 'runner_gitlab_token_required',
        detail: 'Git server admin PAT is missing.',
      },
    }
  }
  try {
    const adminUser = await getGitlabCurrentUser({
      apiUrl: config.apiUrl,
      token: config.adminPat,
      authType: 'private-token',
    })
    if (adminUser.status !== 'valid' || !adminUser.id) {
      return {
        status: 400,
        body: {
          error: 'runner_gitlab_token_required',
          detail: 'Git server admin PAT is invalid or its user id is unavailable.',
        },
      }
    }
    const created = await createGitlabUserImpersonationToken({
      apiUrl: config.apiUrl,
      token: config.adminPat,
      authType: 'private-token',
      userId: adminUser.id,
      name: tokenName(runnerId),
      scopes: DEFAULT_TOKEN_SCOPES,
      expiresAt: tokenExpiresAt(input),
    })
    tokenValue = String(created.token || '')
    tokenId = created.id !== undefined ? String(created.id) : ''
    validation = {
      status: 'valid',
      id: adminUser.id,
      username: adminUser.username || '',
      name: adminUser.name || '',
      scopes: created.scopes || DEFAULT_TOKEN_SCOPES,
    }
    if (!tokenValue) {
      return { status: 502, body: { error: 'gitlab_token_missing' } }
    }
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'gitlab_token_auto_create_failed',
        detail: error && error.message || '',
      },
    }
  }

  const saved = await store.saveRunnerGitlabToken({
    userId: current.userId,
    gitServerId: server.id,
    runnerId,
    gitlabUserId: validation.id || '',
    gitlabUsername: validation.username || '',
    gitlabTokenId: tokenId,
    token: tokenValue,
    scopes: validation.scopes || DEFAULT_TOKEN_SCOPES,
    source: 'auto',
    expiresAt: input.expiresAt || tokenExpiresAt(input),
  })
  if (input.saveDefaults !== false) {
    await store.saveUserAgentrixConfig(sessionUserKey(current), {
      automation: {
        runnerId,
      },
      agentrix: {
        runnerId,
        apiKey: agentrixApiKey || '',
        baseUrl: llmProxyConfig(env).baseUrl,
      },
    })
  }
  return {
    status: 200,
    body: {
      runnerGitlabToken: {
        ...saved,
        token: undefined,
      },
      gitlabToken: saved.token,
      gitServer: publicGitServer(server),
      agentrix: {
        serverUrl: AGENTRIX_SERVER_URL,
        webappUrl: AGENTRIX_WEBAPP_URL,
      },
      llmProxy: llmProxyConfig(env),
      cloudAuthToken,
      dockerCommand: dockerCommand({
        cloudAuthToken,
        agentrixApiKey,
        gitlabToken: saved.token,
        gitServer: server,
        llmProxyBaseUrl: llmProxyConfig(env).baseUrl,
      }),
    },
  }
}

export {
  AGENTRIX_SERVER_URL,
  AGENTRIX_WEBAPP_URL,
  createRunnerGitlabToken,
  getAgentrixPrivateCloudConfig,
}
