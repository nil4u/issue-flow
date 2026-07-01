// @ts-nocheck
import {
  composeVariables,
  defaultVariables,
  deliveryTarget,
  GitLabWebhookBridge,
  gitlabPipelineTarget,
  staticVariables,
} from '@xmz-ai/gitlab-webhook-bridge'
import { requireRepo, resolveGitServer } from './common.js'
import { applyGitEventToIssueFacts } from './issue-projection.js'
import { compactNulls, sanitize } from './sanitize.js'
import { sanitizeError } from './sanitize.js'

function webhookUrl(basePublicUrl, repoId) {
  return `${String(basePublicUrl || '').replace(/\/+$/, '')}/webhooks/gitlab/${encodeURIComponent(repoId)}`;
}

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
    const gitEvent = await store.createGitEvent({
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
    });
    await applyGitEventToIssueFacts(store, gitEvent);
    return {
      target: 'issue-flow-git-event-log',
      eventId: input.deliveryId,
      status: 'ignored',
      reason: 'git_event_stored',
    };
  });
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
      gitlabPipelineTarget({
        variables: composeVariables([
          defaultVariables(),
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
