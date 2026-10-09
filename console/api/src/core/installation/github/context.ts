// @ts-nocheck
import { resolveGitServer } from '../../common.js'
import { providerFetch } from '../../provider-api.js'
import { githubClient, githubError, githubProject, installationClient } from '../../github/api.js'
import { mergeAgentrixInstallInput, savedAgentrixDefaults } from '../../user-agentrix-config.js'

export async function githubInstallContext({ store, input = {}, session, env = process.env }) {
  const { server, config } = await resolveGitServer(store, input, session, 'github')
  if (!session?.token || session.gitServerId !== server.id) throw githubError('github_login_required', 401)
  const id = String(input.projectId || '')
  const path = id ? `/repositories/${encodeURIComponent(id)}` : `/repos/${String(input.projectPath || '').split('/').map(encodeURIComponent).join('/')}`
  const repository = await providerFetch(githubClient(server, session.token), 'GET', path)
  const project = githubProject(repository)
  const existing = await store.findRepositoryByProject({ gitServerId: server.id, projectId: project.id })
  if (!existing) throw githubError('repository_not_found', 404)
  const defaults = await savedAgentrixDefaults(store, session.userId, env)
  let appAccess
  return {
    server, config, project, existing, repository,
    installConfig: mergeAgentrixInstallInput(input, defaults, env),
    async appAccess() { return appAccess ||= installationClient(server, project.fullName) },
  }
}

export function githubProjectAccess({ project }) {
  return { canManage: project.canInstall, accessLevelKnown: true, accessLevel: project.canInstall ? 40 : 20, role: project.canInstall ? 'Admin' : 'Member' }
}

export async function githubManageContext(options) {
  const context = await githubInstallContext(options)
  if (!githubProjectAccess(context).canManage) throw githubError('github_project_permission_required', 403)
  return { ...context, ...(await context.appAccess()) }
}
