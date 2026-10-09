// @ts-nocheck
import domain from 'issue-flow/domain'
import { githubWebhookUrl, externallyAddressableWebhook } from '../../events/urls.js'
import { githubRepoPath, providerFetch } from '../../provider-api.js'
import { githubAppRequest, githubInstallUrl, githubPages } from '../../github/api.js'
import { installStep } from '../steps.js'
import { checkPlugin } from '../plugin.js'
import { githubInstallContext, githubProjectAccess, githubManageContext } from './context.js'
import { githubPluginProvider } from './plugin.js'
import { checkGithubVariables, configureGithubVariables } from './variables.js'

async function checkPermissions(context) {
  const { installation } = await context.appAccess()
  const required = { contents: 'Contents', issues: 'Issues', pull_requests: 'Pull requests', workflows: 'Workflows', secrets: 'Secrets', actions_variables: 'Variables' }
  const missing = Object.keys(required).filter((key) => installation.permissions?.[key] !== 'write')
  if (!['read', 'write'].includes(installation.permissions?.actions)) missing.push('actions')
  const requirements = missing.map((key) => key === 'actions' ? 'Actions（Read-only）' : `${required[key]}（Read and write）`)
  const permissions = [{ key: 'github-app', source: 'github', canManage: !missing.length, role: missing.length ? '权限不足' : '已授权', memberUrl: githubInstallUrl(context.server) }]
  await context.store.updateRepositorySettingsCache(context.existing.id, { permissions: { items: permissions, checkedAt: new Date().toISOString() } })
  return installStep('permissions', 'auth', 'GitHub App', missing.length ? 'blocked' : 'passed', missing.length ? `请授权 App 权限：${requirements.join(', ')}` : 'App 已安装且权限完整', { permissions, missing, memberUrl: githubInstallUrl(context.server) })
}

async function checkWebhook(context) {
  const hook = await githubAppRequest(context.server, 'GET', '/app/hook/config')
  const url = githubWebhookUrl(context.basePublicUrl, context.env)
  const addressable = externallyAddressableWebhook(url)
  const secretConfigured = Boolean(context.server.webhook?.secret)
  const ready = addressable && hook.url === url && secretConfigured
  const cache = { ...context.existing.settings?.webhook, key: 'issue-flow', source: 'github', hookId: ready ? String(context.server.githubApp.appId) : '', url: hook.url, settingsUrl: `${context.server.baseUrl}/apps/${encodeURIComponent(context.server.githubApp.slug)}`, status: ready ? 'passed' : 'needs_action' }
  await context.store.updateRepositorySettingsCache(context.existing.id, { webhook: cache })
  const detail = !addressable
    ? '请在服务端设置 ISSUE_FLOW_WEBHOOK_BASE_URL 为 GitHub 可访问的公网地址，然后重新检查。'
    : !secretConfigured
      ? '请在 Console 的 Git server 配置中填写与 GitHub App 一致的 Webhook secret。'
      : ready ? url : `请将 GitHub App 的 Webhook URL 设置为 ${url}，并启用 Active。`
  return installStep('webhook', 'api', 'GitHub App webhook', ready ? 'passed' : 'needs_action', detail)
}

async function checkActions(context) {
  const { client } = await context.appAccess()
  await providerFetch(client, 'GET', `${githubRepoPath(context.project)}/actions/workflows?per_page=1`)
  return installStep('actions', 'api', 'GitHub Actions', context.repository.archived ? 'blocked' : 'passed', context.repository.archived ? '归档仓库不能执行 Actions' : 'Actions API 可访问；工作流运行遵循仓库和组织策略')
}

async function checkLabels(context) {
  const { client } = await context.appAccess()
  const labels = await githubPages(client, `${githubRepoPath(context.project)}/labels`)
  const byName = new Map(labels.map((label) => [label.name, label]))
  const pending = domain.labelsForScope('all').filter((definition) => {
    const label = byName.get(definition.name)
    return !label || label.color.toLowerCase() !== definition.color.replace('#', '').toLowerCase() || (label.description || '') !== (definition.description || '')
  })
  return installStep('labels', 'api', 'Issue Flow labels', pending.length ? 'needs_action' : 'passed', pending.length ? `${pending.length} 个标签需要同步` : '标签已同步', { missing: pending.map((label) => label.name), labelActions: pending.map((definition) => ({ definition, exists: byName.has(definition.name) })) })
}

async function configureLabels(options) {
  const context = { ...options, ...await githubManageContext(options) }
  const step = await checkLabels(context)
  for (const { definition, exists } of step.labelActions) {
    await providerFetch(context.client, exists ? 'PATCH' : 'POST', `${githubRepoPath(context.project)}/labels${exists ? `/${encodeURIComponent(definition.name)}` : ''}`, { name: definition.name, color: definition.color.replace('#', ''), description: definition.description || '' })
  }
  const next = await checkLabels(context)
  return { status: 200, body: { repository: context.existing, step: next, steps: [next], installable: true } }
}

export const githubInstaller = {
  id: 'github', context: githubInstallContext, access: githubProjectAccess, plugin: githubPluginProvider,
  steps: [
    { id: 'permissions', label: 'GitHub App', check: checkPermissions, stopWhenBlocked: true },
    { id: 'webhook', label: 'App webhook', check: checkWebhook },
    { id: 'actions', label: 'GitHub Actions', check: checkActions },
    { id: 'variables', label: 'Variables / Secrets', check: checkGithubVariables, configure: configureGithubVariables },
    { id: 'labels', label: 'Labels', check: checkLabels, configure: configureLabels },
    { id: 'plugins', label: 'Plugins', check: (context) => checkPlugin({ ...context, provider: githubPluginProvider(context) }) },
  ],
}
