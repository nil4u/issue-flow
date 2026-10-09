// @ts-nocheck
import {
  composeVariables,
  defaultVariables,
  deliveryTarget,
  GitLabWebhookBridge,
  gitlabPipelineTarget,
  staticVariables,
} from '@xmz-ai/gitlab-webhook-bridge'
import { gitlabWebhookUrl as webhookUrl } from './events/urls.js'
import { requireRepo, resolveGitServer } from './common.js'
import { recordGitEvent, applyRepositoryChange } from './events/consume.js'
import { gitlabEventFacts, gitlabPluginChange, optimizationIssueLifecycleFromGitlabPayload } from './events/gitlab.js'
import { applyOptimizationIssueLifecycle } from './optimization-lifecycle.js'
import { compactNulls, sanitize } from './sanitize.js'
import { sanitizeError } from './sanitize.js'

function createWebhookBridgeStore(store, repoId) {
  return {
    async get(key) {
      return store.getWebhookBridgeState(repoId, key);
    },
    async set(key, value, options) {
      await store.setWebhookBridgeState(repoId, key, value, options);
    },
    async delete(key) {
      await store.deleteWebhookBridgeState(repoId, key);
    },
  };
}

function normalizedEventFact(event = {}) {
  const { raw, ...fact } = event;
  return sanitize(fact);
}

function eventObjectType(event = {}) {
  if (event.eventName === 'issue_comment' || event.eventName === 'pull_request_review_comment') return 'comment';
  return event.subjectKind || '';
}

function eventObjectId(event = {}) {
  if (event.comment && event.comment.id !== undefined) return String(event.comment.id);
  if (event.issue && event.issue.id !== undefined) return String(event.issue.id);
  if (event.pullRequest && event.pullRequest.id !== undefined) return String(event.pullRequest.id);
  if (event.workflowRun && event.workflowRun.id !== undefined) return String(event.workflowRun.id);
  if (event.workflowRun && event.workflowRun.iid !== undefined) return String(event.workflowRun.iid);
  return '';
}

function createGitEventTarget(store, repo) {
  return deliveryTarget('issue-flow-git-event-log', async (input) => {
    const event = input.events[0] || {};
    const raw = event.raw || {};
    const record = {
      repoId: repo.id,
      gitServerId: repo.gitServerId,
      repositoryId: event.project && event.project.id !== undefined ? String(event.project.id) : repo.projectId || '',
      repositoryFullName: event.project && event.project.pathWithNamespace || repo.projectPath || '',
      deliveryId: input.deliveryId,
      eventName: input.providerEventName,
      action: event.eventAction || event.providerEventAction || '',
      objectType: eventObjectType(event),
      objectId: eventObjectId(event),
      payload: sanitize(compactNulls(raw.body || {})),
      normalizedEvents: input.events.map(normalizedEventFact),
    };
    await recordGitEvent(store, record, gitlabEventFacts);
    return {
      target: 'issue-flow-git-event-log',
      eventId: input.deliveryId,
      status: 'ignored',
      reason: 'git_event_stored',
    };
  });
}

function createIssueFlowBusinessTarget(store, repo) {
  return deliveryTarget('issue-flow-business', async (input) => {
    const changes = (input.events || []).map((event) => gitlabPluginChange(event.raw?.body || {}));
    const handled = (await Promise.all(changes.map((change) => applyRepositoryChange({ store, repo, change })))).flat();
    return {
      target: 'issue-flow-business',
      eventId: input.deliveryId,
      status: handled.length ? 'delivered' : 'ignored',
      reason: handled.length ? 'issue_flow_business_handled' : 'no_issue_flow_business_handler',
      handled,
    };
  }, { onError: 'ignore' });
}

function createOptimizationLifecycleTarget(repo, secrets) {
  return deliveryTarget('optimization-lifecycle', async (input) => {
    const handled = []
    for (const event of input.events || []) {
      const payload = event && event.raw && event.raw.body || {}
      const lifecycle = optimizationIssueLifecycleFromGitlabPayload(payload)
      if (!lifecycle) continue
      const result = await applyOptimizationIssueLifecycle({
        server: {
          type: 'gitlab',
          baseUrl: repo.baseUrl,
          apiUrl: repo.apiUrl,
          adminPat: secrets.providerToken,
          tokenAuth: secrets.providerAuthType,
        },
        repo: { ...repo, serverRepoId: repo.serverRepoId || repo.projectId },
        lifecycle,
      })
      if (result) handled.push(result)
    }
    return {
      target: 'optimization-lifecycle',
      eventId: input.deliveryId,
      status: handled.length ? 'delivered' : 'ignored',
      reason: handled.length ? 'optimization_lifecycle_handled' : 'not_optimization_issue_event',
      handled,
    }
  })
}

function createGitLabWebhookBridge({ store, repo, secrets }) {
  return new GitLabWebhookBridge({
    gitlab: {
      baseUrl: repo.baseUrl,
      apiUrl: repo.apiUrl,
      token: secrets.providerToken,
      webhookSecret: secrets.webhookSecret,
    },
    store: createWebhookBridgeStore(store, repo.id),
    targets: [
      createGitEventTarget(store, repo),
      createOptimizationLifecycleTarget(repo, secrets),
      createIssueFlowBusinessTarget(store, repo),
      gitlabPipelineTarget({
        variables: composeVariables([
          defaultVariables(),
          (event) => event.comment ? {
            GITLAB_BRIDGE_COMMENT_AUTHOR: event.raw.body?.user?.username || event.raw.body?.user?.name || '',
          } : {},
          staticVariables({
            AGENTRIX_GIT_SERVER_ID: secrets.agentrixGitServerId,
          }),
        ]),
      }),
    ],
  });
}

async function handleGitlabWebhook({ store, repoId, headers = {}, rawBody = '' }) {
  const repo = await requireRepo(store, repoId);
  let config;
  try {
    ({ config } = await resolveGitServer(store, { gitServerId: repo.gitServerId }, undefined, 'gitlab'));
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'git_server_resolve_failed',
        detail: sanitizeError(error),
      },
    };
  }
  if (!config.webhookSecret) {
    return { status: 400, body: { error: 'git_server_webhook_secret_required' } };
  }
  if (!config.adminPat) {
    return { status: 403, body: { error: 'git_server_admin_pat_required' } };
  }
  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }

  const input = {
    headers,
    body: payload,
  };
  const secrets = {
    providerToken: config.adminPat,
    providerAuthType: config.tokenAuth || 'private-token',
    webhookSecret: config.webhookSecret,
    agentrixGitServerId: config.agentrixGitServerId,
  };
  const bridge = createGitLabWebhookBridge({ store, repo, secrets });
  if (!repo.baseUrl || !repo.apiUrl) {
    return { status: 400, body: { error: 'git_server_incomplete' } };
  }

  let result;
  try {
    result = await bridge.handle(input);
  } catch (error) {
    const status = error && (error.statusCode || error.status) || 500;
    return {
      status: Number(status) >= 400 && Number(status) < 600 ? Number(status) : 500,
      body: {
        error: error && error.code || 'gitlab_webhook_failed',
        detail: sanitizeError(error),
      },
    };
  }

  return {
    status: 200,
    body: result,
  };
}

export {
  createGitEventTarget,
  createGitLabWebhookBridge,
  handleGitlabWebhook,
  webhookUrl,
}
