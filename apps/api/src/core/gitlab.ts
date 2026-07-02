// @ts-nocheck
import labels from '../../../../skills/issue-flow/scripts/labels.cjs'
import providers from '../../../../skills/issue-flow/scripts/providers.cjs'
import { nowIso } from './store.js'

const { labelsForScope } = labels
const { labelMatchesDefinition, providerLabelDefinition, requestGitlab } = providers

function projectApiPath(projectPath) {
  return `/projects/${encodeURIComponent(projectPath)}`;
}

function projectFileApiPath(projectIdOrPath, filePath) {
  return `${projectApiPath(projectIdOrPath)}/repository/files/${encodeURIComponent(filePath)}`;
}

function parseScopes(headers) {
  const scopeHeader = headers && typeof headers.get === 'function'
    ? headers.get('x-oauth-scopes') || headers.get('x-accepted-oauth-scopes') || ''
    : '';
  return String(scopeHeader || '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function tokenHeaders(token, authType = 'bearer') {
  if (authType === 'private-token') {
    return { 'PRIVATE-TOKEN': token };
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchJson(method, apiUrl, path, token, options = {}) {
  const response = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...tokenHeaders(token, options.authType),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const message = parsed && parsed.message
      ? typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message)
      : `GitLab API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return { parsed, headers: response.headers };
}

function normalizeProject(project = {}) {
  const permissions = project.permissions || {};
  const projectAccess = permissions.project_access && permissions.project_access.access_level || 0;
  const groupAccess = permissions.group_access && permissions.group_access.access_level || 0;
  const accessLevelKnown = Boolean(
    permissions.project_access
    || permissions.group_access
    || project.access_level !== undefined
  );
  const accessLevel = Math.max(
    Number(projectAccess || 0),
    Number(groupAccess || 0),
    Number(project.access_level || 0)
  );
  return {
    id: project.id !== undefined ? String(project.id) : '',
    name: project.name || '',
    pathWithNamespace: project.path_with_namespace || project.path || '',
    webUrl: project.web_url || '',
    defaultBranch: project.default_branch || '',
    accessLevel,
    accessLevelKnown,
    permissionStatus: accessLevelKnown ? (accessLevel >= 40 ? 'can_install' : 'no_permission') : 'unknown',
    canInstall: accessLevelKnown ? accessLevel >= 40 : false,
    sharedRunnersEnabled: project.shared_runners_enabled !== false && project.sharedRunnersEnabled !== false,
    groupRunnersEnabled: project.group_runners_enabled !== false && project.groupRunnersEnabled !== false,
  };
}

function normalizeIssue(issue = {}) {
  return {
    id: issue.id !== undefined ? String(issue.id) : '',
    iid: Number(issue.iid || issue.number || 0),
    title: issue.title || '',
    state: issue.state || '',
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => String(label || '')).filter(Boolean) : [],
    createdAt: issue.created_at || '',
    updatedAt: issue.updated_at || '',
    closedAt: issue.closed_at || '',
  };
}

async function listGitlabProjectsPage(input = {}, extraParams = {}) {
  const params = new URLSearchParams({
    membership: 'true',
    ...extraParams,
    per_page: String(input.perPage || 100),
  });
  const result = await fetchJson('GET', input.apiUrl, `/projects?${params}`, input.token, {
    authType: input.authType,
  });
  return Array.isArray(result.parsed) ? result.parsed.map(normalizeProject) : [];
}

async function listGitlabIssues(input = {}) {
  const issues = [];
  let page = 1;
  while (page <= Number(input.maxPages || 50)) {
    const params = new URLSearchParams({
      state: input.state || 'all',
      scope: input.scope || 'all',
      per_page: String(input.perPage || 100),
      page: String(page),
    });
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/issues?${params}`,
      input.token,
      { authType: input.authType }
    );
    if (Array.isArray(result.parsed)) {
      issues.push(...result.parsed.map(normalizeIssue));
    }
    const nextPage = result.headers && result.headers.get && result.headers.get('x-next-page');
    if (!nextPage) break;
    page = Number(nextPage);
    if (!page) break;
  }
  return issues;
}

function gitlabOAuthRedirectUri(config, basePublicUrl) {
  return `${String(basePublicUrl || '').replace(/\/+$/, '')}/api/auth/gitlab/callback`;
}

function gitlabOAuthAuthorizeUrl({ config, state, basePublicUrl, appUrl }) {
  if (!config.oauthClientId) {
    const error = new Error('GitLab OAuth client id is not configured');
    error.status = 400;
    throw error;
  }
  const url = new URL('/oauth/authorize', config.baseUrl);
  url.searchParams.set('client_id', config.oauthClientId);
  url.searchParams.set('redirect_uri', gitlabOAuthRedirectUri(config, basePublicUrl));
  url.searchParams.set('response_type', 'code');
  if (config.oauthScopes) {
    url.searchParams.set('scope', config.oauthScopes);
  }
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeGitlabOAuthCode({ config, code, basePublicUrl, appUrl }) {
  if (!config.oauthClientId || !config.oauthClientSecret) {
    const error = new Error('GitLab OAuth client is not configured');
    error.status = 400;
    throw error;
  }
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: gitlabOAuthRedirectUri(config, basePublicUrl),
  });
  const response = await fetch(new URL('/oauth/token', config.baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const error = new Error('GitLab OAuth token exchange failed');
    error.status = response.status;
    throw error;
  }
  return parsed || {};
}

async function refreshGitlabOAuthToken({ config, refreshToken }) {
  if (!config.oauthClientId || !config.oauthClientSecret) {
    const error = new Error('GitLab OAuth client is not configured');
    error.status = 400;
    throw error;
  }
  if (!refreshToken) {
    const error = new Error('GitLab OAuth refresh token is missing');
    error.status = 401;
    throw error;
  }
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const response = await fetch(new URL('/oauth/token', config.baseUrl), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const error = new Error('GitLab OAuth token refresh failed');
    error.status = response.status;
    throw error;
  }
  return parsed || {};
}

async function getGitlabCurrentUser(input = {}) {
  const token = input.token || '';
  if (!token) {
    return {
      status: 'missing',
      errorCode: 'MISSING_TOKEN',
      lastValidatedAt: nowIso(),
    };
  }
  try {
    const user = await fetchJson('GET', input.apiUrl, '/user', token, { authType: input.authType });
    return {
      status: 'valid',
      id: user.parsed && user.parsed.id !== undefined ? String(user.parsed.id) : '',
      username: user.parsed && (user.parsed.username || user.parsed.name) || '',
      name: user.parsed && user.parsed.name || '',
      email: user.parsed && user.parsed.email || '',
      avatarUrl: user.parsed && user.parsed.avatar_url || '',
      scopes: parseScopes(user.headers),
      lastValidatedAt: nowIso(),
      errorCode: '',
    };
  } catch (error) {
    return {
      status: 'invalid',
      username: '',
      name: '',
      scopes: [],
      lastValidatedAt: nowIso(),
      errorCode: error && error.status ? `HTTP_${error.status}` : 'VALIDATION_FAILED',
    };
  }
}

async function listGitlabProjects(input = {}) {
  const projects = await listGitlabProjectsPage(input);
  return Promise.all(projects.map(async (project) => {
    if (project.accessLevelKnown || !project.id) {
      return project;
    }
    try {
      const detailed = await getGitlabProjectForInstall({
        apiUrl: input.apiUrl,
        token: input.token,
        authType: input.authType,
        projectIdOrPath: project.id,
      });
      return detailed;
    } catch {
      return project;
    }
  }));
}

async function getGitlabProjectForInstall(input = {}) {
  const result = await fetchJson('GET', input.apiUrl, projectApiPath(input.projectIdOrPath), input.token, {
    authType: input.authType,
  });
  return normalizeProject(result.parsed || {});
}

async function getGitlabProjectMember(input = {}) {
  const userId = String(input.userId || '').trim();
  if (!userId) return undefined;
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/members/all/${encodeURIComponent(userId)}`,
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}

async function addGitlabProjectMember(input = {}) {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/members`,
    input.token,
    {
      authType: input.authType,
      body: {
        user_id: input.userId,
        access_level: Number(input.accessLevel || 40),
      },
    }
  );
  return result.parsed || {};
}

async function updateGitlabProjectMember(input = {}) {
  const result = await fetchJson(
    'PUT',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/members/${encodeURIComponent(input.userId)}`,
    input.token,
    {
      authType: input.authType,
      body: {
        access_level: Number(input.accessLevel || 40),
      },
    }
  );
  return result.parsed || {};
}

async function upsertGitlabProjectMember(input = {}) {
  try {
    return await addGitlabProjectMember(input);
  } catch (error) {
    if (!error || error.status !== 409) {
      throw error;
    }
    return updateGitlabProjectMember(input);
  }
}

function gitlabWebhookBody(input = {}) {
  return {
    url: input.webhookUrl,
    token: input.webhookSecret,
    issues_events: true,
    note_events: true,
    merge_requests_events: true,
    pipeline_events: true,
    job_events: true,
    enable_ssl_verification: input.enableSslVerification !== false,
  };
}

async function installGitlabWebhook(input = {}) {
  const body = gitlabWebhookBody(input);
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/hooks`,
    input.token,
    { authType: input.authType, body }
  );
  return result.parsed || {};
}

async function updateGitlabWebhook(input = {}) {
  const body = gitlabWebhookBody(input);
  const result = await fetchJson(
    'PUT',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/hooks/${encodeURIComponent(input.hookId)}`,
    input.token,
    { authType: input.authType, body }
  );
  return result.parsed || {};
}

async function listGitlabWebhooks(input = {}) {
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/hooks`,
    input.token,
    { authType: input.authType }
  );
  return Array.isArray(result.parsed) ? result.parsed : [];
}

async function createGitlabMergeRequest(input = {}) {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/merge_requests`,
    input.token,
    {
      authType: input.authType,
      body: {
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title || 'Install issue-flow',
        description: input.description || '',
        remove_source_branch: input.removeSourceBranch !== false,
      },
    }
  );
  return result.parsed || {};
}

async function getGitlabMergeRequest(input = {}) {
  const iid = String(input.iid || input.mergeRequestIid || '').trim();
  if (!iid) return undefined;
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/merge_requests/${encodeURIComponent(iid)}`,
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function upsertGitlabWebhook(input = {}) {
  if (input.hookId) {
    try {
      return await updateGitlabWebhook(input);
    } catch (error) {
      if (!error || error.status !== 404) {
        throw error;
      }
    }
  }
  const hooks = await listGitlabWebhooks(input);
  const existing = hooks.find((hook) => hook && hook.url === input.webhookUrl);
  if (existing && existing.id) {
    return updateGitlabWebhook({
      ...input,
      hookId: String(existing.id),
    });
  }
  return installGitlabWebhook(input);
}

async function getGitlabProjectVariable(input = {}, key = '') {
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/variables/${encodeURIComponent(key)}`,
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function getGitlabGroupVariable(input = {}, groupPath = '', key = '') {
  if (!groupPath) return undefined;
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `/groups/${encodeURIComponent(groupPath)}/variables/${encodeURIComponent(key)}`,
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && (error.status === 403 || error.status === 404)) {
      return undefined;
    }
    throw error;
  }
}

function gitlabGroupPathsForProject(projectPath = '') {
  const parts = String(projectPath || '').split('/').filter(Boolean);
  parts.pop();
  const paths = [];
  while (parts.length) {
    paths.push(parts.join('/'));
    parts.pop();
  }
  return paths;
}

function publicGitlabVariable(variable = {}, source = 'project', groupPath = '') {
  if (!variable) return undefined;
  const masked = Boolean(variable.masked);
  const hidden = Boolean(variable.hidden);
  const rawValue = variable.value !== undefined && variable.value !== null ? String(variable.value) : '';
  const environmentScope = variable.environment_scope || variable.environmentScope || '*';
  return {
    key: variable.key || '',
    value: masked || hidden ? '*****' : rawValue,
    source,
    groupPath,
    scope: environmentScope,
    environmentScope,
    variableType: variable.variable_type || variable.variableType || 'env_var',
    protected: Boolean(variable.protected),
    masked,
    raw: variable.raw !== false,
    hidden,
    description: variable.description || '',
  };
}

async function getGitlabVariableForInstall(input = {}, key = '') {
  const projectVariable = await getGitlabProjectVariable(input, key);
  if (projectVariable) {
    return publicGitlabVariable(projectVariable, 'project');
  }
  for (const groupPath of gitlabGroupPathsForProject(input.projectPath || '')) {
    const groupVariable = await getGitlabGroupVariable(input, groupPath, key);
    if (groupVariable) {
      return publicGitlabVariable(groupVariable, 'group', groupPath);
    }
  }
  return undefined;
}

async function upsertGitlabProjectVariable(input = {}, variable = {}) {
  const key = variable.key;
  const body = {
    key,
    value: variable.value,
    variable_type: variable.variableType || 'env_var',
    environment_scope: variable.environmentScope || variable.scope || '*',
    protected: Boolean(variable.protected),
    masked: Boolean(variable.masked),
    raw: variable.raw !== false,
  };
  try {
    const result = await fetchJson(
      'PUT',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/variables/${encodeURIComponent(key)}`,
      input.token,
      { authType: input.authType, body }
    );
    return result.parsed || {};
  } catch (error) {
    if (!error || error.status !== 404) {
      throw error;
    }
    const result = await fetchJson(
      'POST',
      input.apiUrl,
      `${projectApiPath(input.projectIdOrPath)}/variables`,
      input.token,
      { authType: input.authType, body }
    );
    return result.parsed || {};
  }
}

async function configureGitlabProjectVariables(input = {}) {
  const variables = (input.variables || [])
    .filter((variable) => variable && variable.key && variable.value !== undefined && variable.value !== '');
  const results = [];
  for (const variable of variables) {
    results.push(await upsertGitlabProjectVariable(input, variable));
  }
  return results;
}

function normalizeGitlabRunner(runner = {}) {
  return {
    id: runner.id !== undefined ? String(runner.id) : '',
    description: runner.description || '',
    active: runner.active !== false,
    locked: Boolean(runner.locked),
    paused: Boolean(runner.paused),
    status: runner.status || '',
    runnerType: runner.runner_type || runner.runnerType || '',
    tagList: Array.isArray(runner.tag_list || runner.tagList)
      ? (runner.tag_list || runner.tagList).map((tag) => String(tag || '')).filter(Boolean)
      : [],
  };
}

async function listGitlabProjectRunners(input = {}) {
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/runners`,
    input.token,
    { authType: input.authType }
  );
  return Array.isArray(result.parsed) ? result.parsed.map(normalizeGitlabRunner) : [];
}

async function getGitlabRunner(input = {}, runnerId = '') {
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `/runners/${encodeURIComponent(runnerId)}`,
    input.token,
    { authType: input.authType }
  );
  return normalizeGitlabRunner(result.parsed || {});
}

async function listGitlabRunners(input = {}, params = {}) {
  const query = new URLSearchParams({
    per_page: String(input.perPage || 100),
    ...params,
  });
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `/runners?${query}`,
    input.token,
    { authType: input.authType }
  );
  return Array.isArray(result.parsed) ? result.parsed.map(normalizeGitlabRunner) : [];
}

async function enableGitlabRunnerForProject(input = {}, runnerId = '') {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/runners`,
    input.token,
    { authType: input.authType, body: { runner_id: runnerId } }
  );
  return result.parsed || {};
}

async function updateGitlabProjectRunnerSettings(input = {}, settings = {}) {
  const body = {};
  if (settings.sharedRunnersEnabled !== undefined) body.shared_runners_enabled = Boolean(settings.sharedRunnersEnabled);
  if (settings.groupRunnersEnabled !== undefined) body.group_runners_enabled = Boolean(settings.groupRunnersEnabled);
  const result = await fetchJson(
    'PUT',
    input.apiUrl,
    projectApiPath(input.projectIdOrPath),
    input.token,
    { authType: input.authType, body }
  );
  return normalizeProject(result.parsed || {});
}

function gitlabLabelApiPath(projectIdOrPath, labelName) {
  return `${projectApiPath(projectIdOrPath)}/labels/${encodeURIComponent(labelName)}`;
}

async function getGitlabProjectLabel(input = {}, labelName = '') {
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      gitlabLabelApiPath(input.projectIdOrPath, labelName),
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function createGitlabProjectLabel(input = {}, definition = {}) {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/labels`,
    input.token,
    { authType: input.authType, body: providerLabelDefinition('gitlab', definition) }
  );
  return result.parsed || {};
}

async function updateGitlabProjectLabel(input = {}, definition = {}) {
  const payload = providerLabelDefinition('gitlab', definition);
  const result = await fetchJson(
    'PUT',
    input.apiUrl,
    gitlabLabelApiPath(input.projectIdOrPath, definition.name),
    input.token,
    {
      authType: input.authType,
      body: {
        new_name: payload.name,
        color: payload.color,
        description: payload.description,
      },
    }
  );
  return result.parsed || {};
}

async function syncGitlabProjectLabels(input = {}) {
  const definitions = input.definitions || labelsForScope('all');
  const results = [];
  for (const definition of definitions) {
    const existing = await getGitlabProjectLabel(input, definition.name);
    if (!existing) {
      await createGitlabProjectLabel(input, definition);
      results.push({ name: definition.name, action: 'created' });
      continue;
    }
    if (!labelMatchesDefinition('gitlab', existing, definition)) {
      await updateGitlabProjectLabel(input, definition);
      results.push({ name: definition.name, action: 'updated' });
      continue;
    }
    results.push({ name: definition.name, action: 'skipped' });
  }
  return results;
}

async function getGitlabRepositoryFile(input = {}) {
  const params = new URLSearchParams({
    ref: input.ref || input.branch || 'main',
  });
  try {
    const result = await fetchJson(
      'GET',
      input.apiUrl,
      `${projectFileApiPath(input.projectIdOrPath, input.filePath)}?${params}`,
      input.token,
      { authType: input.authType }
    );
    return result.parsed || {};
  } catch (error) {
    if (error && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function createGitlabRepositoryCommit(input = {}) {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/repository/commits`,
    input.token,
    {
      authType: input.authType,
      body: {
        branch: input.branch,
        commit_message: input.commitMessage,
        actions: input.actions || [],
      },
    }
  );
  return result.parsed || {};
}

async function validateGitlabToken(input = {}) {
  const token = input.token || '';
  if (!token) {
    return {
      status: 'missing',
      lastValidatedAt: nowIso(),
      errorCode: 'MISSING_TOKEN',
    };
  }

  try {
    const user = await fetchJson('GET', input.apiUrl, '/user', token, { authType: input.authType || 'private-token' });
    const project = await fetchJson('GET', input.apiUrl, projectApiPath(input.projectPath), token, {
      authType: input.authType || 'private-token',
    });
    return {
      status: 'valid',
      username: user.parsed && (user.parsed.username || user.parsed.name) || '',
      scopes: parseScopes(user.headers),
      projectId: project.parsed && project.parsed.id !== undefined ? String(project.parsed.id) : '',
      defaultBranch: project.parsed && project.parsed.default_branch || '',
      lastValidatedAt: nowIso(),
      errorCode: '',
    };
  } catch (error) {
    return {
      status: 'invalid',
      username: '',
      scopes: [],
      projectId: '',
      defaultBranch: '',
      lastValidatedAt: nowIso(),
      errorCode: error && error.status ? `HTTP_${error.status}` : 'VALIDATION_FAILED',
    };
  }
}

export {
  createGitlabRepositoryCommit,
  createGitlabMergeRequest,
  getGitlabMergeRequest,
  configureGitlabProjectVariables,
  exchangeGitlabOAuthCode,
  getGitlabRunner,
  refreshGitlabOAuthToken,
  addGitlabProjectMember,
  getGitlabCurrentUser,
  getGitlabProjectMember,
  getGitlabProjectForInstall,
  getGitlabProjectVariable,
  getGitlabVariableForInstall,
  getGitlabRepositoryFile,
  gitlabOAuthAuthorizeUrl,
  gitlabOAuthRedirectUri,
  installGitlabWebhook,
  listGitlabIssues,
  enableGitlabRunnerForProject,
  listGitlabRunners,
  listGitlabProjectRunners,
  listGitlabWebhooks,
  listGitlabProjects,
  projectApiPath,
  syncGitlabProjectLabels,
  updateGitlabProjectMember,
  updateGitlabProjectRunnerSettings,
  upsertGitlabProjectMember,
  upsertGitlabProjectVariable,
  upsertGitlabWebhook,
  validateGitlabToken,
}
