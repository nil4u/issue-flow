// @ts-nocheck
import {
  composeVariables,
  defaultVariables,
  GitLabWebhookBridge,
  gitlabPipelineTarget,
  staticVariables,
} from '@xmz-ai/gitlab-webhook-bridge'
import { requireRepo, resolveGitServer } from './common.js'
import { summarizeGitlabPayload } from './sanitize.js'
import { sanitizeError } from './sanitize.js'

function headerValue(headers = {}, name) {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return '';
}

function webhookUrl(basePublicUrl, repoId) {
  return `${String(basePublicUrl || '').replace(/\/+$/, '')}/webhooks/gitlab/${encodeURIComponent(repoId)}`;
}

function payloadSummary(payload) {
  return summarizeGitlabPayload(payload);
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

function bridgeEventSummary(event = {}) {
  return {
    providerEventName: event.providerEventName || '',
    providerEventAction: event.providerEventAction || '',
    eventName: event.eventName || '',
    eventAction: event.eventAction || '',
    compatKind: event.compatKind || '',
    subjectKind: event.subjectKind || '',
    project: event.project && event.project.pathWithNamespace || '',
    issue: event.issue && event.issue.number || '',
    pullRequest: event.pullRequest && event.pullRequest.number || '',
    workflowRun: event.workflowRun && (event.workflowRun.id || event.workflowRun.iid) || '',
  };
}

function createGitLabWebhookBridge({ store, repo, credentials }) {
  return new GitLabWebhookBridge({
    gitlab: {
      baseUrl: repo.baseUrl,
      apiUrl: repo.apiUrl,
      token: credentials.providerToken,
      webhookSecret: credentials.webhookSecret,
    },
    store: createWebhookBridgeStore(store, repo.id),
    targets: [
      gitlabPipelineTarget({
        variables: composeVariables([
          defaultVariables(),
          staticVariables({
            AGENTRIX_GIT_SERVER_ID: credentials.agentrixGitServerId || repo.gitServerId || '',
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
  const credentials = {
    providerToken: config.adminPat,
    webhookSecret: config.webhookSecret,
    agentrixGitServerId: config.agentrixGitServerId,
  };
  const bridge = createGitLabWebhookBridge({ store, repo, credentials });
  if (!repo.baseUrl || !repo.apiUrl) {
    return { status: 400, body: { error: 'git_server_incomplete' } };
  }

  let result;
  try {
    result = await bridge.handle(input);
  } catch (error) {
    const status = error && (error.statusCode || error.status) || 500;
    const deliveryId = (
      headerValue(headers, 'x-gitlab-webhook-uuid')
      || headerValue(headers, 'x-gitlab-event-uuid')
      || headerValue(headers, 'x-gitlab-delivery')
      || headerValue(headers, 'x-request-id')
      || ''
    );
    await store.createDelivery({
      repoId,
      deliveryKey: deliveryId || `error:${Date.now()}`,
      deliveryId,
      consumer: 'gitlab-webhook',
      event: headerValue(headers, 'x-gitlab-event') || '',
      routeAction: '',
      status: 'rejected',
      payloadSummary: payloadSummary(payload),
      error,
    });
    return {
      status: Number(status) >= 400 && Number(status) < 600 ? Number(status) : 500,
      body: {
        error: error && error.code || 'gitlab_webhook_failed',
        detail: sanitizeError(error),
      },
    };
  }

  const delivery = await store.createDelivery({
    repoId,
    deliveryKey: result.deliveryId,
    deliveryId: result.deliveryId,
    consumer: 'gitlab-webhook',
    event: result.providerEventName,
    routeAction: 'bridge',
    status: result.status,
    payloadSummary: payloadSummary(payload),
    resultSummary: {
      providerEventName: result.providerEventName,
      eventCount: result.events.length,
      deliveries: result.deliveries.map((delivery) => ({
        target: delivery.target,
        eventId: delivery.eventId,
        status: delivery.status,
        reason: delivery.reason || '',
      })),
    },
  });
  return {
    status: result.status === 'failed' ? 500 : 202,
    body: {
      status: result.status,
      deliveryId: delivery.id,
      providerDeliveryId: result.deliveryId,
      providerEventName: result.providerEventName,
      events: result.events.map(bridgeEventSummary),
      deliveries: result.deliveries,
    },
  };
}

export {
  bridgeEventSummary,
  createGitLabWebhookBridge,
  headerValue,
  handleGitlabWebhook,
  payloadSummary,
  webhookUrl,
}
