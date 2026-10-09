// @ts-nocheck
import { resolveGitServer } from '../common.js'
import { resolveFreshSession } from '../session.js'
import { providerFetch } from '../provider-api.js'
import { githubClient, githubProject, githubError, githubInstallUrl, discoverGithubRepositories } from './api.js'
import { githubInstallContext, githubProjectAccess } from '../installation/github/context.js'

export async function syncGithubConnection(store, server, token, userId) {
  const { projects, connection } = await discoverGithubRepositories(server, token)
  const rows = await store.syncRepositories({ gitServerId: server.id, userId, projects })
  for (const repo of rows) {
    const project = projects.find((project) => project.id === repo.serverRepoId)
    await store.updateRepositorySettingsCache(repo.id, { webhook: { ...repo.settings?.webhook, source: 'github', installationId: project.installationId } })
  }
  return { projects, connection }
}

export async function syncGithubRepositories(store, server, token, userId) {
  return (await syncGithubConnection(store, server, token, userId)).projects
}

export async function listGithubProjectsWithInstallStatus({ store, input = {}, session }) {
  const { server } = await resolveGitServer(store, input, session, 'github')
  if (!session?.token || session.gitServerId !== server.id) throw githubError('github_login_required', 401)
  try {
    const result = await syncGithubConnection(store, server, session.token, session.userId)
    return { status: 200, body: { ...result, installUrl: githubInstallUrl(server) } }
  } catch (error) {
    if (error.status === 401) throw githubError('github_login_required', 401)
    throw error
  }
}

export async function getGithubProjectRole(options) {
  const context = await githubInstallContext(options)
  return { status: 200, body: { project: context.project, access: githubProjectAccess(context) } }
}

export async function createGithubRepository({ store, input, userId }) {
  const { server } = await resolveGitServer(store, input, undefined, 'github')
  const session = await resolveFreshSession({ store, userId, gitServerId: server.id })
  if (!session?.token) throw githubError('github_login_required', 401)
  const path = String(input.projectPath || '').split('/').map(encodeURIComponent).join('/')
  if (!path) throw githubError('project_path_required')
  const project = githubProject(await providerFetch(githubClient(server, session.token), 'GET', `/repos/${path}`))
  const row = await store.upsertRepo({ ...project, id: undefined, gitServerId: server.id })
  await store.grantUserRepoAccess({ userId, gitServerId: server.id, repoId: row.id })
  return { status: 201, body: { repository: await store.getRepository(row.id) } }
}

export async function validateGithubRepository({ store, repo, userId }) {
  const { server } = await resolveGitServer(store, { gitServerId: repo.gitServerId }, undefined, 'github')
  const session = await resolveFreshSession({ store, userId, gitServerId: server.id })
  let validation = { status: 'invalid', lastValidatedAt: new Date().toISOString() }
  if (session?.token) {
    try {
      const project = await providerFetch(githubClient(server, session.token), 'GET', `/repositories/${encodeURIComponent(repo.serverRepoId)}`)
      validation = { ...validation, status: 'valid', projectId: String(project.id), defaultBranch: project.default_branch }
    } catch (error) { validation.errorCode = `HTTP_${error.status || 502}` }
  }
  return { status: 200, body: { repository: await store.updateTokenValidation(repo.id, validation), validation } }
}
