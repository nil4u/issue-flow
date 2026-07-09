// @ts-nocheck
import { llmProxyConfig, resolveGitServer } from './common.js'
import {
  getGitlabCurrentUser,
} from './gitlab.js'
import { forwardServerConfig } from './agentrix-forward.js'
import { getAgentrixPrivateCloudRunnerSecret } from './agentrix-api.js'
import { savedAgentrixDefaults, userAgentrixKey } from './user-agentrix-config.js'

const AGENTRIX_SERVER_URL = 'https://agentrix.xmz.ai'
const AGENTRIX_WEBAPP_URL = 'https://agentrix.xmz.ai'
const DEFAULT_AGENTRIX_CLI_IMAGE = 'ghcr.io/xmz-ai/agentrix/agentrix-cli:latest'

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
    `  -e AGENTRIX_EVENT_FORWARD_WS_URL=${shellQuote(input.eventForwardWsUrl)} \\`,
    `  -e AGENTRIX_EVENT_FORWARD_TOKEN=${shellQuote(input.eventForwardToken)} \\`,
    `  -e AGENTRIX_BASE_URL=${shellQuote(input.llmProxyBaseUrl)} \\`,
    `  -e AGENTRIX_API_KEY=${shellQuote(input.llmProxyApiKey)} \\`,
    `  -e GITLAB_BASE_URL=${shellQuote(input.gitServer && input.gitServer.baseUrl || '')} \\`,
    ...(input.gitServer && input.gitServer.apiUrl ? [`  -e GITLAB_API_URL=${shellQuote(input.gitServer.apiUrl)} \\`] : []),
    `  -e GITLAB_TOKEN=${shellQuote(input.gitlabToken)} \\`,
    '  -v agentrix-home:/home/agentrix/.agentrix \\',
    `  ${shellQuote(input.cliImage || DEFAULT_AGENTRIX_CLI_IMAGE)}`,
  ]
  return lines.join('\n')
}

function requireUserId(userId) {
  if (!userId) {
    const error = new Error('console login required')
    error.status = 401
    error.code = 'login_required'
    throw error
  }
  return userId
}

function runnerIdFrom(input = {}) {
  return String(input.runnerId || input.cloudId || '').trim()
}

function publicGitServer(server = {}) {
  return {
    id: server.id || '',
    type: server.type || '',
    name: server.name || '',
    baseUrl: server.baseUrl || '',
    apiUrl: server.apiUrl || '',
    botPatFingerprint: server.botPatFingerprint || '',
  }
}

function llmProxyInput(input = {}, env = process.env) {
  const defaults = llmProxyConfig(env)
  return {
    baseUrl: String(input.llmProxyBaseUrl || input.llmProxy && input.llmProxy.baseUrl || defaults.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(input.llmProxyApiKey || input.llmProxy && input.llmProxy.apiKey || defaults.apiKey || '').trim(),
  }
}

function agentrixCliImage(env = process.env) {
  return String(env.ISSUE_FLOW_AGENTRIX_CLI_IMAGE || '').trim() || DEFAULT_AGENTRIX_CLI_IMAGE
}

function websocketUrl(basePublicUrl = '', path = '') {
  const base = String(basePublicUrl || '').trim().replace(/\/+$/, '')
  const suffix = String(path || '').trim().replace(/^\/+/, '')
  return `${base}/${suffix}`.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
}

function eventForwardInput({ basePublicUrl = '', env = process.env } = {}) {
  const config = forwardServerConfig(env)
  if (!config.token) {
    return {
      status: 400,
      body: {
        error: 'agentrix_forward_token_required',
        detail: 'Agentrix event forward token is missing.',
      },
    }
  }
  return {
    wsUrl: websocketUrl(basePublicUrl, config.path),
    token: config.token,
  }
}

async function validateBotPat(config = {}, logger = undefined) {
  if (!config.botPat) {
    return {
      status: 400,
      body: {
        error: 'runner_gitlab_bot_pat_required',
        detail: 'Git server bot PAT is missing.',
      },
    }
  }
  const validation = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token: config.botPat,
    authType: 'private-token',
    logger,
  })
  if (validation.status !== 'valid') {
    return {
      status: 400,
      body: {
        error: 'runner_gitlab_bot_pat_invalid',
        detail: 'Git server bot PAT is invalid or cannot access the GitLab API.',
      },
    }
  }
  return { status: 200, validation }
}

async function getAgentrixPrivateCloudConfig({ store, input = {}, userId, env = process.env }) {
  requireUserId(userId)
  const gitServerId = String(input.gitServerId || '').trim()
  const gitServer = gitServerId ? await store.getGitServer(gitServerId) : undefined
  const defaults = await savedAgentrixDefaults(store, userId, env)
  const tokens = await store.listRunnerGitlabTokens({
    userId,
    gitServerId,
  })
  return {
    status: 200,
    body: {
      agentrix: {
        serverUrl: AGENTRIX_SERVER_URL,
        webappUrl: AGENTRIX_WEBAPP_URL,
        cliImage: agentrixCliImage(env),
      },
      llmProxy: llmProxyConfig(env),
      gitServer: publicGitServer(gitServer || {}),
      defaults,
      runnerGitlabTokens: tokens,
    },
  }
}

async function validatePrivateCloudGitServer({ store, input = {}, userId, logger = undefined }) {
  requireUserId(userId)
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab')
  try {
    const result = await validateBotPat(config, logger)
    if (result.status !== 200) return result
    return {
      status: 200,
      body: {
        gitServer: publicGitServer(server),
        botPat: {
          status: 'valid',
          gitlabUserId: result.validation.id || '',
          gitlabUsername: result.validation.username || '',
          scopes: result.validation.scopes || [],
        },
      },
    }
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'runner_gitlab_bot_pat_validation_failed',
        detail: error && error.message || '',
      },
    }
  }
}

async function createRunnerGitlabToken({ store, input = {}, userId, env = process.env, basePublicUrl = '', logger = undefined }) {
  requireUserId(userId)
  const runnerId = runnerIdFrom(input)
  if (!runnerId) {
    return { status: 400, body: { error: 'runner_id_required' } }
  }
  const manualToken = String(input.token || input.gitlabToken || '').trim()
  if (manualToken) {
    return { status: 400, body: { error: 'runner_gitlab_token_manual_unsupported' } }
  }

  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab')
  const llmProxy = llmProxyInput(input, env)
  if (!llmProxy.baseUrl) {
    return { status: 400, body: { error: 'llm_proxy_base_url_required' } }
  }
  if (!llmProxy.apiKey) {
    return { status: 400, body: { error: 'llm_proxy_api_key_required' } }
  }
  let validation
  try {
    const result = await validateBotPat(config, logger)
    if (result.status !== 200) return result
    validation = result.validation
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'runner_gitlab_bot_pat_validation_failed',
        detail: error && error.message || '',
      },
    }
  }
  const tokenValue = String(config.botPat || '')
  if (!tokenValue) {
    return { status: 502, body: { error: 'gitlab_token_missing' } }
  }
  const eventForward = eventForwardInput({ basePublicUrl, env })
  if (eventForward.status) return eventForward

  const defaults = await savedAgentrixDefaults(store, userId, env)
  const agentrixApiKey = input.agentrixApiKey || defaults.agentrix && defaults.agentrix.apiKey || ''
  let cloudAuthToken = String(input.cloudAuthToken || input.runnerSecret || '').trim()
  if (!cloudAuthToken) {
    try {
      cloudAuthToken = await getAgentrixPrivateCloudRunnerSecret({
        env,
        apiKey: agentrixApiKey,
        cloudId: runnerId,
        logger,
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

  const runnerGitlabToken = {
    id: `bot_pat:${server.id}:${runnerId}`,
    userId,
    gitServerId: server.id,
    runnerId,
    gitlabUserId: validation.id || '',
    gitlabUsername: validation.username || '',
    gitlabTokenId: '',
    tokenFingerprint: server.botPatFingerprint || '',
    scopes: validation.scopes || [],
    source: 'bot_pat',
    expiresAt: '',
    revokedAt: '',
    createdAt: '',
    updatedAt: '',
  }
  if (input.saveDefaults !== false) {
    await store.saveUserAgentrixConfig(userAgentrixKey(userId), {
      automation: {
        runnerId,
      },
      agentrix: {
        runnerId,
        apiKey: agentrixApiKey || '',
        baseUrl: llmProxy.baseUrl,
      },
    })
  }
  return {
    status: 200,
    body: {
      runnerGitlabToken,
      gitlabToken: tokenValue,
      gitServer: publicGitServer(server),
      agentrix: {
        serverUrl: AGENTRIX_SERVER_URL,
        webappUrl: AGENTRIX_WEBAPP_URL,
        cliImage: agentrixCliImage(env),
      },
      llmProxy,
      cloudAuthToken,
      dockerCommand: dockerCommand({
        cloudAuthToken,
        eventForwardToken: eventForward.token,
        eventForwardWsUrl: eventForward.wsUrl,
        llmProxyApiKey: llmProxy.apiKey,
        gitlabToken: tokenValue,
        gitServer: server,
        llmProxyBaseUrl: llmProxy.baseUrl,
        cliImage: agentrixCliImage(env),
      }),
    },
  }
}

export {
  AGENTRIX_SERVER_URL,
  AGENTRIX_WEBAPP_URL,
  DEFAULT_AGENTRIX_CLI_IMAGE,
  createRunnerGitlabToken,
  getAgentrixPrivateCloudConfig,
  validatePrivateCloudGitServer,
}
