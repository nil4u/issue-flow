// @ts-nocheck
import fs from 'node:fs'

import { issueFlowPackageJsonPath } from './plugin-paths.js'

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

function pluginNeedsUpgrade(installedVersion, latestVersion) {
  return !installedVersion || Boolean(latestVersion && compareVersions(installedVersion, latestVersion) < 0)
}

function pluginVersionValue(version) {
  return version ? String(version).replace(/^v/, '') : ''
}

function pluginState(cache) {
  if (cache && cache.pendingMergeRequest && cache.pendingMergeRequest.webUrl) {
    return { status: 'needs_action', detail: `MR !${cache.pendingMergeRequest.iid || ''} 待合并`, needsUpgrade: Boolean(cache.needsUpgrade) }
  }
  if (!cache || !cache.installed) {
    return { status: 'blocked', detail: '未安装', needsUpgrade: false }
  }
  if (!cache.installedVersion) {
    const latest = pluginVersionValue(cache.latestVersion || LATEST_ISSUE_FLOW_VERSION)
    return { status: 'needs_action', detail: `未知版本 -> ${latest}`, needsUpgrade: true }
  }
  if (pluginNeedsUpgrade(cache.installedVersion, cache.latestVersion || LATEST_ISSUE_FLOW_VERSION)) {
    const latest = pluginVersionValue(cache.latestVersion || LATEST_ISSUE_FLOW_VERSION)
    return { status: 'needs_action', detail: `${pluginVersionValue(cache.installedVersion)} -> ${latest}`, needsUpgrade: true }
  }
  return { status: 'passed', detail: `v${pluginVersionValue(cache.installedVersion)}`, needsUpgrade: false }
}

function pluginCacheFromManifest(manifest = {}, extra = {}) {
  const installedVersion = String(manifest.issueFlowVersion || manifest.issue_flow_version || '')
  const latestVersion = extra.latestVersion || LATEST_ISSUE_FLOW_VERSION
  const cache = {
    key: ISSUE_FLOW_PLUGIN_KEY,
    source: 'gitlab',
    manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    installed: true,
    installedVersion,
    latestVersion,
    manifestVersion: Number(manifest.version || 0),
    provider: manifest.provider || 'gitlab',
    runtime: manifest.runtime || 'agentrix',
    pendingMergeRequest: extra.pendingMergeRequest || undefined,
  }
  return {
    ...cache,
    ...pluginState(cache),
  }
}

function pluginCacheFromMergedPending(cache = {}) {
  const latestVersion = cache.latestVersion || LATEST_ISSUE_FLOW_VERSION
  const installedVersion = String(cache.targetVersion || latestVersion || cache.installedVersion || '')
  const next = {
    ...cache,
    key: ISSUE_FLOW_PLUGIN_KEY,
    source: 'gitlab',
    manifestPath: ISSUE_FLOW_MANIFEST_PATH,
    installed: true,
    installedVersion,
    latestVersion,
    targetVersion: undefined,
    provider: cache.provider || 'gitlab',
    runtime: cache.runtime || 'agentrix',
    pendingMergeRequest: undefined,
  }
  return {
    ...next,
    ...pluginState(next),
  }
}

export {
  ISSUE_FLOW_MANIFEST_PATH,
  ISSUE_FLOW_PLUGIN_KEY,
  LATEST_ISSUE_FLOW_VERSION,
  compareVersions,
  pluginCacheFromManifest,
  pluginCacheFromMergedPending,
  pluginNeedsUpgrade,
  pluginState,
  pluginVersionValue,
}
