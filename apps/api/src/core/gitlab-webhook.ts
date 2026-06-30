// @ts-nocheck
import {
  composeVariables,
  defaultVariables,
  GitLabWebhookBridge,
  gitlabPipelineTarget,
  staticVariables,
} from '@xmz-ai/gitlab-webhook-bridge'
import {
  refreshGitlabOAuthToken,
} from './gitlab.js'
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
            AGENTRIX_GIT_SERVER_ID: repo.gitServerId || '',
          }),
        ]),
      }),
    ],
  });
}

function sessionExpiresSoon(session = {}) {
  if (!session.expiresAt) {
    return false;
  }
  return new Date(session.expiresAt).getTime() <= Date.now() + 60_000;
}

async function resolveRepositoryGitlabCredentials({ store, repo, credentials }) {
  if (!repo.oauthSessionId) {
    const error = new Error('Repository is not linked to a GitLab OAuth session');
    error.status = 403;
    error.code = 'oauth_session_required';
    throw error;
  }
  const { config } = await resolveGitServer(store, { gitServerId: repo.gitServerId }, undefined, 'gitlab');
  let session = await store.getSession(repo.oauthSessionId, { allowExpired: true });
  if (!session) {
    const error = new Error('Repository GitLab OAuth session was not found');
    error.status = 403;
    error.code = 'oauth_session_not_found';
    throw error;
  }
  if (sessionExpiresSoon(session)) {
    const refreshed = await refreshGitlabOAuthToken({
      config,
      refreshToken: session.refreshToken,
    });
    const expiresAt = refreshed.expires_in
      ? new Date(Date.now() + (Number(refreshed.expires_in) * 1000)).toISOString()
      : '';
    session = await store.updateSessionTokens(session.id, {
      token: refreshed.access_token || '',
      refreshToken: refreshed.refresh_token || session.refreshToken || '',
      scopes: String(refreshed.scope || (session.scopes || []).join(' '))
        .split(/[,\s]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
      expiresAt,
    });
  }
  return {
    ...credentials,
    providerToken: session && session.token || '',
  };
}

async function handleGitlabWebhook({ store, repoId, headers = {}, rawBody = '' }) {
  const repo = await requireRepo(store, repoId);
  const storedCredentials = await store.getCredentials(repoId);
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
  let credentials;
  try {
    credentials = await resolveRepositoryGitlabCredentials({ store, repo, credentials: storedCredentials });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_oauth_session_failed',
        detail: sanitizeError(error),
      },
    };
  }
  const bridge = createGitLabWebhookBridge({ store, repo, credentials });
  if (!repo.baseUrl || !repo.apiUrl) {
    return { status: 400, body: { error: 'git_server_incomplete' } };
  }
  if (!credentials.providerToken) {
    return { status: 403, body: { error: 'oauth_session_token_required' } };
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
