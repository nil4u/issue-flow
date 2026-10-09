// @ts-nocheck
import { randomUUID } from 'node:crypto'
import domain from 'issue-flow/domain'
import { createGitlabMergeRequest, createGitlabRepositoryCommit, getGitlabMergeRequest, getGitlabRepositoryFile } from './gitlab.js'
import { sanitizeError } from './sanitize.js'

const CONFIG_PATH = '.issue-flow/config.json'
const submissions = new Set()
function gitlabActionProvider(apiInput) {
  return {
    readFile: (input) => getGitlabRepositoryFile({ ...apiInput, ...input }),
    readChange: (input) => getGitlabMergeRequest({ ...apiInput, ...input }),
    commit: (input) => createGitlabRepositoryCommit({ ...apiInput, ...input }),
    createChange: (input) => createGitlabMergeRequest({ ...apiInput, ...input }),
  }
}

async function readConfiguration(provider, branch) {
  const file = await provider.readFile({ filePath: CONFIG_PATH, ref: branch })
  if (!file) return { state: 'missing', exists: false }
  const revision = file.last_commit_id || file.blob_id || ''
  let config
  try {
    config = JSON.parse(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'))
  } catch {
    return { state: 'invalid_json', exists: true, revision }
  }
  try {
    return { state: 'ready', exists: true, revision, ...domain.actionExecutionSnapshot(config), config }
  } catch (error) {
    return { state: 'invalid_config', exists: true, revision, detail: error.message }
  }
}

async function actionExecutionForProject({ store, context, input = {}, save = false }) {
  const { project, existing, apiInput } = context
  if (!existing) return { status: 404, body: { error: 'repository_not_found' } }
  const provider = context.actionProvider || gitlabActionProvider(apiInput)
  const lockKey = `${context.server?.apiUrl || apiInput?.apiUrl}:${project.id}`
  if (submissions.has(lockKey)) return { status: 409, body: { error: 'action_execution_submission_in_progress' } }
  submissions.add(lockKey)
  try {
    const repository = await store.getRepository(existing.id)
    let pendingMergeRequest = repository.settings?.actionExecution?.pendingMergeRequest
    let refreshError
    if (pendingMergeRequest) {
      try {
        const mr = await provider.readChange({ iid: pendingMergeRequest.iid })
        if (mr && ['merged', 'closed'].includes(mr.state)) pendingMergeRequest = undefined
        else if (!mr) refreshError = 'pending_merge_request_refresh_failed'
      } catch {
        refreshError = 'pending_merge_request_refresh_failed'
      }
    }
    const branch = project.defaultBranch || existing.defaultBranch || 'main'
    const { config, ...snapshot } = await readConfiguration(provider, branch)
    const actionExecution = {
      ...snapshot, branch, path: CONFIG_PATH, pendingMergeRequest, refreshError,
      actionNames: domain.ACTION_NAMES, fields: domain.ACTION_FIELDS, reasoningEfforts: [...domain.REASONING_EFFORTS],
      checkedAt: new Date().toISOString(),
    }
    await store.updateRepositorySettingsCache(existing.id, { actionExecution })
    if (!save) return { status: 200, body: { actionExecution } }
    if (pendingMergeRequest) return { status: 409, body: { error: 'action_execution_pending_merge_request', actionExecution } }
    if (snapshot.state !== 'ready') return { status: 422, body: { error: `action_execution_${snapshot.state}`, actionExecution } }
    if (!input.baseRevision || snapshot.revision !== input.baseRevision) return { status: 409, body: { error: 'action_execution_revision_conflict' } }
    let next
    try {
      next = domain.mergeActionExecution(config, input.actions)
    } catch (error) {
      return { status: 400, body: { error: 'action_execution_invalid_input', detail: error.message } }
    }
    if (JSON.stringify(next) === JSON.stringify(config)) return { status: 200, body: { skipped: true, actionExecution } }
    const sourceBranch = `issue-flow/action-execution-${randomUUID()}`
    try {
      await provider.commit({ branch: sourceBranch, startBranch: branch,
        commitMessage: 'feat(issue-flow): configure action execution',
        actions: [{ action: 'update', file_path: CONFIG_PATH, content: `${JSON.stringify(next, null, 2)}\n`, last_commit_id: snapshot.revision }],
      })
    } catch (error) {
      if (error.status === 403) return { status: 403, body: { error: 'action_execution_permission_denied' } }
      return { status: error.status === 400 || error.status === 409 ? 409 : 502, body: { error: error.status === 400 || error.status === 409 ? 'action_execution_revision_conflict' : 'action_execution_commit_failed', detail: sanitizeError(error) } }
    }
    const mr = await provider.createChange({ sourceBranch, targetBranch: branch, title: 'Configure Issue Flow action execution',
      description: 'Update explicit agent, model and reasoning effort overrides in `.issue-flow/config.json`. Takes effect after merge for new tasks only; running and resumed tasks are unchanged.',
    })
    actionExecution.pendingMergeRequest = { iid: mr.iid, id: mr.id, webUrl: mr.web_url, sourceBranch, targetBranch: branch }
    await store.updateRepositorySettingsCache(existing.id, { actionExecution })
    return { status: 202, body: { actionExecution, pendingMergeRequest: actionExecution.pendingMergeRequest } }
  } catch (error) {
    if (error.status === 403) return { status: 403, body: { error: 'action_execution_permission_denied' } }
    return { status: 502, body: { error: `action_execution_${context.server?.type || 'gitlab'}_failed`, detail: sanitizeError(error) } }
  } finally {
    submissions.delete(lockKey)
  }
}

export { actionExecutionForProject }
