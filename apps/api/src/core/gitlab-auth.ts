// @ts-nocheck
import crypto from 'node:crypto'
import {
  exchangeGitlabOAuthCode,
  getGitlabCurrentUser,
  gitlabOAuthAuthorizeUrl,
  listGitlabProjects,
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
  const accountInput = {
    provider: 'gitlab',
    gitServerId: server.id,
    providerUserId: validation.id || validation.username,
    username: validation.username,
    displayName: validation.name,
    email: validation.email || '',
    avatarUrl: validation.avatarUrl || '',
    scopes: validation.scopes || [],
  };
  const identity = await store.resolveUserForGitAccount({
    currentUserId: query.currentUserId || '',
    account: accountInput,
  });
  const session = await store.createSession({
    userId: identity.user.id,
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
      avatarUrl: validation.avatarUrl || '',
    },
    account: identity.account,
    provider: 'gitlab',
    gitServerId: server.id,
    gitServer: {
      id: server.id,
      type: server.type,
      name: server.name,
      baseUrl: config.baseUrl,
    },
  });
  try {
    const projects = await listGitlabProjects({
      apiUrl: config.apiUrl,
      token,
      authType: 'bearer',
    });
    await store.syncRepositories({
      gitServerId: server.id,
      userId: identity.user.id,
      projects,
    });
  } catch {
    // 登录状态优先落库；仓库列表失败后仍可由前端强制刷新。
  }
  return {
    status: 302,
    session: publicSession(session),
    user: identity.user,
    account: identity.account,
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
