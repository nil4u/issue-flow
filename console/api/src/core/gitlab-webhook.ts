// @ts-nocheck
import fs from 'node:fs'
import {
  composeVariables,
  defaultVariables,
  deliveryTarget,
  GitLabWebhookBridge,
  gitlabPipelineTarget,
  staticVariables,
} from '@xmz-ai/gitlab-webhook-bridge'
import { requireRepo, resolveGitServer } from './common.js'
import { getGitlabRepositoryFile } from './gitlab.js'
import { applyGitEventToIssueFacts } from './issue-projection.js'
import { applyGitEventToPullRequestFacts } from './pull-request-projection.js'
import { issueFlowPackageJsonPath } from './plugin-paths.js'
import { compactNulls, sanitize } from './sanitize.js'
import { sanitizeError } from './sanitize.js'

const ISSUE_FLOW_PLUGIN_KEY = 'issue-flow'
const ISSUE_FLOW_MANIFEST_PATH = '.issue-flow/install-manifest.json'
const LATEST_ISSUE_FLOW_VERSION = readPackageVersion()

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(issueFlowPackageJsonPath(), 'utf8'))
    return String(pkg.version || '')
  } catch {
    return ''
  }
}

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
    await applyGitEventToPullRequestFacts(store, gitEvent);
    return {
      target: 'issue-flow-git-event-log',
      eventId: input.deliveryId,
      status: 'ignored',
      reason: 'git_event_stored',
    };
  });
}

function createIssueFlowBusinessTarget(store, repo, secrets) {
  return deliveryTarget('issue-flow-business', async (input) => {
    const handled = (await Promise.all((input.events || []).map((event) => handleIssueFlowBusinessEvent({
      store,
      repo,
      secrets,
      event,
    })))).flat().filter(Boolean);
    return {
      target: 'issue-flow-business',
      eventId: input.deliveryId,
      status: handled.length ? 'delivered' : 'ignored',
      reason: handled.length ? 'issue_flow_business_handled' : 'no_issue_flow_business_handler',
      handled,
    };
  }, { onError: 'ignore' });
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
      createIssueFlowBusinessTarget(store, repo, secrets),
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

function mergedMergeRequest(payload = {}) {
  const attributes = payload.object_attributes || payload.objectAttributes || {}
  const kind = payload.object_kind || payload.objectKind || payload.event_type || payload.eventType || ''
  if (kind !== 'merge_request') return undefined
  const state = attributes.state || ''
  const action = attributes.action || ''
  if (state !== 'merged' && action !== 'merge') return undefined
  return {
    iid: attributes.iid !== undefined ? String(attributes.iid) : '',
    sourceBranch: attributes.source_branch || attributes.sourceBranch || '',
  }
}

function closedMergeRequest(payload = {}) {
  const attributes = payload.object_attributes || payload.objectAttributes || {}
  const kind = payload.object_kind || payload.objectKind || payload.event_type || payload.eventType || ''
  if (kind !== 'merge_request') return undefined
  const state = attributes.state || ''
  const action = attributes.action || ''
  if (state !== 'closed' && action !== 'close') return undefined
  return {
    iid: attributes.iid !== undefined ? String(attributes.iid) : '',
    sourceBranch: attributes.source_branch || attributes.sourceBranch || '',
  }
}

function pendingPlugin(repository = {}) {
  return (repository.settings && repository.settings.plugins && repository.settings.plugins.items || [])
    .find((item) => item && item.key === ISSUE_FLOW_PLUGIN_KEY && item.pendingMergeRequest)
}

function pluginMergeMatches(pending, mergeRequest) {
  if (!pending || !mergeRequest) return false
  const mr = pending.pendingMergeRequest || {}
  if (mr.iid && mergeRequest.iid && String(mr.iid) === String(mergeRequest.iid)) return true
  const source = mergeRequest.sourceBranch || ''
  return source.startsWith('issue-flow/install-') || source.startsWith('issue-flow/upgrade-')
}

function pluginCacheFromManifest(manifest = {}) {
  const installedVersion = String(manifest.issueFlowVersion || manifest.issue_flow_version || '')
  const needsUpgrade = !installedVersion
    || Boolean(LATEST_ISSUE_FLOW_VERSION && compareVersions(installedVersion, LATEST_ISSUE_FLOW_VERSION) < 0)
  const detail = !installedVersion
    ? `未知版本 -> ${LATEST_ISSUE_FLOW_VERSION.replace(/^v/, '')}`
    : needsUpgrade
      ? `${installedVersion.replace(/^v/, '')} -> ${LATEST_ISSUE_FLOW_VERSION.replace(/^v/, '')}`
      : `v${installedVersion.replace(/^v/, '')}`
  return {
    key: ISSUE_FLOW_PLUGIN_KEY,
    source: 'gitlab',
    manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    installed: true,
    installedVersion,
    latestVersion: LATEST_ISSUE_FLOW_VERSION,
    manifestVersion: Number(manifest.version || 0),
    provider: manifest.provider || 'gitlab',
    runtime: manifest.runtime || 'agentrix',
    needsUpgrade,
    status: needsUpgrade ? 'needs_action' : 'passed',
    detail,
  }
}

async function handleIssueFlowBusinessEvent({ store, repo, secrets, event }) {
  const payload = event && event.raw && event.raw.body || {}
  return Promise.all([
    refreshPluginAfterMerge({ store, repo, secrets, payload }),
    clearPluginAfterClose({ store, repo, payload }),
  ])
}

async function refreshPluginAfterMerge({ store, repo, secrets, payload }) {
  const mergeRequest = mergedMergeRequest(payload)
  if (!mergeRequest) return undefined
  const repository = await store.getRepository(repo.id)
  const pending = pendingPlugin(repository)
  if (!pluginMergeMatches(pending, mergeRequest)) return undefined
  const checkedAt = new Date().toISOString()
  const file = await getGitlabRepositoryFile({
    apiUrl: repo.apiUrl,
    token: secrets.providerToken,
    authType: secrets.providerAuthType || 'private-token',
    projectIdOrPath: repo.projectId || repo.serverRepoId || repo.projectPath,
    filePath: ISSUE_FLOW_MANIFEST_PATH,
    ref: repo.defaultBranch || 'main',
  })
  const manifest = file ? JSON.parse(decodeGitlabFile(file)) : undefined
  await store.updateRepositorySettingsCache(repo.id, {
    plugins: {
      items: manifest ? [pluginCacheFromManifest(manifest)] : [],
      checkedAt,
    },
  })
  return 'plugin_merge_refreshed'
}

async function clearPluginAfterClose({ store, repo, payload }) {
  const mergeRequest = closedMergeRequest(payload)
  if (!mergeRequest) return undefined
  const repository = await store.getRepository(repo.id)
  const pending = pendingPlugin(repository)
  if (!pluginMergeMatches(pending, mergeRequest)) return undefined
  await store.updateRepositorySettingsCache(repo.id, {
    plugins: {
      items: [{
        ...pending,
        pendingMergeRequest: undefined,
      }],
      checkedAt: new Date().toISOString(),
    },
  })
  return 'plugin_pending_merge_cleared'
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
