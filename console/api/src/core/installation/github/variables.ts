// @ts-nocheck
import { publicIssueFlowBaseUrl } from '../config.js'
import sodium from 'libsodium-wrappers'
import { githubRepoPath, providerFetch } from '../../provider-api.js'
import { githubPages, githubError } from '../../github/api.js'
import { validateAgentrixApiKey } from '../../agentrix-api.js'
import { githubManageContext } from './context.js'
import { installStep } from '../steps.js'

function definitions(context) {
  const { installConfig, basePublicUrl, server } = context
  return [
    { key: 'ISSUE_FLOW_BASE_URL', value: publicIssueFlowBaseUrl(basePublicUrl, context.env) },
    { key: 'AGENTRIX_BASE_URL', value: installConfig.agentrix?.baseUrl },
    { key: 'AGENTRIX_API_KEY', value: installConfig.agentrix?.apiKey, masked: true },
    { key: 'AGENTRIX_RUNNER_ID', value: installConfig.agentrix?.runnerId },
    { key: 'AGENTRIX_GIT_SERVER_ID', value: server.agentrixGitServerId },
    { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: installConfig.automation?.agent || 'codex' },
    { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: installConfig.automation?.autoDefault || 'triage' },
    { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: String(Boolean(installConfig.automation?.reviewEnabled)) },
    { key: 'ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST', required: false },
  ]
}

function variableRow(definition, current) {
  const exists = Boolean(current)
  const autoWritable = !exists && definition.value !== undefined && definition.value !== ''
  const manualRequired = !exists && !autoWritable && definition.required !== false
  return { ...definition, value: definition.masked && exists ? '*****' : current?.value || '',
    label: definition.key, exists, source: 'github', status: exists || definition.required === false && !autoWritable ? 'passed' : autoWritable ? 'pending_auto' : 'manual_required',
    detail: exists ? '已设置' : autoWritable ? '待自动写入' : manualRequired ? '需要填写后保存' : '未设置，使用默认值',
    required: definition.required !== false, autoWritable, writable: autoWritable, manualRequired, needsInput: manualRequired, blocker: manualRequired,
  }
}

async function readVariables(context) {
  const { client } = await context.appAccess()
  const root = `${githubRepoPath(context.project)}/actions`
  const [variables, secrets] = await Promise.all([githubPages(client, `${root}/variables`, 'variables'), githubPages(client, `${root}/secrets`, 'secrets')])
  const current = new Map([...variables, ...secrets].map((item) => [item.name, item]))
  return definitions(context).map((definition) => variableRow(definition, current.get(definition.key)))
}

function variableStep(rows) {
  const missing = rows.filter((row) => row.status === 'pending_auto').map((row) => row.key)
  const inputRequired = rows.filter((row) => row.manualRequired).map((row) => row.key)
  const failed = rows.some((row) => row.status === 'failed')
  return installStep('variables', 'api', 'Actions variables / secrets', failed ? 'failed' : inputRequired.length ? 'needs_input' : missing.length ? 'needs_action' : 'passed', failed ? '部分配置写入失败' : inputRequired.length ? '需要补充配置' : missing.length ? '待写入配置' : '已配置', { variables: rows, missing, inputRequired, blockers: inputRequired })
}

async function saveRows(context, rows) {
  const repository = await context.store.updateRepositorySettingsCache(context.existing.id, { variables: { items: rows, checkedAt: new Date().toISOString() } })
  const step = variableStep(rows)
  return { status: 200, body: { repository, step, steps: [step], installable: !['failed', 'needs_input'].includes(step.status) } }
}

export async function checkGithubVariables(context) {
  return (await saveRows(context, await readVariables(context))).body.step
}

async function writeVariable(context, definition, value, exists) {
  const { client } = await context.appAccess()
  const root = `${githubRepoPath(context.project)}/actions`
  if (definition.key === 'AGENTRIX_API_KEY') await validateAgentrixApiKey({ apiKey: value })
  if (!definition.masked) return providerFetch(client, exists ? 'PATCH' : 'POST', `${root}/variables${exists ? `/${definition.key}` : ''}`, { name: definition.key, value })
  const key = await providerFetch(client, 'GET', `${root}/secrets/public-key`)
  await sodium.ready
  const encrypted = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL))
  return providerFetch(client, 'PUT', `${root}/secrets/${definition.key}`, { key_id: key.key_id, encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL) })
}

export async function configureGithubVariables(options) {
  const context = { ...options, ...await githubManageContext(options) }
  const rows = await readVariables(context)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const key = String(options.input?.key || '')
  const selected = definitions(context).filter((item) => key ? item.key === key : byKey.get(item.key)?.autoWritable)
  if (key && !selected.length) throw githubError('github_variable_unknown')
  for (const definition of selected) {
    const value = key && options.input.value !== undefined ? options.input.value : definition.value
    if (value === undefined || value === '' && definition.required !== false) throw githubError('github_variable_value_required')
    try {
      await writeVariable(context, definition, String(value), byKey.get(definition.key)?.exists)
      byKey.set(definition.key, variableRow(definition, { value: String(value) }))
    } catch (error) {
      byKey.set(definition.key, { ...byKey.get(definition.key), status: 'failed', detail: `写入失败：${error.code || `HTTP ${error.status || 502}`}`, blocker: true })
    }
  }
  return saveRows(context, [...byKey.values()])
}
