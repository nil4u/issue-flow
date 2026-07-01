// @ts-nocheck
import { normalizeApiUrl, normalizeBaseUrl } from './store.js'
import {
  agentrixConfigFromEnv,
  repoWithWebhook,
  requireRepo,
  resolveGitServer,
} from './common.js'
import { validateGitlabToken } from './gitlab.js'

async function requireAccessibleRepo(store, repoId, userId) {
  if (!userId) {
    const error = new Error('login required');
    error.status = 401;
    error.code = 'login_required';
    throw error;
  }
  const repo = await requireRepo(store, repoId);
  if (!await store.userCanAccessRepo(userId, repoId)) {
    const error = new Error('repository not found');
    error.status = 404;
    error.code = 'repository_not_found';
    throw error;
  }
  return repo;
}

async function listRepositories({ store, basePublicUrl, input = {}, userId = '' }) {
  const repositories = await store.listRepositories({
    gitServerId: input.gitServerId || '',
    userId,
  });
  return {
    status: 200,
    body: {
      repositories: repositories.map((repo) => repoWithWebhook(basePublicUrl, repo)),
    },
  };
}

async function createRepository({ store, basePublicUrl, input = {}, userId = '', env = process.env }) {
  const { server, config } = await resolveGitServer(store, input, undefined, 'gitlab');
  const baseUrl = normalizeBaseUrl(input.baseUrl || config.baseUrl);
  const apiUrl = normalizeApiUrl(baseUrl, input.apiUrl || config.apiUrl);
  const projectPath = String(input.projectPath || '').trim();
  if (!projectPath) {
    return { status: 400, body: { error: 'project_path_required' } };
  }

  const validation = input.validateToken === false
    ? { status: 'unchecked' }
    : await validateGitlabToken({
      apiUrl,
      projectPath,
      token: input.token || '',
    });
  if (input.validateToken !== false && validation.status !== 'valid') {
    return {
      status: 400,
      body: {
        error: 'gitlab_token_invalid',
        validation,
      },
    };
  }

  const created = await store.createRepository({
    ...input,
    userId,
    provider: server.type,
    gitServerId: input.gitServerId || server.id,
    baseUrl,
    apiUrl,
    projectPath,
    agentrix: agentrixConfigFromEnv(input.agentrix || {}, env),
  }, validation);
  return {
    status: 201,
    body: {
      repository: repoWithWebhook(basePublicUrl, created.repo),
    },
  };
}

async function configureRepositoryAgentrix({ store, basePublicUrl, repoId, input = {}, userId = '', env = process.env }) {
  await requireAccessibleRepo(store, repoId, userId);
  const updated = await store.updateRepositoryAutomation(repoId, {
    automation: input.automation || {},
    agentrix: agentrixConfigFromEnv(input.agentrix || {}, env),
  });
  return {
    status: 200,
    body: {
      repository: repoWithWebhook(basePublicUrl, updated),
    },
  };
}

async function getRepository({ store, basePublicUrl, repoId, userId = '' }) {
  const repo = await requireAccessibleRepo(store, repoId, userId);
  return {
    status: 200,
    body: { repository: repoWithWebhook(basePublicUrl, store.publicRepository(repo)) },
  };
}

async function listGitEvents({ store, repoId, userId = '' }) {
  await requireAccessibleRepo(store, repoId, userId);
  return { status: 200, body: { gitEvents: await store.listGitEvents(repoId) } };
}

async function validateRepositoryToken({ store, basePublicUrl, repoId, userId = '' }) {
  const repo = await requireAccessibleRepo(store, repoId, userId);
  const session = repo.oauthSessionId
    ? await store.getSession(repo.oauthSessionId, { allowExpired: true })
    : undefined;
  const validation = await validateGitlabToken({
    apiUrl: repo.apiUrl,
    projectPath: repo.projectId || repo.projectPath,
    token: session && session.token || '',
    authType: repo.tokenAuth || 'bearer',
  });
  const updated = await store.updateTokenValidation(repoId, validation);
  return {
    status: 200,
    body: {
      repository: repoWithWebhook(basePublicUrl, updated),
      validation,
    },
  };
}

export {
  configureRepositoryAgentrix,
  createRepository,
  getRepository,
  listGitEvents,
  listRepositories,
  validateRepositoryToken,
}
