// @ts-nocheck
import { publicIssueFlowBaseUrl } from '../config.js'
import { createGitlabProjectAccessToken, getGitlabVariableForInstall, publicGitlabVariable, getGitlabVariableForValidation, upsertGitlabProjectVariable, validateGitlabProjectApiToken } from '../../gitlab.js'
import { validateAgentrixApiKey } from '../../agentrix-api.js'
import { sanitizeError } from '../../sanitize.js'
import { resolveGitlabProjectAccess, gitlabInstallContext } from './context.js'
import { installStep } from '../steps.js'

const ISSUE_FLOW_GITLAB_TOKEN_KEY = 'ISSUE_FLOW_GITLAB_TOKEN'
const ISSUE_FLOW_AUTO_DEFAULT_VALUES = new Set(['off', 'triage', 'plan', 'build'])

function automationDefaultValue(value) {
  const normalized = String(value || '').trim()
  return ISSUE_FLOW_AUTO_DEFAULT_VALUES.has(normalized) ? normalized : 'triage'
}

function booleanVariableValue(value) {
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) ? 'true' : 'false'
  }
  return value ? 'true' : 'false'
}

function gitlabCiVariablesForInstall({ config, installConfig, basePublicUrl = '', env = process.env }) {
  const automation = installConfig.automation || {};
  const agentrix = installConfig.agentrix || {};
  const runnerId = agentrix.runnerId || automation.runnerId || '';
  const issueFlowBaseUrl = publicIssueFlowBaseUrl(basePublicUrl, env);
  return [
    {
      key: ISSUE_FLOW_GITLAB_TOKEN_KEY,
      required: true,
      masked: true,
      autoCreate: true,
      label: ISSUE_FLOW_GITLAB_TOKEN_KEY,
      description: 'issue-flow GitLab CI jobs 调用 GitLab API 的项目访问 token。',
    },
    { key: 'ISSUE_FLOW_BASE_URL', value: issueFlowBaseUrl, required: true },
    { key: 'AGENTRIX_BASE_URL', value: agentrix.baseUrl, required: true },
    { key: 'AGENTRIX_API_KEY', value: agentrix.apiKey, masked: true, required: true },
    { key: 'AGENTRIX_RUNNER_ID', value: runnerId, required: true },
    { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: automation.agent || 'codex', required: true },
    { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: automationDefaultValue(automation.autoDefault), required: true },
    { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: booleanVariableValue(automation.reviewEnabled), required: true },
    { key: 'ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST', required: false, emptyDetail: '未设置，不屏蔽评论作者' },
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

function variableAutoWritable(variable) {
  return Boolean(variable.autoCreate) || variable.value !== undefined && variable.value !== '';
}

function variableFailureDetail(error) {
  const safe = sanitizeError(error);
  return `自动写入失败：${safe.code}${safe.message ? ` ${safe.message}` : ''}`;
}

function variableCheckState(variable, existingVariable) {
  const exists = Boolean(existingVariable);
  const required = variable.required !== false;
  const autoWritable = variableAutoWritable(variable);
  const manualRequired = required && !exists && !autoWritable;
  if (exists) {
    return { status: 'passed', detail: '已设置', autoWritable: false, manualRequired: false, blocker: false };
  }
  if (!required && !autoWritable) {
    return { status: 'passed', detail: variable.emptyDetail || '未设置，使用默认值', autoWritable: false, manualRequired: false, blocker: false };
  }
  if (manualRequired) {
    return {
      status: 'manual_required',
      detail: `需要填写 ${variable.key} 后写入 GitLab`,
      autoWritable: false,
      manualRequired: true,
      blocker: true,
    };
  }
  return { status: 'pending_auto', detail: '待自动写入', autoWritable: true, manualRequired: false, blocker: false };
}

function variableResult(variable, existingVariable) {
  const state = variableCheckState(variable, existingVariable);
  const required = variable.required !== false;
  const cache = variableCache(existingVariable);
  return {
    key: variable.key,
    label: variable.label || variable.key,
    description: variable.description || '',
    value: cache && cache.value || '',
    exists: Boolean(existingVariable),
    required,
    writable: state.autoWritable,
    autoWritable: state.autoWritable,
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
    needsInput: state.manualRequired,
    manualRequired: state.manualRequired,
    blocker: state.blocker,
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

function variableResultWithValidation(variable, existingVariable, validation) {
  const result = variableResult(variable, existingVariable);
  if (variable.key !== ISSUE_FLOW_GITLAB_TOKEN_KEY || !existingVariable) return result;
  if (!validation || validation.status === 'valid') {
    return {
      ...result,
      status: 'passed',
      detail: '已验证 GitLab API 权限',
      validation: validation || undefined,
    };
  }
  return {
    ...result,
    status: 'pending_auto',
    detail: 'token 无效或权限不足，待自动重新创建',
    writable: true,
    autoWritable: true,
    needsInput: false,
    manualRequired: false,
    blocker: false,
    validation,
  };
}

function variableStepFromResults(variableResults = []) {
  const pendingVariables = variableResults
    .filter((item) => item.status === 'pending_auto')
    .map((item) => item.key);
  const inputRequiredVariables = variableResults
    .filter((item) => item.status === 'manual_required' || item.manualRequired)
    .map((item) => item.key);
  const failedVariables = variableResults
    .filter((item) => item.status === 'failed')
    .map((item) => item.key);
  const unverifiedVariables = variableResults
    .filter((item) => item.status === 'unverified')
    .map((item) => item.key);
  const blockerVariables = variableResults
    .filter((item) => item.blocker)
    .map((item) => item.key);
  const outcome = [
    { keys: failedVariables, status: 'failed', detail: `${failedVariables.join(', ')} 自动写入失败` },
    { keys: inputRequiredVariables, status: 'needs_input', detail: `缺少 ${inputRequiredVariables.join(', ')}，需要补充后才能写入` },
    { keys: pendingVariables, status: 'needs_action', detail: `${pendingVariables.length} 个变量待自动写入` },
    { keys: unverifiedVariables, status: 'warning', detail: `无权验证 group 变量：${unverifiedVariables.join(', ')}` },
  ].find((item) => item.keys.length);
  const status = outcome && outcome.status || (variableResults.length ? 'passed' : 'unknown');
  const detail = outcome && outcome.detail || (status === 'unknown' ? '变量未检查' : '变量已设置');
  return installStep(
    'variables',
    'api',
    'CI/CD variables',
    status,
    detail,
    {
      missing: pendingVariables,
      inputRequired: inputRequiredVariables,
      blockers: blockerVariables,
      variables: variableResults,
    }
  );
}

async function validateIssueFlowGitlabTokenVariable(apiInput) {
  const variable = await getGitlabVariableForValidation(apiInput, ISSUE_FLOW_GITLAB_TOKEN_KEY);
  if (!variable) return { variable: undefined, validation: undefined };
  const validation = await validateGitlabProjectApiToken({
    apiUrl: apiInput.apiUrl,
    projectIdOrPath: apiInput.projectIdOrPath,
    token: variable.secretValue,
    authType: 'private-token',
    logger: apiInput.logger,
  });
  return {
    variable,
    validation,
  };
}

function failedVariableResult(variable, existingVariable, error) {
  const result = variableResult(variable, existingVariable);
  return {
    ...result,
    status: 'failed',
    detail: variableFailureDetail(error),
    needsInput: false,
    manualRequired: false,
    blocker: true,
  };
}

function unverifiedVariableResult(variable, error) {
  const groupPath = String(error && error.groupPath || '上级 group');
  const result = variableResult(variable, undefined);
  const detail = result.manualRequired
    ? `当前账号无权读取 ${groupPath} 的 CI/CD 变量（需要 group Owner 权限），也无法确认是否已继承 ${variable.key}；如需写入当前 Project，请先填写变量值`
    : `当前账号无权读取 ${groupPath} 的 CI/CD 变量（需要 group Owner 权限），无法验证是否已设置 ${variable.key}`;
  return {
    ...result,
    status: result.manualRequired ? 'manual_required' : 'unverified',
    detail,
    source: 'group',
    groupPath,
    unverified: true,
    groupAccessForbidden: true,
  };
}

function unverifiedVariableCache(result) {
  return {
    key: result.key,
    value: '',
    exists: false,
    source: result.source,
    groupPath: result.groupPath,
    environmentScope: '*',
    variableType: 'env_var',
    status: result.status,
    detail: result.detail,
    blocker: Boolean(result.blocker),
    unverified: true,
    groupAccessForbidden: true,
  };
}

async function readInstallVariable(apiInput, variable) {
  if (variable.key === ISSUE_FLOW_GITLAB_TOKEN_KEY) {
    let checked;
    try {
      checked = await validateIssueFlowGitlabTokenVariable(apiInput);
    } catch (error) {
      if (error && error.code === 'gitlab_group_variable_forbidden') {
        return {
          existingVariable: undefined,
          validation: undefined,
        };
      }
      throw error;
    }
    return {
      existingVariable: checked.variable,
      validation: checked.validation,
    };
  }
  return {
    existingVariable: await getGitlabVariableForInstall(apiInput, variable.key),
    validation: undefined,
  };
}

async function readInstallVariableResults(apiInput, variables = [], failedByKey = new Map()) {
  const variableResults = [];
  const variableCaches = [];
  for (const variable of variables) {
    let existingVariable;
    let validation;
    try {
      const checked = await readInstallVariable(apiInput, variable);
      existingVariable = checked.existingVariable;
      validation = checked.validation;
    } catch (error) {
      if (error && error.code === 'gitlab_group_variable_forbidden') {
        const result = unverifiedVariableResult(variable, error);
        variableResults.push(result);
        variableCaches.push(unverifiedVariableCache(result));
        continue;
      }
      variableResults.push(failedVariableResult(variable, undefined, error));
      continue;
    }
    const cache = variableCache(existingVariable);
    if (cache) variableCaches.push(cache);
    const result = failedByKey.has(variable.key)
      ? failedVariableResult(variable, existingVariable, failedByKey.get(variable.key))
      : variableResultWithValidation(variable, existingVariable, validation);
    variableResults.push(result);
  }
  return { variableResults, variableCaches };
}

function issueFlowGitlabTokenName(project = {}) {
  const suffix = String(project.id || project.pathWithNamespace || Date.now()).replace(/[^A-Za-z0-9._-]+/g, '-');
  return `issue-flow-${suffix}-${Date.now()}`;
}

async function createIssueFlowGitlabTokenVariable({ config, project, apiInput }) {
  if (!config.adminPat) {
    const error = new Error('Git server admin PAT is required to create ISSUE_FLOW_GITLAB_TOKEN');
    error.status = 400;
    throw error;
  }
  const token = await createGitlabProjectAccessToken({
    apiUrl: config.apiUrl,
    token: config.adminPat,
    authType: 'private-token',
    projectIdOrPath: apiInput.projectIdOrPath,
    logger: apiInput.logger,
    name: issueFlowGitlabTokenName(project),
    scopes: ['api'],
    accessLevel: 40,
    expiresInDays: 365,
  });
  const value = String(token.token || '');
  if (!value) {
    const error = new Error('GitLab did not return a project access token value');
    error.status = 502;
    throw error;
  }
  await upsertGitlabProjectVariable(apiInput, {
    key: ISSUE_FLOW_GITLAB_TOKEN_KEY,
    value,
    masked: true,
    protected: false,
    raw: true,
  });
  return token;
}

async function writeInstallVariable({ definition, input = {}, key = '', config, project, apiInput, env = process.env }) {
  const nextValue = input.value !== undefined && key ? input.value : definition.value;
  if (definition.key === ISSUE_FLOW_GITLAB_TOKEN_KEY && (nextValue === undefined || nextValue === '')) {
    let checked = { variable: undefined, validation: undefined };
    try {
      checked = await validateIssueFlowGitlabTokenVariable(apiInput);
    } catch (error) {
      if (!error || error.code !== 'gitlab_group_variable_forbidden') {
        throw error;
      }
    }
    if (checked.variable && checked.validation && checked.validation.status === 'valid') return;
    await createIssueFlowGitlabTokenVariable({ config, project, apiInput });
    return;
  }
  if (nextValue === undefined || (nextValue === '' && definition.required !== false)) {
    const error = new Error('gitlab_variable_value_required');
    error.status = 400;
    error.code = 'gitlab_variable_value_required';
    throw error;
  }
  if (definition.key === 'AGENTRIX_API_KEY') {
    await validateAgentrixApiKey({ env, apiKey: String(nextValue), logger: apiInput.logger });
  }
  const written = await upsertGitlabProjectVariable(apiInput, {
    ...definition,
    value: String(nextValue),
    environmentScope: input.environmentScope || input.scope || definition.environmentScope || '*',
  });
  return publicGitlabVariable({ key: definition.key, value: String(nextValue), masked: definition.masked, ...written }, 'project');
}

// 指定 key 的单变量写入:直接写 GitLab,用写入响应更新该 key 的 cache,其余 key 沿用已有 cache,不再全量重读。

async function setSingleInstallVariable({ store, existing, definitions, definition, input, config, project, apiInput, env }) {
  const cachedItems = existing.settings && existing.settings.variables && existing.settings.variables.items || [];
  const cachedByKey = new Map(cachedItems.map((item) => [item.key, item]));
  const key = definition.key;
  let written;
  let validation;
  let writeError;
  try {
    written = await writeInstallVariable({ definition, input, key, config, project, apiInput, env });
  } catch (error) {
    if (error && error.code === 'gitlab_variable_value_required') {
      return { status: 400, body: { error: 'gitlab_variable_value_required' } };
    }
    writeError = error;
  }
  if (!writeError && !written) {
    // token 变量由 writeInstallVariable 内部创建,需要回读一次并验证权限。
    const checked = await readInstallVariable(apiInput, definition);
    written = checked.existingVariable;
    validation = checked.validation;
  }
  const result = writeError
    ? failedVariableResult(definition, cachedByKey.get(key), writeError)
    : variableResultWithValidation(definition, written, validation);
  const nextCache = variableCache(writeError ? cachedByKey.get(key) : written);
  const items = cachedItems.filter((item) => item.key !== key);
  if (nextCache) items.push(nextCache);
  const repository = await store.updateRepositorySettingsCache(existing.id, {
    variables: { items, checkedAt: new Date().toISOString() },
  });
  const variableResults = definitions.map((item) => item.key === key ? result : variableResult(item, cachedByKey.get(item.key)));
  const step = variableStepFromResults(variableResults);
  return {
    status: 200,
    body: {
      repository,
      step,
      variable: result,
      steps: [step],
      installable: step.status !== 'blocked' && step.status !== 'needs_input' && step.status !== 'failed',
    },
  };
}

async function setGitlabProjectInstallVariable({ store, basePublicUrl, input = {}, session, env = process.env, logger = undefined }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env, logger });
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
  const definitions = gitlabCiVariablesForInstall({ config, installConfig, basePublicUrl, env });
  if (key) {
    const definition = definitions.find((item) => item.key === key);
    if (!definition) return { status: 400, body: { error: 'gitlab_variable_unknown' } };
    return setSingleInstallVariable({ store, existing, definitions, definition, input, config, project, apiInput, env });
  }
  const initial = await readInstallVariableResults(apiInput, definitions);
  const initialByKey = new Map(initial.variableResults.map((item) => [item.key, item]));
  const selectedDefinitions = definitions.filter((item) => {
    const current = initialByKey.get(item.key);
    if (!current) return false;
    return current.status === 'pending_auto'
      || current.status === 'unverified' && Boolean(current.autoWritable ?? current.writable);
  });
  if (!selectedDefinitions.length) {
    const variables = { items: initial.variableCaches, checkedAt: new Date().toISOString() };
    const repository = await store.updateRepositorySettingsCache(existing.id, { variables });
    const step = variableStepFromResults(initial.variableResults);
    return {
      status: 200,
      body: {
        repository,
        step,
        steps: [step],
        installable: step.status !== 'blocked' && step.status !== 'needs_input' && step.status !== 'failed',
      },
    };
  }
  const failedByKey = new Map();
  for (const definition of selectedDefinitions) {
    try {
      await writeInstallVariable({ definition, input, key, config, project, apiInput, env });
    } catch (error) {
      failedByKey.set(definition.key, error);
    }
  }
  const final = await readInstallVariableResults(apiInput, definitions, failedByKey);
  const variables = { items: final.variableCaches, checkedAt: new Date().toISOString() };
  const repository = await store.updateRepositorySettingsCache(existing.id, { variables });
  const step = variableStepFromResults(final.variableResults);
  return {
    status: 200,
    body: {
      repository,
      step,
      variable: undefined,
      steps: [step],
      installable: step.status !== 'blocked' && step.status !== 'needs_input' && step.status !== 'failed',
    },
  };
}

async function checkVariables({ store, basePublicUrl, env, config, project, existing, installConfig, apiInput }) {
  const variables = gitlabCiVariablesForInstall({ config, installConfig, basePublicUrl, env });
  const { variableResults, variableCaches } = await readInstallVariableResults(apiInput, variables);

  if (existing) {
    await store.updateRepositorySettingsCache(existing.id, {
      variables: {
        items: variableCaches,
        checkedAt: new Date().toISOString(),
      },
    });
  }

  return variableStepFromResults(variableResults);

}

export { checkVariables, setGitlabProjectInstallVariable }
