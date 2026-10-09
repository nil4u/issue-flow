// @ts-nocheck
import { signOAuthState, verifyOAuthState } from './auth/oauth-state.js'
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

async function connectGitlabSession({ store, input = {}, logger = undefined }) {
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab');
  const validation = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token: input.token || '',
    authType: config.tokenAuth,
    logger,
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

async function createGitlabOAuthAuthorize({ store, basePublicUrl, appUrl, input = {} }) {
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab');
  const state = signOAuthState(store, {
    gitServerId: server.id,
    returnTo: input.returnTo,
    setupAdminEligible: input.setupAdminEligible,
  });
  return {
    status: 200,
    state,
    gitServerId: server.id,
    authorizeUrl: gitlabOAuthAuthorizeUrl({ config, state, basePublicUrl, appUrl }),
  };
}

async function startGitlabOAuth({ store, basePublicUrl, appUrl, input = {} }) {
  const result = await createGitlabOAuthAuthorize({ store, basePublicUrl, appUrl, input });
  return {
    status: 302,
    state: result.state,
    gitServerId: result.gitServerId,
    location: result.authorizeUrl,
  };
}

async function finishGitlabOAuth({ store, basePublicUrl, appUrl, query = {}, logger = undefined }) {
  const state = verifyOAuthState(store, query.state);
  if (!state) {
    return { status: 401, body: { error: 'gitlab_oauth_state_invalid' } };
  }
  const { server, config } = await resolveGitServer(store, { ...query, gitServerId: state.gitServerId }, undefined, 'gitlab');
  const code = String(query.code || '');
  if (!code) {
    return { status: 400, body: { error: 'gitlab_oauth_code_required' } };
  }
  const tokenResult = await exchangeGitlabOAuthCode({ config, code, basePublicUrl, appUrl, logger });
  const token = tokenResult.access_token || '';
  const validation = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType: 'bearer',
    logger,
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
    setupAdminEligible: Boolean(state.setupAdminEligible),
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
  if (identity.accountCreated) {
    syncRepositoriesAfterGitlabOAuth({
      store,
      config,
      server,
      token,
      userId: identity.user.id,
      logger,
    });
  }
  return {
    status: 302,
    session: publicSession(session),
    user: identity.user,
    account: identity.account,
    returnTo: state.returnTo,
  };
}

function syncRepositoriesAfterGitlabOAuth(input = {}) {
  void (async () => {
    try {
      const { store, config, server, token, userId } = input;
      const projects = await listGitlabProjects({
        apiUrl: config.apiUrl,
        token,
        authType: 'bearer',
        logger: input.logger,
      });
      await store.syncRepositories({
        gitServerId: server.id,
        userId,
        projects,
      });
    } catch {
      // 登录状态优先落库；仓库列表失败后仍可由前端强制刷新。
    }
  })();
}

async function logoutGitlabSession({ store, userId, gitServerId }) {
  const credential = await store.getGitCredential(userId, gitServerId, { allowExpired: true });
  if (credential) {
    await store.deleteSession(credential.id);
  }
  return { status: 200, body: { ok: true } };
}

export {
  connectGitlabSession,
  createGitlabOAuthAuthorize,
  finishGitlabOAuth,
  logoutGitlabSession,
  startGitlabOAuth,
}
