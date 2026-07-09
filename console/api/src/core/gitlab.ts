// @ts-nocheck
import { nowIso } from './store.js'
import {
  externalServiceCallStarted,
  logExternalServiceCall,
} from './external-service-log.js'

const DEFAULT_GITLAB_FETCH_TIMEOUT_MS = 30_000

function gitlabFetchTimeoutMs(options = {}) {
  const value = Number(options.timeoutMs || process.env.ISSUE_FLOW_GITLAB_FETCH_TIMEOUT_MS || DEFAULT_GITLAB_FETCH_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_GITLAB_FETCH_TIMEOUT_MS
}

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
  const url = `${apiUrl.replace(/\/+$/, '')}${path}`;
  const call = externalServiceCallStarted();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, gitlabFetchTimeoutMs(options));
  let response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...tokenHeaders(token, options.authType),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    const reportedError = timedOut
      ? Object.assign(new Error('GitLab API request timed out'), { code: 'GITLAB_FETCH_TIMEOUT' })
      : error;
    logExternalServiceCall({
      logger: options.logger,
      service: 'gitlab',
      method,
      url,
      call,
      error: reportedError,
    });
    throw reportedError;
  } finally {
    clearTimeout(timeoutId);
  }
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
    logExternalServiceCall({
      logger: options.logger,
      service: 'gitlab',
      method,
      url,
      call,
      status: response.status,
      error,
    });
    throw error;
  }
  logExternalServiceCall({
    logger: options.logger,
    service: 'gitlab',
    method,
    url,
    call,
    status: response.status,
  });
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
    logger: input.logger,
  });
  return {
    projects: Array.isArray(result.parsed) ? result.parsed.map(normalizeProject) : [],
    nextPage: result.headers && result.headers.get && result.headers.get('x-next-page') || '',
  };
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
      { authType: input.authType, logger: input.logger }
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

async function exchangeGitlabOAuthCode({ config, code, basePublicUrl, appUrl, logger }) {
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
  const url = new URL('/oauth/token', config.baseUrl);
  const call = externalServiceCallStarted();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (error) {
    logExternalServiceCall({
      logger,
      service: 'gitlab',
      method: 'POST',
      url,
      call,
      error,
    });
    throw error;
  }
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
    logExternalServiceCall({
      logger,
      service: 'gitlab',
      method: 'POST',
      url,
      call,
      status: response.status,
      error,
    });
    throw error;
  }
  logExternalServiceCall({
    logger,
    service: 'gitlab',
    method: 'POST',
    url,
    call,
    status: response.status,
  });
  return parsed || {};
}

async function refreshGitlabOAuthToken({ config, refreshToken, logger }) {
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
  const url = new URL('/oauth/token', config.baseUrl);
  const call = externalServiceCallStarted();
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
  } catch (error) {
    logExternalServiceCall({
      logger,
      service: 'gitlab',
      method: 'POST',
      url,
      call,
      error,
    });
    throw error;
  }
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
    logExternalServiceCall({
      logger,
      service: 'gitlab',
      method: 'POST',
      url,
      call,
      status: response.status,
      error,
    });
    throw error;
  }
  logExternalServiceCall({
    logger,
    service: 'gitlab',
    method: 'POST',
    url,
    call,
    status: response.status,
  });
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
    const user = await fetchJson('GET', input.apiUrl, '/user', token, {
      authType: input.authType,
      logger: input.logger,
    });
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
  const firstPage = await listGitlabProjectsPage(input);
  const projects = [...firstPage.projects];
  let nextPage = firstPage.nextPage;
  let pagesRead = 1;
  while (nextPage && pagesRead < Number(input.maxPages || 50)) {
    const page = await listGitlabProjectsPage(input, { page: String(nextPage) });
    projects.push(...page.projects);
    nextPage = page.nextPage;
    pagesRead += 1;
  }
  return Promise.all(projects.map(async (project) => {
    if (project.accessLevelKnown || !project.id) {
      return project;
    }
    try {
      const detailed = await getGitlabProjectForInstall({
        apiUrl: input.apiUrl,
        token: input.token,
        authType: input.authType,
        logger: input.logger,
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
    logger: input.logger,
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
      { authType: input.authType, logger: input.logger }
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
      logger: input.logger,
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
      logger: input.logger,
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
    { authType: input.authType, logger: input.logger, body }
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
    { authType: input.authType, logger: input.logger, body }
  );
  return result.parsed || {};
}

async function listGitlabWebhooks(input = {}) {
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/hooks`,
    input.token,
    { authType: input.authType, logger: input.logger }
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
      logger: input.logger,
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
      { authType: input.authType, logger: input.logger }
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
      { authType: input.authType, logger: input.logger }
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
      { authType: input.authType, logger: input.logger }
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

async function getGitlabVariableForValidation(input = {}, key = '') {
  const projectVariable = await getGitlabProjectVariable(input, key);
  if (projectVariable) {
    return {
      ...publicGitlabVariable(projectVariable, 'project'),
      secretValue: projectVariable.value !== undefined && projectVariable.value !== null ? String(projectVariable.value) : '',
    };
  }
  for (const groupPath of gitlabGroupPathsForProject(input.projectPath || '')) {
    const groupVariable = await getGitlabGroupVariable(input, groupPath, key);
    if (groupVariable) {
      return {
        ...publicGitlabVariable(groupVariable, 'group', groupPath),
        secretValue: groupVariable.value !== undefined && groupVariable.value !== null ? String(groupVariable.value) : '',
      };
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
      { authType: input.authType, logger: input.logger, body }
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
      { authType: input.authType, logger: input.logger, body }
    );
    return result.parsed || {};
  }
}

function dateDaysFromNow(days = 365) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + Number(days || 365));
  return date.toISOString().slice(0, 10);
}

async function createGitlabProjectAccessToken(input = {}) {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/access_tokens`,
    input.token,
    {
      authType: input.authType,
      logger: input.logger,
      body: {
        name: input.name || `issue-flow-${Date.now()}`,
        scopes: input.scopes || ['api'],
        access_level: Number(input.accessLevel || 40),
        expires_at: input.expiresAt || dateDaysFromNow(input.expiresInDays || 365),
      },
    }
  );
  return result.parsed || {};
}

async function createGitlabUserImpersonationToken(input = {}) {
  const userId = String(input.userId || '').trim();
  if (!userId) {
    const error = new Error('GitLab user id is required');
    error.status = 400;
    throw error;
  }
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `/users/${encodeURIComponent(userId)}/impersonation_tokens`,
    input.token,
    {
      authType: input.authType || 'private-token',
      logger: input.logger,
      body: {
        name: input.name || `issue-flow-runner-${Date.now()}`,
        scopes: input.scopes || ['api'],
        expires_at: input.expiresAt || dateDaysFromNow(input.expiresInDays || 365),
      },
    }
  );
  return result.parsed || {};
}

async function validateGitlabProjectApiToken(input = {}) {
  const token = input.token || '';
  const minimumAccessLevel = Number(input.minimumAccessLevel || 40);
  if (!token) {
    return {
      status: 'missing',
      lastValidatedAt: nowIso(),
      errorCode: 'MISSING_TOKEN',
      checks: [],
    };
  }
  const checks = [];
  async function check(id, label, method, path, body) {
    try {
      const result = await fetchJson(method, input.apiUrl, path, token, {
        authType: input.authType || 'private-token',
        logger: input.logger,
        body,
      });
      checks.push({ id, label, status: 'passed' });
      return result.parsed || true;
    } catch (error) {
      checks.push({
        id,
        label,
        status: 'blocked',
        detail: error && error.status ? `HTTP ${error.status}` : error && error.message || 'failed',
      });
      return undefined;
    }
  }

  const user = await check('user-read', '识别 token 用户', 'GET', '/user');
  await check('project-read', '读取项目', 'GET', projectApiPath(input.projectIdOrPath));
  if (user && user.id !== undefined && user.id !== null) {
    const member = await check(
      'project-maintainer',
      '确认项目 Maintainer 权限',
      'GET',
      `${projectApiPath(input.projectIdOrPath)}/members/all/${encodeURIComponent(user.id)}`
    );
    const accessLevel = Number(member && (member.access_level || member.accessLevel) || 0);
    const maintainerCheck = checks.find((item) => item.id === 'project-maintainer');
    if (maintainerCheck && maintainerCheck.status === 'passed' && accessLevel < minimumAccessLevel) {
      maintainerCheck.status = 'blocked';
      maintainerCheck.detail = `access_level ${accessLevel} < ${minimumAccessLevel}`;
    }
  } else {
    checks.push({
      id: 'project-maintainer',
      label: '确认项目 Maintainer 权限',
      status: 'blocked',
      detail: '无法识别 token 用户',
    });
  }
  await check('issue-read', '读取 issues', 'GET', `${projectApiPath(input.projectIdOrPath)}/issues?per_page=1`);
  await check('merge-request-read', '读取 merge requests', 'GET', `${projectApiPath(input.projectIdOrPath)}/merge_requests?per_page=1`);
  await check('label-read', '读取 labels', 'GET', `${projectApiPath(input.projectIdOrPath)}/labels?per_page=1`);
  await check('variable-read', '读取 CI/CD variables', 'GET', `${projectApiPath(input.projectIdOrPath)}/variables?per_page=1`);

  const passed = checks.every((item) => item.status === 'passed');
  return {
    status: passed ? 'valid' : 'invalid',
    lastValidatedAt: nowIso(),
    errorCode: passed ? '' : 'PERMISSION_CHECK_FAILED',
    checks,
  };
}

function normalizeGitlabRunner(runner = {}) {
  return {
    id: runner.id !== undefined ? String(runner.id) : '',
    description: runner.description || '',
    active: runner.active !== false,
    locked: Boolean(runner.locked),
    paused: Boolean(runner.paused),
    status: runner.status || '',
    shortToken: runner.short_sha || runner.shortSha || runner.short_token || runner.shortToken || runner.token_short || runner.tokenShort || '',
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
    { authType: input.authType, logger: input.logger }
  );
  return Array.isArray(result.parsed) ? result.parsed.map(normalizeGitlabRunner) : [];
}

async function getGitlabRunner(input = {}, runnerId = '') {
  const result = await fetchJson(
    'GET',
    input.apiUrl,
    `/runners/${encodeURIComponent(runnerId)}`,
    input.token,
    { authType: input.authType, logger: input.logger }
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
    { authType: input.authType, logger: input.logger }
  );
  return Array.isArray(result.parsed) ? result.parsed.map(normalizeGitlabRunner) : [];
}

async function enableGitlabRunnerForProject(input = {}, runnerId = '') {
  const result = await fetchJson(
    'POST',
    input.apiUrl,
    `${projectApiPath(input.projectIdOrPath)}/runners`,
    input.token,
    { authType: input.authType, logger: input.logger, body: { runner_id: runnerId } }
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
    { authType: input.authType, logger: input.logger, body }
  );
  return normalizeProject(result.parsed || {});
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
      { authType: input.authType, logger: input.logger }
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
      logger: input.logger,
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
    const user = await fetchJson('GET', input.apiUrl, '/user', token, {
      authType: input.authType || 'private-token',
      logger: input.logger,
    });
    const project = await fetchJson('GET', input.apiUrl, projectApiPath(input.projectPath), token, {
      authType: input.authType || 'private-token',
      logger: input.logger,
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
  createGitlabProjectAccessToken,
  createGitlabUserImpersonationToken,
  createGitlabRepositoryCommit,
  createGitlabMergeRequest,
  getGitlabMergeRequest,
  exchangeGitlabOAuthCode,
  getGitlabRunner,
  refreshGitlabOAuthToken,
  addGitlabProjectMember,
  getGitlabCurrentUser,
  getGitlabProjectMember,
  getGitlabProjectForInstall,
  getGitlabProjectVariable,
  getGitlabVariableForInstall,
  getGitlabVariableForValidation,
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
  updateGitlabProjectMember,
  updateGitlabProjectRunnerSettings,
  upsertGitlabProjectMember,
  upsertGitlabProjectVariable,
  upsertGitlabWebhook,
  validateGitlabProjectApiToken,
  validateGitlabToken,
}
