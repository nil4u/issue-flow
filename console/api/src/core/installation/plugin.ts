// @ts-nocheck
import { ISSUE_FLOW_MANIFEST_PATH, ISSUE_FLOW_PLUGIN_KEY, LATEST_ISSUE_FLOW_VERSION, pluginCacheFromManifest, pluginCacheWithLocalLatestVersion, pluginState } from '../issue-flow-plugin.js'
import { sanitizeError } from '../sanitize.js'
import { installStep } from './steps.js'

function pluginSettingFromRepository(repository) {
  return (repository && repository.settings && repository.settings.plugins && repository.settings.plugins.items || [])
    .find((item) => item && item.key === ISSUE_FLOW_PLUGIN_KEY)
}

async function pluginCacheWithFreshPending({ store, existing, provider, cache }) {
  const pending = cache && cache.pendingMergeRequest
  if (!pending || !pending.webUrl) return cache
  try {
    if (await provider.isChangeOpen(pending)) return cache
  } catch {
    return cache
  }
  const next = {
    ...cache,
    pendingMergeRequest: undefined,
  }
  await store.updateRepositorySettingsCache(existing.id, {
    plugins: {
      items: [next],
      checkedAt: new Date().toISOString(),
    },
  })
  return next
}

function pluginStepFromCache(cache, extra = {}) {
  if (!cache) {
    const plugin = {
      key: ISSUE_FLOW_PLUGIN_KEY,
      manifestPath: ISSUE_FLOW_MANIFEST_PATH,
      latestVersion: LATEST_ISSUE_FLOW_VERSION,
      installed: false,
      ...pluginState(undefined),
    }
    return installStep('plugins', 'repo', 'issue-flow plugin', 'needs_action', '未安装', {
      plugins: [plugin],
    })
  }
  const cacheWithLatest = pluginCacheWithLocalLatestVersion({
    ...cache,
    targetVersion: cache.targetVersion || cache.latestVersion || LATEST_ISSUE_FLOW_VERSION,
  })
  const state = pluginState(cacheWithLatest)
  const plugin = {
    ...cacheWithLatest,
    ...state,
  }
  const stepStatus = state.status === 'blocked' ? 'needs_action' : state.status
  return installStep('plugins', 'repo', 'issue-flow plugin', stepStatus, state.detail, {
    plugins: [plugin],
    files: extra.files || undefined,
    actionCount: extra.actionCount || undefined,
  })
}

async function cachePlugin(store, repoId, plugin) {
  await store.updateRepositorySettingsCache(repoId, {
    plugins: { items: plugin ? [plugin] : [], checkedAt: new Date().toISOString() },
  })
}

async function invalidManifestStep({ store, existing, provider }, error) {
  if (error.status) {
    return installStep('plugins', 'repo', 'issue-flow plugin', 'blocked', `读取 manifest 失败：HTTP ${error.status}`, { plugins: [] })
  }
  const invalid = {
    key: ISSUE_FLOW_PLUGIN_KEY, source: provider.id, manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    installed: true, manifestInvalid: true, latestVersion: LATEST_ISSUE_FLOW_VERSION,
    detail: error.message || 'manifest invalid',
  }
  await cachePlugin(store, existing.id, invalid)
  return installStep('plugins', 'repo', 'issue-flow plugin', 'needs_action', 'manifest 无效，需要重新安装', { plugins: [invalid] })
}

async function readPlugin(provider) {
  const manifest = await provider.readManifest()
  return manifest ? pluginCacheFromManifest(manifest, { provider: provider.id }) : undefined
}

async function checkPlugin(context) {
  const { store, existing, provider } = context
  if (!existing) return pluginStepFromCache(undefined)
  try {
    const previous = await pluginCacheWithFreshPending({ ...context, cache: pluginSettingFromRepository(existing) })
    if (previous?.pendingMergeRequest?.webUrl) return pluginStepFromCache(previous)
    const next = await readPlugin(provider)
    await cachePlugin(store, existing.id, next)
    return pluginStepFromCache(next)
  } catch (error) {
    return invalidManifestStep(context, error)
  }
}

function installResponse(status, repository, access, plugin, extra = {}) {
  const step = pluginStepFromCache(plugin, extra)
  return { status, body: {
    repository, access, step, steps: [step], plugin, installable: true,
    ...(plugin?.pendingMergeRequest ? { pendingMergeRequest: plugin.pendingMergeRequest } : {}),
  } }
}

async function skippedInstallation({ store, existing, access, provider }, previous) {
  let next
  try { next = await readPlugin(provider) } catch { next = previous }
  await cachePlugin(store, existing.id, next)
  return installResponse(200, await store.getRepository(existing.id), access, next)
}

async function pendingInstallation({ store, existing, access, provider }, previous, result) {
  const pending = {
    id: result.mergeRequest?.id || '', iid: result.mergeRequest?.iid || '', webUrl: result.mergeRequest?.webUrl || '',
    sourceBranch: result.sourceBranch || '', targetBranch: result.branch || '',
  }
  const next = {
    ...previous, key: ISSUE_FLOW_PLUGIN_KEY, source: provider.id, provider: provider.id,
    manifestPath: ISSUE_FLOW_MANIFEST_PATH, latestVersion: LATEST_ISSUE_FLOW_VERSION,
    targetVersion: LATEST_ISSUE_FLOW_VERSION, installed: Boolean(previous?.installed),
    pendingMergeRequest: pending, needsUpgrade: true,
  }
  await cachePlugin(store, existing.id, next)
  return installResponse(202, await store.getRepository(existing.id), access, next, {
    files: result.files || [], actionCount: result.actionCount || 0,
  })
}

async function installPlugin(context) {
  const { existing, access, input = {}, provider } = context
  const previous = await pluginCacheWithFreshPending({ ...context, cache: pluginSettingFromRepository(existing) })
  if (previous?.pendingMergeRequest?.webUrl && !input.force) return installResponse(200, existing, access, previous)
  let result
  try {
    result = await provider.install({
      operation: previous?.installed ? 'upgrade' : 'install', commitMessage: input.commitMessage,
      mergeRequestTitle: input.mergeRequestTitle, onProgress: input.onProgress, decisions: input.decisions,
    })
  } catch (error) {
    return { status: error.status || 502, body: { error: `${provider.id}_plugin_install_failed`, detail: sanitizeError(error) } }
  }
  if (result.conflicts) return { status: 409, body: { fingerprint: result.plan?.fingerprint || '', conflicts: result.plan?.conflicts || [] } }
  return result.skipped ? skippedInstallation(context, previous) : pendingInstallation(context, previous, result)
}

export { checkPlugin, installPlugin }
