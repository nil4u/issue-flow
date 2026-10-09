// @ts-nocheck
import { listGitlabWebhooks, upsertGitlabWebhook } from '../../gitlab.js'
import { repoWithWebhook } from '../../common.js'
import { sanitizeError } from '../../sanitize.js'
import { resolveGitlabProjectAccess, gitlabInstallContext } from './context.js'
import { installStep, statusFromBoolean } from '../steps.js'



function webhookCache(hook) {
  if (!hook) return undefined;
  return {
    key: 'issue-flow',
    source: 'gitlab',
    hookId: hook.id !== undefined ? String(hook.id) : '',
    url: hook.url || '',
    pushEvents: Boolean(hook.push_events || hook.pushEvents),
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

async function setGitlabProjectInstallWebhook({ store, basePublicUrl, input = {}, session, env = process.env, logger = undefined }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env, logger });
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

async function checkWebhook({ store, basePublicUrl, env, config, project, existing, installConfig, apiInput }) {
  let webhookStep;
  if (existing) {
    const publicRepo = repoWithWebhook(basePublicUrl, existing);
    const hooks = await listGitlabWebhooks(apiInput);
    const hook = hooks.find((item) => item && item.url === publicRepo.webhookUrl);
    const hookState = statusFromBoolean(
      Boolean(hook && (hook.push_events || hook.pushEvents)),
      hook ? 'Webhook 需要启用 Push events' : '需要通过 API 配置 GitLab webhook',
      'Webhook 已配置'
    );
    const hookDetail = hookState.status === 'passed' && hook ? hook.url : hookState.detail;
    webhookStep = installStep('webhook', 'api', 'GitLab webhook', hookState.status, hookDetail);
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
  return webhookStep;

}

export { checkWebhook, setGitlabProjectInstallWebhook }
