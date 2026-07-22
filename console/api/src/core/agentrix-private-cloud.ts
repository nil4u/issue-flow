// @ts-nocheck
import { llmProxyConfig, resolveGitServer } from './common.js'
import { forwardServerConfig } from './agentrix-forward.js'
import { getAgentrixPrivateCloudRunnerSecret } from './agentrix-api.js'
import { savedAgentrixDefaults, userAgentrixKey } from './user-agentrix-config.js'
import {
  getUserGitPat,
  validateUserGitPat,
} from './user-git-pats.js'

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
    `  -e GIT_AUTHOR_NAME=${shellQuote(input.commitAuthor && input.commitAuthor.name || '')} \\`,
    `  -e GIT_AUTHOR_EMAIL=${shellQuote(input.commitAuthor && input.commitAuthor.email || '')} \\`,
    `  -e GIT_COMMITTER_NAME=${shellQuote(input.commitAuthor && input.commitAuthor.name || '')} \\`,
    `  -e GIT_COMMITTER_EMAIL=${shellQuote(input.commitAuthor && input.commitAuthor.email || '')} \\`,
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
    commitAuthor: {
      name: server.commitAuthor && server.commitAuthor.name || 'issue-flow',
      email: server.commitAuthor && server.commitAuthor.email || '',
    },
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

function commitAuthorInput(input = {}, config = {}) {
  const author = input.commitAuthor || {}
  return {
    name: String(author.name || input.commitAuthorName || config.commitAuthor && config.commitAuthor.name || 'issue-flow').trim() || 'issue-flow',
    email: String(author.email || input.commitAuthorEmail || config.commitAuthor && config.commitAuthor.email || '').trim(),
  }
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

async function getAgentrixPrivateCloudConfig({ store, input = {}, userId, env = process.env }) {
  requireUserId(userId)
  const gitServerId = String(input.gitServerId || '').trim()
  const gitServer = gitServerId ? await store.getGitServer(gitServerId) : undefined
  const defaults = await savedAgentrixDefaults(store, userId, env)
  const tokens = await store.listRunnerGitlabTokens({
    userId,
    gitServerId,
  })
  const patResult = gitServerId
    ? await getUserGitPat({ store, userId, gitServerId })
    : undefined
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
      gitPat: patResult && patResult.status === 200 ? patResult.body.pat : undefined,
    },
  }
}

async function validatePrivateCloudGitServer({ store, input = {}, userId, logger = undefined }) {
  requireUserId(userId)
  const { server } = await resolveGitServer(store, input, undefined, 'gitlab')
  try {
    const result = await validateUserGitPat({
      store,
      userId,
      gitServerId: server.id,
      input,
      logger,
    })
    if (result.status !== 200) return result
    return {
      status: 200,
      body: {
        gitServer: publicGitServer(server),
        gitPat: result.body.pat,
      },
    }
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'user_git_pat_validation_failed',
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

  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab')
  const commitAuthor = commitAuthorInput(input, config)
  if (!commitAuthor.email) {
    return { status: 400, body: { error: 'commit_author_email_required' } }
  }
  const llmProxy = llmProxyInput(input, env)
  if (!llmProxy.baseUrl) {
    return { status: 400, body: { error: 'llm_proxy_base_url_required' } }
  }
  if (!llmProxy.apiKey) {
    return { status: 400, body: { error: 'llm_proxy_api_key_required' } }
  }
  let pat
  try {
    const result = await validateUserGitPat({
      store,
      userId,
      gitServerId: server.id,
      input: { token: manualToken },
      logger,
    })
    if (result.status !== 200) return result
    pat = await store.getUserGitPat(userId, server.id, { includeSecret: true })
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'user_git_pat_validation_failed',
        detail: error && error.message || '',
      },
    }
  }
  const tokenValue = String(pat && pat.token || '')
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
    id: `user_pat:${userId}:${server.id}:${runnerId}`,
    userId,
    gitServerId: server.id,
    runnerId,
    gitlabUserId: pat.gitlabUserId || '',
    gitlabUsername: pat.gitlabUsername || '',
    gitlabTokenId: '',
    tokenFingerprint: pat.tokenFingerprint || '',
    scopes: pat.scopes || [],
    source: 'user_pat',
    expiresAt: pat.expiresAt || '',
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
      gitServer: publicGitServer(server),
      agentrix: {
        serverUrl: AGENTRIX_SERVER_URL,
        webappUrl: AGENTRIX_WEBAPP_URL,
        cliImage: agentrixCliImage(env),
      },
      llmProxy,
      commitAuthor,
      cloudAuthToken,
      dockerCommand: dockerCommand({
        cloudAuthToken,
        eventForwardToken: eventForward.token,
        eventForwardWsUrl: eventForward.wsUrl,
        llmProxyApiKey: llmProxy.apiKey,
        gitlabToken: tokenValue,
        gitServer: server,
        commitAuthor,
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
