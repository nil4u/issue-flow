// @ts-nocheck
import {
  configureGitlabProjectVariables,
  getGitlabCurrentUser,
  getGitlabProjectForInstall,
  listGitlabProjects,
  syncGitlabProjectLabels,
  upsertGitlabWebhook,
} from './gitlab.js'
import { installGitlabBootstrap } from './gitlab-bootstrap.js'
import {
  repoWithWebhook,
  resolveGitServer,
  sessionToken,
} from './common.js'
import {
  mergeAgentrixInstallInput,
  savedAgentrixDefaults,
} from './user-agentrix-config.js'
import { sanitizeError } from './sanitize.js'

function gitlabCiVariablesForInstall({ config, installConfig }) {
  const automation = installConfig.automation || {};
  const agentrix = installConfig.agentrix || {};
  return [
    { key: 'AGENTRIX_BASE_URL', value: agentrix.baseUrl },
    { key: 'AGENTRIX_API_KEY', value: agentrix.apiKey, masked: true },
    { key: 'AGENTRIX_RUNNER_ID', value: agentrix.runnerId || automation.runnerId || '' },
    { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: automation.agent || 'codex' },
    { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: automation.autoDefault || 'triage' },
    { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: automation.reviewEnabled ? 'true' : 'false' },
  ];
}

async function listGitlabProjectsWithInstallStatus({ store, input = {}, session }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const user = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType,
  });
  if (user.status !== 'valid') {
    return { status: 401, body: { error: 'gitlab_login_required', validation: user } };
  }
  const projects = await listGitlabProjects({
    apiUrl: config.apiUrl,
    token,
    authType,
  });
  return {
    status: 200,
    body: {
      projects: await Promise.all(projects.map(async (project) => {
        const installed = await store.findRepositoryByProject({
          gitServerId: server.id,
          projectId: project.id,
          projectPath: project.pathWithNamespace,
        });
        return {
          ...project,
          installed: Boolean(installed),
          installedRepoId: installed && installed.id || '',
          canInstall: Boolean(project.canInstall),
        };
      })),
    },
  };
}

async function installGitlabProject({ store, basePublicUrl, input = {}, session, env = process.env }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const projectIdOrPath = input.projectId || input.projectPath || '';
  if (!projectIdOrPath) {
    return { status: 400, body: { error: 'project_required' } };
  }
  if (!token) {
    return { status: 401, body: { error: 'gitlab_login_required' } };
  }

  const project = await getGitlabProjectForInstall({
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath,
  });
  if (!project.canInstall) {
    return {
      status: 403,
      body: { error: 'gitlab_project_permission_required' },
    };
  }

  const existing = await store.findRepositoryByProject({
    gitServerId: server.id,
    projectId: project.id,
    projectPath: project.pathWithNamespace,
  });
  const userAgentrixDefaults = await savedAgentrixDefaults(store, session, env);
  let agentrixDefaults = userAgentrixDefaults;
  if (existing) {
    const existingCredentials = await store.getCredentials(existing.id);
    agentrixDefaults = {
      automation: {
        ...(userAgentrixDefaults.automation || {}),
        ...(existing.automation || {}),
      },
      agentrix: {
        ...(userAgentrixDefaults.agentrix || {}),
        ...(existing.agentrix || {}),
        apiKey: existingCredentials.agentrixApiKey || (userAgentrixDefaults.agentrix && userAgentrixDefaults.agentrix.apiKey) || '',
      },
    };
  }
  const installConfig = mergeAgentrixInstallInput(input, agentrixDefaults, env);
  const webhookSecret = config.webhookSecret || '';
  if (!webhookSecret) {
    return {
      status: 400,
      body: { error: 'git_server_webhook_secret_required' },
    };
  }

  let bootstrap;
  try {
    bootstrap = await installGitlabBootstrap({
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: project.id || project.pathWithNamespace,
      branch: project.defaultBranch || 'main',
      commitMessage: input.bootstrapCommitMessage || 'Install issue-flow',
    });
  } catch (error) {
    return {
      status: error && error.status === 409 ? 409 : 502,
      body: {
        error: 'gitlab_bootstrap_install_failed',
        detail: sanitizeError(error),
      },
    };
  }

  try {
    await syncGitlabProjectLabels({
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: project.id || project.pathWithNamespace,
    });
  } catch (error) {
    return {
      status: 502,
      body: {
        error: 'gitlab_label_sync_failed',
        detail: sanitizeError(error),
      },
    };
  }

  try {
    await configureGitlabProjectVariables({
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: project.id || project.pathWithNamespace,
      variables: gitlabCiVariablesForInstall({ config, installConfig }),
    });
  } catch (error) {
    return {
      status: 502,
      body: {
        error: 'gitlab_variable_config_failed',
        detail: sanitizeError(error),
      },
    };
  }

  if (existing) {
    existing.tokenAuth = config.tokenAuth || 'bearer';
    await store.updateRepositoryAutomation(existing.id, {
      automation: installConfig.automation,
      agentrix: installConfig.agentrix,
      tokenAuth: config.tokenAuth || 'bearer',
      oauthSessionId: session && session.id || existing.oauthSessionId || '',
    });
    const existingWithWebhook = repoWithWebhook(basePublicUrl, existing);
    let hook;
    try {
      hook = await upsertGitlabWebhook({
        apiUrl: config.apiUrl,
        token,
        authType,
        projectIdOrPath: project.id || project.pathWithNamespace,
        hookId: existing.install && existing.install.hookId || '',
        webhookUrl: existingWithWebhook.webhookUrl,
        webhookSecret,
      });
    } catch (error) {
      const failed = await store.updateInstallStatus(existing.id, {
        status: 'install_failed',
        mode: 'server-side',
        error: sanitizeError(error),
      });
      return {
        status: 502,
        body: {
          error: 'gitlab_webhook_install_failed',
          repository: repoWithWebhook(basePublicUrl, failed),
          detail: sanitizeError(error),
        },
      };
    }
    await store.rotateWebhookSecret(existing.id, webhookSecret);
    const updated = await store.updateInstallStatus(existing.id, {
      status: 'installed',
      mode: 'server-side',
      hookId: hook && hook.id ? String(hook.id) : existing.install && existing.install.hookId || '',
      bootstrapStatus: bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
    });
    return {
      status: 200,
      body: {
        repository: repoWithWebhook(basePublicUrl, updated),
        installed: true,
        upgraded: true,
      },
    };
  }
  const validation = {
    status: 'valid',
    username: '',
    scopes: [],
    projectId: project.id,
    defaultBranch: project.defaultBranch,
  };
  const created = await store.createRepository({
    provider: server.type,
    baseUrl: config.baseUrl,
    apiUrl: config.apiUrl,
    tokenAuth: config.tokenAuth || 'bearer',
    gitServerId: server.id,
    oauthSessionId: session && session.id || '',
    projectPath: project.pathWithNamespace,
    webhookSecret,
    installMode: 'server-side',
    installStatus: 'installing',
    automation: installConfig.automation,
    agentrix: installConfig.agentrix,
    bootstrap: {
      status: bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      branch: bootstrap && bootstrap.branch || project.defaultBranch || '',
      commitId: bootstrap && bootstrap.commitId || '',
      actionCount: bootstrap && bootstrap.actionCount || 0,
    },
  }, validation);
  const publicRepo = repoWithWebhook(basePublicUrl, created.repo);

  try {
    const hook = await upsertGitlabWebhook({
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: project.id || project.pathWithNamespace,
      webhookUrl: publicRepo.webhookUrl,
      webhookSecret: created.webhookSecret,
    });
    const installed = await store.updateInstallStatus(created.repo.id, {
      status: 'installed',
      mode: 'server-side',
      hookId: hook && hook.id ? String(hook.id) : '',
      bootstrapStatus: bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
    });
    return {
      status: 201,
      body: {
        repository: repoWithWebhook(basePublicUrl, installed),
        installed: true,
      },
    };
  } catch (error) {
    const failed = await store.updateInstallStatus(created.repo.id, {
      status: 'install_failed',
      mode: 'server-side',
      error: sanitizeError(error),
    });
    return {
      status: 502,
      body: {
        error: 'gitlab_webhook_install_failed',
        repository: repoWithWebhook(basePublicUrl, failed),
        detail: sanitizeError(error),
      },
    };
  }
}

export {
  installGitlabProject,
  listGitlabProjectsWithInstallStatus,
}
