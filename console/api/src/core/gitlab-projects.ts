// @ts-nocheck
import { actionExecutionForProject } from './action-execution.js'
import { gitlabInstallContext, resolveGitlabProjectAccess } from './installation/gitlab/context.js'
import { sanitizeError } from './sanitize.js'
import { gitlabInstaller } from './installation/gitlab/adapter.js'
import { checkProjectInstall, installProjectPlugin } from './installation/workflow.js'

export { getGitlabProjectRole, listGitlabProjectsWithInstallStatus } from './installation/gitlab/context.js'
export { setGitlabProjectInstallPermission } from './installation/gitlab/permissions.js'
export { setGitlabProjectInstallLabels } from './installation/gitlab/labels.js'
export { setGitlabProjectInstallRunner } from './installation/gitlab/runners.js'
export { setGitlabProjectInstallVariable } from './installation/gitlab/variables.js'
export { setGitlabProjectInstallWebhook } from './installation/gitlab/webhook.js'

export function checkGitlabProjectInstall(options) {
  return checkProjectInstall(options, gitlabInstaller)
}

export function installGitlabProjectPlugin(options) {
  return installProjectPlugin(options, gitlabInstaller)
}

export async function configureGitlabActionExecution({ store, input = {}, session, env = process.env, logger = undefined, save = false }) {
  try {
    const context = await gitlabInstallContext({ store, input, session, env, logger })
    const access = await resolveGitlabProjectAccess(context)
    if (save && !access.canManage) return { status: 403, body: { error: 'gitlab_project_permission_required', access } }
    const result = await actionExecutionForProject({ store, context, input, save })
    return { ...result, body: { ...result.body, access } }
  } catch (error) {
    return { status: error.status || 502, body: { error: error.code || (error.status === 403 ? 'action_execution_permission_denied' : 'action_execution_gitlab_failed'), detail: sanitizeError(error) } }
  }
}
