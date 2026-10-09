// @ts-nocheck
import { createGitlabProjectLabel, listGitlabProjectLabels, updateGitlabProjectLabel } from '../../gitlab.js'
import { sanitizeError } from '../../sanitize.js'
import { resolveGitlabProjectAccess, gitlabInstallContext } from './context.js'
import { installStep } from '../steps.js'
import domain from 'issue-flow/domain'



function issueFlowManagedLabels() {
  return domain.labelsForScope('all')
}

function normalizedLabelColor(value = '') {
  return String(value || '').replace(/^#/, '').toUpperCase()
}

function gitlabLabelSyncAction(existing, definition) {
  if (!existing) return 'create'
  if (normalizedLabelColor(existing.color) !== normalizedLabelColor(definition.color)) return 'update'
  if (String(existing.description || '') !== String(definition.description || '')) return 'update'
  return 'skip'
}

async function checkGitlabIssueFlowLabels({ apiInput }) {
  const definitions = issueFlowManagedLabels()
  const current = await listGitlabProjectLabels(apiInput)
  const currentByName = new Map(current.map((label) => [String(label.name || ''), label]))
  const pending = definitions
    .map((definition) => ({ definition, action: gitlabLabelSyncAction(currentByName.get(definition.name), definition) }))
    .filter((item) => item.action !== 'skip')
  const missing = pending.filter((item) => item.action === 'create').map((item) => item.definition.name)
  const drifted = pending.filter((item) => item.action === 'update').map((item) => item.definition.name)
  const status = pending.length ? 'needs_action' : 'passed'
  const detail = pending.length
    ? `${missing.length} 个缺失，${drifted.length} 个需要更新`
    : `${definitions.length} 个标签已同步`
  return installStep('labels', 'api', 'Issue Flow labels', status, detail, {
    missing,
    drifted,
    actionCount: pending.length,
    labelActions: pending,
  })
}

async function setGitlabProjectInstallLabels({ store, input = {}, session, env = process.env, logger = undefined }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env, logger });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_labels_sync_failed',
        validation: error && error.validation || undefined,
      },
    };
  }
  const { project, existing, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return { status: 403, body: { error: 'gitlab_project_permission_required', access } };
  }
  try {
    const initial = await checkGitlabIssueFlowLabels({ apiInput });
    for (const item of initial.labelActions || []) {
      if (item.action === 'create') await createGitlabProjectLabel(apiInput, item.definition);
      if (item.action === 'update') await updateGitlabProjectLabel(apiInput, item.definition);
    }
    const step = await checkGitlabIssueFlowLabels({ apiInput });
    return {
      status: 200,
      body: {
        repository: existing ? await store.getRepository(existing.id) : null,
        access,
        step,
        steps: [step],
        installable: step.status === 'passed',
      },
    };
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'gitlab_labels_sync_failed',
        detail: sanitizeError(error),
      },
    };
  }
}

export { checkGitlabIssueFlowLabels, setGitlabProjectInstallLabels }
