// @ts-nocheck
import { normalizeApiUrl, normalizeBaseUrl } from './store.js'
import { webhookUrl } from './gitlab-webhook.js'

const DEFAULT_AGENTRIX_BASE_URL = 'https://agentrix.xmz.ai';

function agentrixServiceConfig(env = process.env) {
  return {
    baseUrl: normalizeBaseUrl(env.ISSUE_FLOW_AGENTRIX_BASE_URL || DEFAULT_AGENTRIX_BASE_URL),
  };
}

function agentrixConfigFromEnv(input = {}, env = process.env) {
  return {
    apiKey: input.apiKey || '',
    runnerId: input.runnerId || '',
    baseUrl: agentrixServiceConfig(env).baseUrl,
  };
}

function gitlabConfigFromServer(server = {}) {
  return {
    baseUrl: server.baseUrl || '',
    apiUrl: server.apiUrl || normalizeApiUrl(server.baseUrl || '', ''),
    webhookSecret: server.webhook && server.webhook.secret || '',
    agentrixGitServerId: server.agentrixGitServerId || '',
    adminPat: server.adminPat || '',
    tokenAuth: server.tokenAuth || 'bearer',
    oauthClientId: server.oauth && server.oauth.clientId || '',
    oauthClientSecret: server.oauth && server.oauth.clientSecret || '',
    oauthRedirectUri: server.oauth && server.oauth.redirectUri || '',
    oauthScopes: server.oauth && server.oauth.scopes || '',
  };
}

function gitServerIdFrom(input = {}, session) {
  return String(
    input.gitServerId
    || session && session.gitServerId
    || session && session.gitServer && session.gitServer.id
    || ''
  ).trim();
}

async function resolveGitServer(store, input = {}, session, requiredType = 'gitlab') {
  const gitServerId = gitServerIdFrom(input, session);
  if (!gitServerId) {
    const error = new Error('git server id is required');
    error.status = 400;
    error.code = 'git_server_required';
    throw error;
  }
  const server = await store.getGitServer(gitServerId, { includeSecret: true });
  if (!server) {
    const error = new Error('git server not found');
    error.status = 404;
    error.code = 'git_server_not_found';
    throw error;
  }
  if (requiredType && server.type !== requiredType) {
    const error = new Error(`${server.type} git server is not supported here`);
    error.status = 400;
    error.code = 'git_server_type_unsupported';
    throw error;
  }
  if (!server.baseUrl || !server.apiUrl) {
    const error = new Error('git server is missing base/api url');
    error.status = 400;
    error.code = 'git_server_incomplete';
    throw error;
  }
  return {
    server,
    config: gitlabConfigFromServer(server),
  };
}

function repoWithWebhook(basePublicUrl, repo) {
  return {
    ...repo,
    webhookUrl: webhookUrl(basePublicUrl, repo.id),
  };
}

async function requireRepo(store, id) {
  const repo = await store.getRepository(id);
  if (!repo) {
    const error = new Error('repository not found');
    error.status = 404;
    throw error;
  }
  return repo;
}

function sessionUserKey(session) {
  if (session && session.userId) {
    return `user:${session.userId}`;
  }
  const username = session && session.user && session.user.username || '';
  const gitServerId = session && session.gitServerId || session && session.gitServer && session.gitServer.id || '';
  return username ? `${gitServerId || session.provider || 'git'}:${username}` : '';
}

function publicSession(session) {
  if (!session) {
    return undefined;
  }
  return {
    id: session.id,
    userId: session.userId || '',
    provider: session.provider || session.gitServer && session.gitServer.type || 'gitlab',
    gitServerId: session.gitServerId || '',
    gitServer: session.gitServer || {},
    user: session.user || {},
    account: session.account || {},
    scopes: session.scopes || [],
    expiresAt: session.expiresAt || '',
  };
}

function sessionToken(input = {}, session) {
  return input.token || (session && session.token) || '';
}

export {
  agentrixConfigFromEnv,
  agentrixServiceConfig,
  gitlabConfigFromServer,
  publicSession,
  repoWithWebhook,
  requireRepo,
  resolveGitServer,
  sessionToken,
  sessionUserKey,
}
