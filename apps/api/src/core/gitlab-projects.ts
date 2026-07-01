// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  configureGitlabProjectVariables,
  getGitlabCurrentUser,
  getGitlabProjectForInstall,
  getGitlabProjectMember,
  getGitlabRepositoryFile,
  getGitlabVariableForInstall,
  listGitlabProjects,
  listGitlabWebhooks,
  syncGitlabProjectLabels,
  upsertGitlabProjectVariable,
  upsertGitlabWebhook,
} from './gitlab.js'
import {
  installGitlabBootstrap,
  installGitlabBootstrapMergeRequest,
  installGitlabPluginMergeRequest,
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

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const ISSUE_FLOW_PLUGIN_KEY = 'issue-flow'
const ISSUE_FLOW_MANIFEST_PATH = '.issue-flow/install-manifest.json'
const LATEST_ISSUE_FLOW_VERSION = readPackageVersion()

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

function gitlabCiVariablesForInstall({ config, installConfig }) {
  const automation = installConfig.automation || {};
  const agentrix = installConfig.agentrix || {};
  const runnerId = agentrix.runnerId || automation.runnerId || '';
  return [
    { key: 'AGENTRIX_BASE_URL', value: agentrix.baseUrl, required: true },
    { key: 'AGENTRIX_API_KEY', value: agentrix.apiKey, masked: true, required: true },
    { key: 'AGENTRIX_RUNNER_ID', value: runnerId, required: true },
    { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: automation.agent || 'codex', required: true },
    { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: automation.autoDefault || 'triage', required: true },
    { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: automation.reviewEnabled ? 'true' : 'false', required: true },
  ];
}

function missingRequiredVariableKeys(variables = [], existingByKey = new Map()) {
  return variables
    .filter((variable) => variable
      && variable.required !== false
      && !existingByKey.has(variable.key)
      && (variable.value === undefined || variable.value === ''))
    .map((variable) => variable.key);
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
    return { status: 'passed', detail: '已设置' };
  }
  if (!required && !writable) {
    return { status: 'passed', detail: variable.emptyDetail || '未设置，使用默认值' };
  }
  if (needsInput) {
    return { status: 'needs_input', detail: '需要填写后写入 GitLab' };
  }
  return { status: 'needs_action', detail: '可通过 GitLab API 写入' };
}

function gitlabRoleFromAccessLevel(accessLevel = 0) {
  if (accessLevel >= 50) return 'Owner';
  if (accessLevel >= 40) return 'Maintainer';
  if (accessLevel >= 30) return 'Developer';
  if (accessLevel >= 20) return 'Reporter';
  if (accessLevel >= 10) return 'Guest';
  return 'No access';
}

async function resolveGitlabProjectAccess({ project, apiInput, user } = {}) {
  let accessLevel = Number(project && project.accessLevel || 0);
  let accessLevelKnown = Boolean(project && project.accessLevelKnown);
  if ((!accessLevelKnown || accessLevel < 40) && user && user.id) {
    const member = await getGitlabProjectMember({
      ...apiInput,
      userId: user.id,
    });
    if (member && (member.access_level !== undefined || member.accessLevel !== undefined)) {
      accessLevel = Math.max(accessLevel, Number(member.access_level || member.accessLevel || 0));
      accessLevelKnown = true;
    }
  }
  return {
    accessLevel,
    accessLevelKnown,
    role: gitlabRoleFromAccessLevel(accessLevel),
    canManage: accessLevelKnown && accessLevel >= 40,
  };
}

function normalizeCheckTypes(input = {}) {
  const raw = Array.isArray(input.checkTypes)
    ? input.checkTypes
    : String(input.checkType || input.type || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const allowed = new Set(['variables', 'webhook', 'plugins']);
  const values = raw.filter((item) => allowed.has(item));
  return values.length ? Array.from(new Set(values)) : ['variables', 'webhook', 'plugins'];
}

function variableResult(variable, existingVariable) {
  const state = variableCheckState(variable, existingVariable);
  const required = variable.required !== false;
  const writable = variable.value !== undefined && variable.value !== '';
  const cache = variableCache(existingVariable);
  return {
    key: variable.key,
    label: variable.label || variable.key,
    description: variable.description || '',
    value: cache && cache.value || '',
    exists: Boolean(existingVariable),
    required,
    writable,
    masked: cache ? Boolean(cache.masked) : Boolean(variable.masked),
    status: state.status,
    detail: state.detail,
    source: cache && cache.source || '',
    groupPath: cache && cache.groupPath || '',
    scope: cache && cache.environmentScope || '*',
    environmentScope: cache && cache.environmentScope || '*',
    variableType: cache && cache.variableType || variable.variableType || 'env_var',
    protected: cache ? Boolean(cache.protected) : Boolean(variable.protected),
    raw: cache ? cache.raw !== false : variable.raw !== false,
    hidden: cache ? Boolean(cache.hidden) : Boolean(variable.hidden),
    needsInput: state.status === 'needs_input',
    control: variable.control || undefined,
  };
}

function variableCache(existingVariable) {
  if (!existingVariable) return undefined;
  const cache = {
    key: existingVariable.key || '',
    value: existingVariable.masked || existingVariable.hidden ? '*****' : existingVariable.value || '',
    source: existingVariable.source || '',
    groupPath: existingVariable.groupPath || '',
    environmentScope: existingVariable.environmentScope || existingVariable.scope || '*',
    variableType: existingVariable.variableType || 'env_var',
    protected: Boolean(existingVariable.protected),
    masked: Boolean(existingVariable.masked),
    raw: existingVariable.raw !== false,
    hidden: Boolean(existingVariable.hidden),
  };
  if (existingVariable.description) {
    cache.description = existingVariable.description;
  }
  return cache;
}

function webhookCache(hook) {
  if (!hook) return undefined;
  return {
    key: 'issue-flow',
    source: 'gitlab',
    hookId: hook.id !== undefined ? String(hook.id) : '',
    url: hook.url || '',
    issuesEvents: Boolean(hook.issues_events || hook.issuesEvents),
    noteEvents: Boolean(hook.note_events || hook.noteEvents),
    mergeRequestsEvents: Boolean(hook.merge_requests_events || hook.mergeRequestsEvents),
    pipelineEvents: Boolean(hook.pipeline_events || hook.pipelineEvents),
    jobEvents: Boolean(hook.job_events || hook.jobEvents),
    enableSslVerification: hook.enable_ssl_verification !== false && hook.enableSslVerification !== false,
    createdAt: hook.created_at || hook.createdAt || '',
    updatedAt: hook.updated_at || hook.updatedAt || '',
  };
}

function parseVersion(value = '') {
  return String(value || '')
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0)
}

function compareVersions(left = '', right = '') {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const length = Math.max(a.length, b.length, 3)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function decodeGitlabFile(file) {
  if (!file || file.content === undefined || file.content === null) return ''
  if (file.encoding === 'base64' || !file.encoding) {
    return Buffer.from(String(file.content || ''), 'base64').toString('utf8')
  }
  return String(file.content || '')
}

function pluginSettingFromRepository(repository) {
  return (repository && repository.settings && repository.settings.plugins && repository.settings.plugins.items || [])
    .find((item) => item && item.key === ISSUE_FLOW_PLUGIN_KEY)
}

function pluginCacheFromManifest(manifest = {}, extra = {}) {
  const installedVersion = String(manifest.issueFlowVersion || manifest.issue_flow_version || '')
  const latestVersion = extra.latestVersion || LATEST_ISSUE_FLOW_VERSION
  return {
    key: ISSUE_FLOW_PLUGIN_KEY,
    source: 'gitlab',
    manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    installed: true,
    installedVersion,
    latestVersion,
    manifestVersion: Number(manifest.version || 0),
    provider: manifest.provider || 'gitlab',
    runtime: manifest.runtime || 'agentrix',
    needsUpgrade: Boolean(installedVersion && latestVersion && compareVersions(installedVersion, latestVersion) < 0),
    pendingMergeRequest: extra.pendingMergeRequest || undefined,
  }
}

function pluginStepFromCache(cache, extra = {}) {
  if (!cache) {
    return installStep('plugins', 'repo', 'issue-flow plugin', 'needs_action', '未安装', {
      plugins: [{
        key: ISSUE_FLOW_PLUGIN_KEY,
        manifestPath: ISSUE_FLOW_MANIFEST_PATH,
        latestVersion: LATEST_ISSUE_FLOW_VERSION,
        installed: false,
      }],
    })
  }
  const pending = cache.pendingMergeRequest && cache.pendingMergeRequest.webUrl
  const needsUpgrade = Boolean(cache.needsUpgrade)
  const detail = pending
    ? `MR !${cache.pendingMergeRequest.iid || ''} 待合并`
    : needsUpgrade
      ? `${cache.installedVersion || 'unknown'} -> ${cache.latestVersion || LATEST_ISSUE_FLOW_VERSION}`
      : cache.installedVersion ? `v${cache.installedVersion.replace(/^v/, '')}` : '已安装'
  return installStep('plugins', 'repo', 'issue-flow plugin', needsUpgrade || pending ? 'needs_action' : 'passed', detail, {
    plugins: [cache],
    files: extra.files || undefined,
    actionCount: extra.actionCount || undefined,
  })
}

async function readGitlabIssueFlowManifest(apiInput, branch) {
  const file = await getGitlabRepositoryFile({
    ...apiInput,
    filePath: ISSUE_FLOW_MANIFEST_PATH,
    ref: branch,
  })
  if (!file) return undefined
  const content = decodeGitlabFile(file)
  return JSON.parse(content)
}

function mergeVariableCache(existingItems = [], nextVariable = {}) {
  const byKey = new Map(
    (existingItems || [])
      .map((item) => variableCache(item))
      .filter(Boolean)
      .map((item) => [item.key, item])
  );
  byKey.set(nextVariable.key, nextVariable);
  return Array.from(byKey.values()).sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
}

async function loadExistingInstallVariables(apiInput, definitions = []) {
  const existingByKey = new Map();
  for (const definition of definitions) {
    const existing = await getGitlabVariableForInstall(apiInput, definition.key);
    if (existing) existingByKey.set(definition.key, existing);
  }
  return existingByKey;
}

function variableCacheItems(existingByKey = new Map()) {
  return Array.from(existingByKey.values())
    .map((item) => variableCache(item))
    .filter(Boolean)
    .sort((a, b) => String(a.key || '').localeCompare(String(b.key || '')));
}

async function gitlabInstallContext({ store, input = {}, session, env = process.env }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const projectIdOrPath = input.projectId || input.projectPath || '';
  if (!token) {
    const error = new Error('gitlab_login_required');
    error.status = 401;
    error.code = 'gitlab_login_required';
    throw error;
  }
  const user = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType,
  });
  if (user.status !== 'valid') {
    const error = new Error('gitlab_login_required');
    error.status = 401;
    error.code = 'gitlab_login_required';
    error.validation = user;
    throw error;
  }
  if (!projectIdOrPath) {
    const error = new Error('project_required');
    error.status = 400;
    error.code = 'project_required';
    throw error;
  }
  const project = await getGitlabProjectForInstall({
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath,
  });
  const existing = await store.findRepositoryByProject({
    gitServerId: server.id,
    projectId: project.id,
    projectPath: project.pathWithNamespace,
  });
  const defaults = await savedAgentrixDefaults(store, session, env);
  let agentrixDefaults = defaults;
  if (existing) {
    agentrixDefaults = {
      automation: {
        ...(defaults.automation || {}),
        ...(existing.automation || {}),
      },
      agentrix: {
        ...(defaults.agentrix || {}),
        ...(existing.agentrix || {}),
        apiKey: defaults.agentrix && defaults.agentrix.apiKey || '',
      },
    };
  }
  const installConfig = mergeAgentrixInstallInput(input, agentrixDefaults, env);
  const apiInput = {
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath: project.id || project.pathWithNamespace,
    projectPath: project.pathWithNamespace,
  };
  return {
    server,
    config,
    user,
    token,
    authType,
    project,
    existing,
    installConfig,
    apiInput,
  };
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
  await store.syncRepositories({
    gitServerId: server.id,
    userId: input.userId || session && session.userId || '',
    projects,
  });
  return {
    status: 200,
    body: {
      projects: projects.map((project) => ({
        ...project,
        canInstall: Boolean(project.canInstall),
      })),
    },
  };
}

async function getGitlabProjectRole({ store, input = {}, session, env = process.env }) {
  try {
    const { server, project, apiInput, user } = await gitlabInstallContext({ store, input, session, env });
    const access = await resolveGitlabProjectAccess({ project, apiInput, user });
    return {
      status: 200,
      body: {
        gitServer: { id: server.id, name: server.name },
        project,
        access,
      },
    };
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_project_role_failed',
        validation: error && error.validation || undefined,
        detail: error && error.message || '',
      },
    };
  }
}

async function checkGitlabProjectInstall({ store, basePublicUrl, input = {}, session, env = process.env }) {
  const steps = [];

  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_install_check_failed',
        validation: error && error.validation || undefined,
        installable: false,
        steps,
      },
    };
  }
  const { server, config, project, existing, installConfig, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return {
      status: 403,
      body: {
        error: 'gitlab_project_permission_required',
        installable: false,
        access,
        steps,
      },
    };
  }
  const checkTypes = normalizeCheckTypes(input);

  if (checkTypes.includes('variables')) {
    const variables = gitlabCiVariablesForInstall({ config, installConfig });
    const variableResults = [];
    const variableCaches = [];
    for (const variable of variables) {
      const existingVariable = await getGitlabVariableForInstall(apiInput, variable.key);
      const cache = variableCache(existingVariable);
      if (cache) variableCaches.push(cache);
      variableResults.push(variableResult(variable, existingVariable));
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
        : '变量已设置';
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
      await store.updateRepositorySettingsCache(existing.id, {
        variables: {
          items: variableCaches,
          checkedAt: new Date().toISOString(),
        },
      });
    }
  }

  if (checkTypes.includes('webhook')) {
    let webhookStep;
    if (existing) {
      const publicRepo = repoWithWebhook(basePublicUrl, existing);
      const hooks = await listGitlabWebhooks(apiInput);
      const hook = hooks.find((item) => item && item.url === publicRepo.webhookUrl);
      const hookState = statusFromBoolean(Boolean(hook), '需要通过 API 配置 GitLab webhook', 'Webhook 已配置');
      webhookStep = installStep('webhook', 'api', 'GitLab webhook', hookState.status, hook && hook.url || hookState.detail);
      await store.updateRepositorySettingsCache(existing.id, {
        webhook: hook ? webhookCache(hook) : null,
      });
    } else {
      webhookStep = installStep(
        'webhook',
        'api',
        'GitLab webhook',
        'needs_action',
        '安装时创建仓库记录后通过 API 配置 webhook'
      );
    }
    steps.push(webhookStep);
  }

  if (checkTypes.includes('plugins')) {
    let pluginStep = pluginStepFromCache(undefined);
    if (existing) {
      const checkedAt = new Date().toISOString();
      try {
        const manifest = await readGitlabIssueFlowManifest(apiInput, project.defaultBranch || existing.defaultBranch || 'main');
        if (manifest) {
          const previous = pluginSettingFromRepository(existing);
          const next = pluginCacheFromManifest(manifest, {
            pendingMergeRequest: previous && previous.needsUpgrade ? previous.pendingMergeRequest : undefined,
          });
          await store.updateRepositorySettingsCache(existing.id, {
            plugins: { items: [next], checkedAt },
          });
          pluginStep = pluginStepFromCache(next);
        } else {
          await store.updateRepositorySettingsCache(existing.id, {
            plugins: { items: [], checkedAt },
          });
        }
      } catch (error) {
        if (error && error.status) {
          pluginStep = installStep('plugins', 'repo', 'issue-flow plugin', 'blocked', `读取 manifest 失败：HTTP ${error.status}`, {
            plugins: [],
          });
        } else {
          const invalid = {
            key: ISSUE_FLOW_PLUGIN_KEY,
            source: 'gitlab',
            manifestPath: ISSUE_FLOW_MANIFEST_PATH,
            installed: true,
            manifestInvalid: true,
            latestVersion: LATEST_ISSUE_FLOW_VERSION,
            detail: error && error.message || 'manifest invalid',
          };
          await store.updateRepositorySettingsCache(existing.id, {
            plugins: { items: [invalid], checkedAt },
          });
          pluginStep = installStep('plugins', 'repo', 'issue-flow plugin', 'needs_action', 'manifest 无效，需要重新安装', {
            plugins: [invalid],
          });
        }
      }
    }
    steps.push(pluginStep);
  }

  const installable = steps.every((step) => step.status !== 'blocked')
    && steps.every((step) => step.status !== 'needs_input');
  return {
    status: 200,
    body: {
      gitServer: { id: server.id, name: server.name, baseUrl: config.baseUrl },
      project,
      repository: existing || null,
      access,
      installable,
      steps,
    },
  };
}

async function setGitlabProjectInstallVariable({ store, input = {}, session, env = process.env }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_variable_set_failed',
        validation: error && error.validation || undefined,
      },
    };
  }
  const { config, project, existing, installConfig, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return { status: 403, body: { error: 'gitlab_project_permission_required', access } };
  }
  if (!existing) {
    return { status: 404, body: { error: 'repository_not_found' } };
  }
  const key = String(input.key || '').trim();
  const definitions = gitlabCiVariablesForInstall({ config, installConfig });
  const definition = definitions.find((item) => item.key === key);
  if (!definition) {
    return { status: 400, body: { error: 'gitlab_variable_unknown' } };
  }
  const nextValue = input.value !== undefined ? input.value : definition.value;
  if (nextValue === undefined || nextValue === '') {
    return { status: 400, body: { error: 'gitlab_variable_value_required' } };
  }
  await upsertGitlabProjectVariable(apiInput, {
    ...definition,
    value: String(nextValue),
    environmentScope: input.environmentScope || input.scope || definition.environmentScope || '*',
  });
  const saved = await getGitlabVariableForInstall(apiInput, key);
  const item = variableResult(definition, saved);
  const cache = variableCache(saved);
  const currentItems = existing.settings && existing.settings.variables && existing.settings.variables.items || [];
  const variables = {
    items: cache ? mergeVariableCache(currentItems, cache) : currentItems,
    checkedAt: new Date().toISOString(),
  };
  const repository = await store.updateRepositorySettingsCache(existing.id, { variables });
  const cacheByKey = new Map(variables.items.map((variable) => [variable.key, variable]));
  const step = installStep('variables', 'api', 'CI/CD variables', 'passed', '变量已设置', {
    variables: definitions.map((variable) => variable.key === key
      ? item
      : variableResult(variable, cacheByKey.get(variable.key))),
  });
  return {
    status: 200,
    body: {
      repository,
      step,
      variable: item,
      steps: [step],
      installable: true,
    },
  };
}

async function setGitlabProjectInstallWebhook({ store, basePublicUrl, input = {}, session, env = process.env }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_webhook_set_failed',
        validation: error && error.validation || undefined,
      },
    };
  }
  const { config, project, existing, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return { status: 403, body: { error: 'gitlab_project_permission_required', access } };
  }
  if (!existing) {
    return { status: 404, body: { error: 'repository_not_found' } };
  }
  const webhookSecret = config.webhookSecret || '';
  if (!webhookSecret) {
    return { status: 400, body: { error: 'git_server_webhook_secret_required' } };
  }

  const publicRepo = repoWithWebhook(basePublicUrl, existing);
  let hook;
  try {
    hook = await upsertGitlabWebhook({
      apiUrl: config.apiUrl,
      token: apiInput.token,
      authType: apiInput.authType,
      projectIdOrPath: apiInput.projectIdOrPath,
      hookId: existing.webhook && existing.webhook.hookId || '',
      webhookUrl: publicRepo.webhookUrl,
      webhookSecret,
    });
  } catch (error) {
    return {
      status: 502,
      body: {
        error: 'gitlab_webhook_install_failed',
        repository: publicRepo,
        detail: sanitizeError(error),
      },
    };
  }

  const cache = webhookCache(hook);
  await store.updateRepositorySettingsCache(existing.id, { webhook: cache });
  const repository = await store.updateRepositoryWebhookCache(existing.id, {
    hookId: cache && cache.hookId || '',
  });
  const step = installStep('webhook', 'api', 'GitLab webhook', 'passed', cache && cache.url || publicRepo.webhookUrl);
  return {
    status: 200,
    body: {
      repository: repoWithWebhook(basePublicUrl, repository),
      step,
      steps: [step],
      webhook: cache,
      installable: true,
    },
  };
}

async function installGitlabProjectPlugin({ store, input = {}, session, env = process.env }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_plugin_install_context_failed',
        validation: error && error.validation || undefined,
        detail: error && error.message || '',
      },
    };
  }

  const { server, config, project, existing, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return {
      status: 403,
      body: { error: 'gitlab_project_permission_required', access },
    };
  }
  if (!existing) {
    return {
      status: 404,
      body: { error: 'repository_not_found' },
    };
  }

  const previous = pluginSettingFromRepository(existing);
  if (previous && previous.pendingMergeRequest && previous.pendingMergeRequest.webUrl && !input.force) {
    const step = pluginStepFromCache(previous);
    return {
      status: 200,
      body: {
        repository: existing,
        access,
        step,
        steps: [step],
        plugin: previous,
        pendingMergeRequest: previous.pendingMergeRequest,
        installable: true,
      },
    };
  }

  const operation = previous && previous.installed ? 'upgrade' : 'install';
  let result;
  try {
    result = await installGitlabPluginMergeRequest({
      apiUrl: config.apiUrl,
      token: apiInput.token,
      authType: apiInput.authType,
      projectIdOrPath: apiInput.projectIdOrPath,
      baseUrl: config.baseUrl,
      projectPath: project.pathWithNamespace,
      branch: project.defaultBranch || existing.defaultBranch || 'main',
      operation,
      commitMessage: input.commitMessage || `${operation === 'upgrade' ? 'Upgrade' : 'Install'} issue-flow plugin`,
      mergeRequestTitle: input.mergeRequestTitle || `${operation === 'upgrade' ? 'Upgrade' : 'Install'} issue-flow plugin`,
    });
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'gitlab_plugin_install_failed',
        detail: sanitizeError(error),
      },
    };
  }

  if (result.skipped) {
    const checkedAt = new Date().toISOString();
    let next = previous;
    try {
      const manifest = await readGitlabIssueFlowManifest(apiInput, project.defaultBranch || existing.defaultBranch || 'main');
      next = manifest ? pluginCacheFromManifest(manifest) : undefined;
    } catch {
      next = previous;
    }
    await store.updateRepositorySettingsCache(existing.id, {
      plugins: { items: next ? [next] : [], checkedAt },
    });
    const repository = await store.getRepository(existing.id);
    const step = pluginStepFromCache(next);
    return {
      status: 200,
      body: {
        repository,
        access,
        step,
        steps: [step],
        plugin: next,
        installable: true,
      },
    };
  }

  const pending = {
    id: result.mergeRequest && result.mergeRequest.id || '',
    iid: result.mergeRequest && result.mergeRequest.iid || '',
    webUrl: result.mergeRequest && result.mergeRequest.webUrl || '',
    sourceBranch: result.sourceBranch || '',
    targetBranch: result.branch || '',
  };
  const next = {
    ...(previous || {}),
    key: ISSUE_FLOW_PLUGIN_KEY,
    source: 'gitlab',
    manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    latestVersion: LATEST_ISSUE_FLOW_VERSION,
    targetVersion: LATEST_ISSUE_FLOW_VERSION,
    installed: Boolean(previous && previous.installed),
    pendingMergeRequest: pending,
    needsUpgrade: true,
  };
  await store.updateRepositorySettingsCache(existing.id, {
    plugins: {
      items: [next],
      checkedAt: new Date().toISOString(),
    },
  });
  const repository = await store.getRepository(existing.id);
  const step = pluginStepFromCache(next, {
    files: result.files || [],
    actionCount: result.actionCount || 0,
  });
  return {
    status: 202,
    body: {
      repository,
      access,
      step,
      steps: [step],
      plugin: next,
      pendingMergeRequest: pending,
      installable: true,
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
  const apiInput = {
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath: project.id || project.pathWithNamespace,
    projectPath: project.pathWithNamespace,
  };
  let user;
  if (!project.accessLevelKnown || Number(project.accessLevel || 0) < 40) {
    user = await getGitlabCurrentUser({
      apiUrl: config.apiUrl,
      token,
      authType,
    });
    if (user.status !== 'valid') {
      return { status: 401, body: { error: 'gitlab_login_required', validation: user } };
    }
  }
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return {
      status: 403,
      body: { error: 'gitlab_project_permission_required', access },
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
    agentrixDefaults = {
      automation: {
        ...(userAgentrixDefaults.automation || {}),
        ...(existing.automation || {}),
      },
      agentrix: {
        ...(userAgentrixDefaults.agentrix || {}),
        ...(existing.agentrix || {}),
        apiKey: userAgentrixDefaults.agentrix && userAgentrixDefaults.agentrix.apiKey || '',
      },
    };
  }
  const installConfig = mergeAgentrixInstallInput(input, agentrixDefaults, env);
  const installVariables = gitlabCiVariablesForInstall({ config, installConfig });
  const existingVariables = existing
    ? await loadExistingInstallVariables(apiInput, installVariables)
    : new Map();
  const missingRequiredVariables = missingRequiredVariableKeys(installVariables, existingVariables);
  if (missingRequiredVariables.length) {
    return {
      status: 400,
      body: {
        error: 'gitlab_required_variable_missing',
        missing: missingRequiredVariables,
      },
    };
  }
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
      projectIdOrPath: apiInput.projectIdOrPath,
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
      projectIdOrPath: apiInput.projectIdOrPath,
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
      projectIdOrPath: apiInput.projectIdOrPath,
      variables: installVariables,
    });
    if (existing) {
      const nextVariables = await loadExistingInstallVariables(apiInput, installVariables);
      await store.updateRepositorySettingsCache(existing.id, {
        variables: {
          items: variableCacheItems(nextVariables),
          checkedAt: new Date().toISOString(),
        },
      });
    }
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
    const configured = await store.updateRepositoryAutomation(existing.id, {
      automation: installConfig.automation,
      agentrix: installConfig.agentrix,
      tokenAuth: config.tokenAuth || 'bearer',
    });
    const existingWithWebhook = repoWithWebhook(basePublicUrl, existing);
    let hook;
    try {
      hook = await upsertGitlabWebhook({
        apiUrl: config.apiUrl,
        token,
        authType,
        projectIdOrPath: apiInput.projectIdOrPath,
        hookId: existing.webhook && existing.webhook.hookId || '',
        webhookUrl: existingWithWebhook.webhookUrl,
        webhookSecret,
      });
    } catch (error) {
      return {
        status: 502,
        body: {
          error: 'gitlab_webhook_install_failed',
          repository: repoWithWebhook(basePublicUrl, existing),
          detail: sanitizeError(error),
        },
      };
    }
    const updated = await store.updateRepositoryWebhookCache(existing.id, {
      hookId: hook && hook.id ? String(hook.id) : existing.webhook && existing.webhook.hookId || '',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
      bootstrapMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
    });
    if (session && session.userId || input.userId) {
      await store.grantUserRepoAccess({
        userId: session && session.userId || input.userId,
        gitServerId: server.id,
        repoId: existing.id,
      });
    }
    return {
      status: 200,
      body: {
        repository: repoWithWebhook(basePublicUrl, {
          ...updated,
          automation: configured && configured.automation || updated.automation,
          agentrix: configured && configured.agentrix || updated.agentrix,
        }),
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
    userId: session && session.userId || input.userId || '',
    projectPath: project.pathWithNamespace,
    automation: installConfig.automation,
    agentrix: installConfig.agentrix,
  }, validation);
  const publicRepo = repoWithWebhook(basePublicUrl, created.repo);

  try {
    const hook = await upsertGitlabWebhook({
      apiUrl: config.apiUrl,
      token,
      authType,
      projectIdOrPath: apiInput.projectIdOrPath,
      webhookUrl: publicRepo.webhookUrl,
      webhookSecret,
    });
    const updated = await store.updateRepositoryWebhookCache(created.repo.id, {
      hookId: hook && hook.id ? String(hook.id) : '',
      bootstrapCommitId: bootstrap && bootstrap.commitId || '',
      bootstrapMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
    });
    return {
      status: bootstrap && bootstrap.mergeRequest ? 202 : 201,
      body: {
        repository: repoWithWebhook(basePublicUrl, {
          ...updated,
          automation: created.repo.automation,
          agentrix: created.repo.agentrix,
        }),
        pendingMergeRequest: bootstrap && bootstrap.mergeRequest || undefined,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error: 'gitlab_webhook_install_failed',
        repository: repoWithWebhook(basePublicUrl, created.repo),
        detail: sanitizeError(error),
      },
    };
  }
}

export {
  checkGitlabProjectInstall,
  getGitlabProjectRole,
  installGitlabProject,
  installGitlabProjectPlugin,
  listGitlabProjectsWithInstallStatus,
  setGitlabProjectInstallVariable,
  setGitlabProjectInstallWebhook,
}
