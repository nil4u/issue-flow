// @ts-nocheck
import { installPlugin } from './plugin.js'

export function installPlan(adapter) {
  return {
    provider: adapter.id,
    steps: adapter.steps.map(({ id, label, configure }) => ({ id, label, configurable: Boolean(configure) })),
  }
}

function selectedSteps(input, steps) {
  const raw = Array.isArray(input.checkTypes) ? input.checkTypes : String(input.checkType || input.type || '').split(',').map((value) => value.trim())
  const requested = new Set(raw.filter((id) => steps.some((step) => step.id === id)))
  return requested.size ? steps.filter((step) => requested.has(step.id)) : steps
}

async function resolveContext(options, adapter, failureCode) {
  let context
  try {
    context = await adapter.context(options)
  } catch (error) {
    return { failure: { status: error.status || 500, body: {
      error: error.code || `${adapter.id}_${failureCode}`, validation: error.validation,
      detail: error.message || '', installable: false, steps: [],
    } } }
  }
  const access = await adapter.access(context)
  if (!access.canManage) return { failure: { status: 403, body: {
    error: `${adapter.id}_project_permission_required`, installable: false, access, steps: [],
  } } }
  return { context: { ...options, ...context, access } }
}

// --- 安装编排：步骤顺序与可执行操作由平台 adapter 提供 ---
export async function checkProjectInstall(options, adapter) {
  const resolved = await resolveContext(options, adapter, 'install_check_failed')
  if (resolved.failure) return resolved.failure
  const context = resolved.context
  const { store, server, config, project, existing, access } = context
  const steps = []
  for (const definition of selectedSteps(options.input || {}, adapter.steps)) {
    const step = await definition.check(context)
    steps.push(step)
    if (definition.stopWhenBlocked && step.status === 'blocked') break
  }
  return { status: 200, body: {
    gitServer: { id: server.id, name: server.name, baseUrl: config.baseUrl },
    project, repository: existing ? await store.getRepository(existing.id) : null, access, steps,
    installable: steps.every((step) => !['blocked', 'needs_input', 'failed'].includes(step.status)),
  } }
}

export async function configureInstallStep(options, adapter) {
  const step = adapter.steps.find((step) => step.id === options.input?.checkType)
  if (!step?.configure) return { status: 400, body: { error: 'install_step_not_auto_configurable' } }
  return step.configure(options)
}

export async function installProjectPlugin(options, adapter) {
  const resolved = await resolveContext(options, adapter, 'plugin_install_context_failed')
  if (resolved.failure) return resolved.failure
  const context = resolved.context
  if (!context.existing) return { status: 404, body: { error: 'repository_not_found' } }
  return installPlugin({ ...context, provider: adapter.plugin(context) })
}
