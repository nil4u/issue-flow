// @ts-nocheck
import {
  configureGitlabProjectVariables,
  getGitlabCurrentUser,
  getGitlabProjectForInstall,
  getGitlabProjectVariable,
  listGitlabProjects,
  listGitlabWebhooks,
  syncGitlabProjectLabels,
  upsertGitlabWebhook,
} from './gitlab.js'
import {
  installGitlabBootstrap,
  installGitlabBootstrapMergeRequest,
  planGitlabBootstrap,
} from './gitlab-bootstrap.js'
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
  const runnerId = agentrix.runnerId || automation.runnerId || '';
  return [
    { key: 'AGENTRIX_BASE_URL', value: agentrix.baseUrl, required: true },
    { key: 'AGENTRIX_API_KEY', value: agentrix.apiKey, masked: true, required: true },
    { key: 'AGENTRIX_RUNNER_ID', value: runnerId, required: Boolean(runnerId), emptyDetail: '未指定，使用默认 runner' },
    { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: automation.agent || 'codex', required: true },
    { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: automation.autoDefault || 'triage', required: true },
    { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: automation.reviewEnabled ? 'true' : 'false', required: true },
  ];
}

function installStep(id, kind, label, status, detail = '', extra = {}) {
  return {
    id,
    kind,
    label,
    status,
    detail,
    ...extra,
  };
}

function statusFromBoolean(ok, missingDetail, readyDetail = '') {
  return ok
    ? { status: 'passed', detail: readyDetail }
    : { status: 'needs_action', detail: missingDetail };
}

function variableCheckState(variable, existingVariable) {
  const exists = Boolean(existingVariable);
  const required = variable.required !== false;
  const writable = variable.value !== undefined && variable.value !== '';
  const needsInput = required && !exists && !writable;
  if (exists) {
    return { status: 'passed', detail: 'GitLab 已配置' };
  }
  if (!required && !writable) {
    return { status: 'passed', detail: variable.emptyDetail || '未设置，使用默认值' };
  }
  if (needsInput) {
    return { status: 'needs_input', detail: '需要填写后写入 GitLab' };
  }
  return { status: 'needs_action', detail: '可通过 GitLab API 写入' };
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

async function checkGitlabProjectInstall({ store, basePublicUrl, input = {}, session, env = process.env }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const projectIdOrPath = input.projectId || input.projectPath || '';
  const steps = [];

  if (!token) {
    return {
      status: 401,
      body: {
        error: 'gitlab_login_required',
        steps: [
          installStep('auth', 'auth', 'GitLab 登录', 'blocked', '需要先登录当前 Git server'),
        ],
        installable: false,
      },
    };
  }

  const user = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType,
  });
  if (user.status !== 'valid') {
    return {
      status: 401,
      body: {
        error: 'gitlab_login_required',
        validation: user,
        steps: [
          installStep('auth', 'auth', 'GitLab 登录', 'blocked', '当前登录已失效'),
        ],
        installable: false,
      },
    };
  }
  steps.push(installStep('auth', 'auth', 'GitLab 登录', 'passed', user.username || '已登录'));

  if (!projectIdOrPath) {
    steps.push(installStep('project', 'input', '选择仓库', 'blocked', '需要先选择一个仓库'));
    return { status: 400, body: { error: 'project_required', steps, installable: false } };
  }

  const project = await getGitlabProjectForInstall({
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath,
  });
  steps.push(installStep(
    'permission',
    'auth',
    '仓库权限',
    project.canInstall ? 'passed' : 'blocked',
    project.canInstall ? '具备维护者权限' : '需要 Maintainer 或 Owner 权限'
  ));

  const existing = await store.findRepositoryByProject({
    gitServerId: server.id,
    projectId: project.id,
    projectPath: project.pathWithNamespace,
  });
  const defaults = await savedAgentrixDefaults(store, session, env);
  let agentrixDefaults = defaults;
  if (existing) {
    const existingCredentials = await store.getCredentials(existing.id);
    agentrixDefaults = {
      automation: {
        ...(defaults.automation || {}),
        ...(existing.automation || {}),
      },
      agentrix: {
        ...(defaults.agentrix || {}),
        ...(existing.agentrix || {}),
        apiKey: existingCredentials.agentrixApiKey || (defaults.agentrix && defaults.agentrix.apiKey) || '',
      },
    };
  }
  const installConfig = mergeAgentrixInstallInput(input, agentrixDefaults, env);

  const apiInput = {
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath: project.id || project.pathWithNamespace,
  };

  try {
    const bootstrapPlan = await planGitlabBootstrap({
      ...apiInput,
      branch: project.defaultBranch || 'main',
    });
    steps.push(installStep(
      'bootstrap',
      'repo',
      '仓库 bootstrap 文件',
      bootstrapPlan.required ? 'needs_action' : 'passed',
      bootstrapPlan.required
        ? '需要通过分支、commit、push、MR 写入 issue-flow 文件'
        : '仓库文件已包含 issue-flow bootstrap',
      {
        actionCount: bootstrapPlan.actionCount,
        files: bootstrapPlan.files,
      }
    ));
  } catch (error) {
    steps.push(installStep(
      'bootstrap',
      'repo',
      '仓库 bootstrap 文件',
      'blocked',
      sanitizeError(error)
    ));
  }

  const variables = gitlabCiVariablesForInstall({ config, installConfig });
  const variableResults = [];
  for (const variable of variables) {
    const existingVariable = await getGitlabProjectVariable(apiInput, variable.key);
    const state = variableCheckState(variable, existingVariable);
    const required = variable.required !== false;
    const writable = variable.value !== undefined && variable.value !== '';
    variableResults.push({
      key: variable.key,
      label: variable.label || variable.key,
      description: variable.description || '',
      exists: Boolean(existingVariable),
      required,
      writable,
      masked: Boolean(variable.masked),
      status: state.status,
      detail: state.detail,
      needsInput: state.status === 'needs_input',
      control: variable.control || undefined,
    });
  }
  const missingVariables = variableResults
    .filter((item) => item.required && !item.exists)
    .map((item) => item.key);
  const inputRequiredVariables = variableResults
    .filter((item) => item.needsInput)
    .map((item) => item.key);
  const variableStatus = inputRequiredVariables.length
    ? 'needs_input'
    : missingVariables.length
      ? 'needs_action'
      : 'passed';
  const variableDetail = inputRequiredVariables.length
    ? `缺少 ${inputRequiredVariables.join(', ')}，需要补充后才能写入`
    : missingVariables.length
      ? `缺少 ${missingVariables.length} 个变量，可通过 API 写入`
      : 'GitLab variables 已完整';
  steps.push(installStep(
    'variables',
    'api',
    'CI/CD variables',
    variableStatus,
    variableDetail,
    {
      missing: missingVariables,
      inputRequired: inputRequiredVariables,
      variables: variableResults,
    }
  ));

  if (existing) {
    const publicRepo = repoWithWebhook(basePublicUrl, existing);
    const hooks = await listGitlabWebhooks(apiInput);
    const hook = hooks.find((item) => item && item.url === publicRepo.webhookUrl);
    const hookState = statusFromBoolean(Boolean(hook), '需要通过 API 配置 GitLab webhook', 'Webhook 已配置');
    steps.push(installStep('webhook', 'api', 'GitLab webhook', hookState.status, hookState.detail));
  } else {
    steps.push(installStep(
      'webhook',
      'api',
      'GitLab webhook',
      'needs_action',
      '安装时创建仓库记录后通过 API 配置 webhook'
    ));
  }

  steps.push(installStep(
    'labels',
    'api',
    'Issue Flow labels',
    'needs_action',
    '安装时通过 API 同步 labels'
  ));

  const installable = steps.every((step) => step.status !== 'blocked')
    && steps.every((step) => step.status !== 'needs_input');
  return {
    status: 200,
    body: {
      gitServer: { id: server.id, name: server.name, baseUrl: config.baseUrl },
      project,
      repository: existing || null,
      installed: Boolean(existing && existing.install && existing.install.status === 'installed'),
      installable,
      steps,
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
  const useMergeRequest = input.repoChangeMode === 'merge_request' || input.bootstrapMode === 'merge_request';
  try {
    const bootstrapInput = {
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: project.id || project.pathWithNamespace,
      baseUrl: config.baseUrl,
      projectPath: project.pathWithNamespace,
      branch: project.defaultBranch || 'main',
      commitMessage: input.bootstrapCommitMessage || 'Install issue-flow',
    };
    bootstrap = useMergeRequest
      ? await installGitlabBootstrapMergeRequest(bootstrapInput)
      : await installGitlabBootstrap(bootstrapInput);
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
      status: bootstrap && bootstrap.mergeRequest ? 'pending_repo_change' : 'installed',
      mode: 'server-side',
      hookId: hook && hook.id ? String(hook.id) : existing.install && existing.install.hookId || '',
      bootstrapStatus: bootstrap && bootstrap.mergeRequest ? 'merge_request_open' : bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
      bootstrapMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
    });
    return {
      status: 200,
      body: {
        repository: repoWithWebhook(basePublicUrl, updated),
        installed: !(bootstrap && bootstrap.mergeRequest),
        pendingMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
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
    installStatus: bootstrap && bootstrap.mergeRequest ? 'pending_repo_change' : 'installing',
    automation: installConfig.automation,
    agentrix: installConfig.agentrix,
    bootstrap: {
      status: bootstrap && bootstrap.mergeRequest ? 'merge_request_open' : bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      branch: bootstrap && bootstrap.branch || project.defaultBranch || '',
      commitId: bootstrap && bootstrap.commitId || '',
      mergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
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
      status: bootstrap && bootstrap.mergeRequest ? 'pending_repo_change' : 'installed',
      mode: 'server-side',
      hookId: hook && hook.id ? String(hook.id) : '',
      bootstrapStatus: bootstrap && bootstrap.mergeRequest ? 'merge_request_open' : bootstrap && bootstrap.skipped ? 'skipped' : 'installed',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
      bootstrapMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
    });
    return {
      status: bootstrap && bootstrap.mergeRequest ? 202 : 201,
      body: {
        repository: repoWithWebhook(basePublicUrl, installed),
        installed: !(bootstrap && bootstrap.mergeRequest),
        pendingMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
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
  checkGitlabProjectInstall,
  installGitlabProject,
  listGitlabProjectsWithInstallStatus,
}
