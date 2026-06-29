// @ts-nocheck
import crypto from 'node:crypto'
import {
  exchangeGitlabOAuthCode,
  getGitlabCurrentUser,
  gitlabOAuthAuthorizeUrl,
} from './gitlab.js'
import {
  publicSession,
  resolveGitServer,
} from './common.js'

async function connectGitlabSession({ store, input = {} }) {
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab');
  const validation = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token: input.token || '',
    authType: config.tokenAuth,
  });
  if (validation.status !== 'valid') {
    return {
      status: 401,
      body: {
        error: 'gitlab_login_failed',
        validation,
      },
    };
  }
  return {
    status: 200,
    body: {
      user: {
        username: validation.username,
        name: validation.name,
        scopes: validation.scopes,
      },
      gitServer: {
        id: server.id,
        type: server.type,
        name: server.name,
        baseUrl: config.baseUrl,
      },
    },
  };
}

async function startGitlabOAuth({ store, basePublicUrl, input = {} }) {
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab');
  const state = crypto.randomBytes(24).toString('hex');
  return {
    status: 302,
    state,
    gitServerId: server.id,
    location: gitlabOAuthAuthorizeUrl({ config, state, basePublicUrl }),
  };
}

async function finishGitlabOAuth({ store, basePublicUrl, query = {} }) {
  const { server, config } = await resolveGitServer(store, query, undefined, 'gitlab');
  const code = String(query.code || '');
  if (!code) {
    return { status: 400, body: { error: 'gitlab_oauth_code_required' } };
  }
  const tokenResult = await exchangeGitlabOAuthCode({ config, code, basePublicUrl });
  const token = tokenResult.access_token || '';
  const validation = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType: 'bearer',
  });
  if (validation.status !== 'valid') {
    return { status: 401, body: { error: 'gitlab_login_failed', validation } };
  }
  const expiresAt = tokenResult.expires_in
    ? new Date(Date.now() + (Number(tokenResult.expires_in) * 1000)).toISOString()
    : '';
  const session = await store.createSession({
    token,
    refreshToken: tokenResult.refresh_token || '',
    scopes: String(tokenResult.scope || config.oauthScopes || '')
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
    expiresAt,
    user: {
      username: validation.username,
      name: validation.name,
    },
    provider: 'gitlab',
    gitServerId: server.id,
    gitServer: {
      id: server.id,
      type: server.type,
      name: server.name,
      baseUrl: config.baseUrl,
    },
  });
  return {
    status: 302,
    session: publicSession(session),
  };
}

async function logoutGitlabSession({ store, sessionId }) {
  await store.deleteSession(sessionId);
  return { status: 200, body: { ok: true } };
}

export {
  connectGitlabSession,
  finishGitlabOAuth,
  logoutGitlabSession,
  startGitlabOAuth,
}
