// @ts-nocheck
import { normalizeApiUrl, normalizeBaseUrl } from './store.js'
import {
  agentrixConfigFromEnv,
  repoWithWebhook,
  requireRepo,
  resolveGitServer,
} from './common.js'
import { validateGitlabToken } from './gitlab.js'

async function listRepositories({ store, basePublicUrl }) {
  const repositories = await store.listRepositories();
  return {
    status: 200,
    body: {
      repositories: repositories.map((repo) => repoWithWebhook(basePublicUrl, repo)),
    },
  };
}

async function createRepository({ store, basePublicUrl, input = {}, env = process.env }) {
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
      webhookSecret: created.webhookSecret,
      secretShownOnce: true,
    },
  };
}

async function configureRepositoryAgentrix({ store, basePublicUrl, repoId, input = {}, env = process.env }) {
  await requireRepo(store, repoId);
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

async function getRepository({ store, basePublicUrl, repoId }) {
  const repo = await requireRepo(store, repoId);
  return {
    status: 200,
    body: { repository: repoWithWebhook(basePublicUrl, store.publicRepository(repo)) },
  };
}

async function listDeliveries({ store, repoId }) {
  await requireRepo(store, repoId);
  return { status: 200, body: { deliveries: await store.listDeliveries(repoId) } };
}

async function listDispatchRuns({ store, repoId }) {
  await requireRepo(store, repoId);
  return { status: 200, body: { runs: await store.listDispatchRuns(repoId) } };
}

async function validateRepositoryToken({ store, basePublicUrl, repoId }) {
  const repo = await requireRepo(store, repoId);
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

async function rotateRepositoryWebhookSecret({ store, basePublicUrl, repoId, input = {} }) {
  await requireRepo(store, repoId);
  const rotated = await store.rotateWebhookSecret(repoId, input.webhookSecret || '');
  return {
    status: 200,
    body: {
      repository: repoWithWebhook(basePublicUrl, rotated.repo),
      webhookSecret: rotated.webhookSecret,
      secretShownOnce: true,
    },
  };
}

export {
  configureRepositoryAgentrix,
  createRepository,
  getRepository,
  listDeliveries,
  listDispatchRuns,
  listRepositories,
  rotateRepositoryWebhookSecret,
  validateRepositoryToken,
}
