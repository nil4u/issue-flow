// @ts-nocheck
import { githubProject } from './api.js'

export async function githubRepositoryLifecycle(store, server, eventName, payload) {
  const added = eventName === 'installation_repositories' ? payload.repositories_added || [] : payload.repositories || []
  const revoked = ['deleted', 'suspend'].includes(payload.action)
  const removed = eventName === 'installation_repositories' ? [...(payload.repositories_removed || [])] : revoked ? [...(payload.repositories || [])] : []
  if (eventName === 'installation' && revoked) {
    const rows = await store.db.repo.findMany({ where: { gitServerId: server.id } })
    for (const row of rows) {
      const repo = await store.getRepository(row.id)
      if (String(repo.settings?.webhook?.installationId) === String(payload.installation.id)) removed.push({ id: row.serverRepoId })
    }
  }
  for (const repository of removed) {
    const repo = await store.findRepositoryByProject({ gitServerId: server.id, projectId: String(repository.id) })
    if (!repo) continue
    await store.db.userRepoAccess.deleteMany({ where: { gitServerId: server.id, repoId: repo.id } })
    await store.updateRepositorySettingsCache(repo.id, { webhook: { ...repo.settings?.webhook, installationActive: false } })
  }
  if (revoked) return
  for (const repository of added) {
    const existing = await store.findRepositoryByProject({ gitServerId: server.id, projectId: String(repository.id) })
    const project = { ...githubProject(repository), defaultBranch: repository.default_branch || existing?.defaultBranch || "", webUrl: repository.html_url || existing?.webUrl || `${server.baseUrl}/${repository.full_name}` }
    project.url = project.webUrl
    const repo = await store.upsertRepo({ ...project, id: undefined, gitServerId: server.id })
    await store.updateRepositorySettingsCache(repo.id, { webhook: { source: 'github', installationId: String(payload.installation.id), installationActive: true } })
  }
}
