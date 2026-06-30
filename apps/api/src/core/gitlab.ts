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

function gitlabOAuthRedirectUri(config, basePublicUrl) {
  return config.oauthRedirectUri || `${String(basePublicUrl || '').replace(/\/+$/, '')}/api/auth/gitlab/callback`;
}

function gitlabOAuthAuthorizeUrl({ config, state, basePublicUrl }) {
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

async function exchangeGitlabOAuthCode({ config, code, basePublicUrl }) {
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
      username: user.parsed && (user.parsed.username || user.parsed.name) || '',
      name: user.parsed && user.parsed.name || '',
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

async function upsertGitlabProjectVariable(input = {}, variable = {}) {
  const key = variable.key;
  const body = {
    key,
    value: variable.value,
    variable_type: variable.variableType || 'env_var',
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
  configureGitlabProjectVariables,
  exchangeGitlabOAuthCode,
  refreshGitlabOAuthToken,
  getGitlabCurrentUser,
  getGitlabProjectForInstall,
  getGitlabProjectVariable,
  getGitlabRepositoryFile,
  gitlabOAuthAuthorizeUrl,
  gitlabOAuthRedirectUri,
  installGitlabWebhook,
  listGitlabWebhooks,
  listGitlabProjects,
  projectApiPath,
  syncGitlabProjectLabels,
  upsertGitlabWebhook,
  validateGitlabToken,
}
