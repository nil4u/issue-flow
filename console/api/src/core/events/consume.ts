// @ts-nocheck
import { applyIssueSnapshotToFacts } from '../issue-projection.js'
import { applyPullRequestSnapshotToFacts } from '../pull-request-projection.js'
import { ISSUE_FLOW_PLUGIN_KEY, pluginCacheFromMergedPending } from '../issue-flow-plugin.js'
import { compactNulls, sanitize } from '../sanitize.js'

// --- 事件消费：只接收标准事实，不参与流水线投递 ---
export async function recordGitEvent(store, record, normalize) {
  const saved = await store.createGitEvent({
    ...record,
    payload: sanitize(compactNulls(record.payload || {})),
    normalizedEvents: sanitize(record.normalizedEvents || []),
  })
  const facts = normalize(saved)
  await applyIssueSnapshotToFacts(store, facts.issue, { projectSpan: facts.projectSpan })
  await applyPullRequestSnapshotToFacts(store, facts.pullRequest)
  return saved
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

export async function applyPluginChange({ store, repo, change }) {
  if (!change || !['merged', 'closed'].includes(change.state)) return undefined
  const repository = await store.getRepository(repo.id)
  const pending = pendingPlugin(repository)
  if (!pluginMergeMatches(pending, change)) return undefined
  const next = change.state === 'merged'
    ? pluginCacheFromMergedPending(pending)
    : { ...pending, pendingMergeRequest: undefined }
  await store.updateRepositorySettingsCache(repo.id, {
    plugins: { items: [next], checkedAt: new Date().toISOString() },
  })
  return change.state === 'merged' ? 'plugin_merge_refreshed' : 'plugin_pending_merge_cleared'
}

async function applyActionExecutionChange({ store, repo, change }) {
  if (!change || !['merged', 'closed'].includes(change.state)) return undefined
  const repository = await store.getRepository(repo.id)
  const cached = repository.settings?.actionExecution
  const pending = cached?.pendingMergeRequest
  if (!pending || String(pending.iid) !== String(change.iid) || pending.sourceBranch !== change.sourceBranch) return undefined
  await store.updateRepositorySettingsCache(repo.id, {
    actionExecution: { ...cached, state: 'stale', pendingMergeRequest: undefined, checkedAt: new Date().toISOString() },
  })
  return 'action_execution_pending_cleared'
}

export async function applyRepositoryChange(input) {
  const handled = await Promise.all([applyPluginChange(input), applyActionExecutionChange(input)])
  return handled.filter(Boolean)
}
