// @ts-nocheck
import { githubInstaller } from './github/adapter.js'
import { gitlabInstaller } from './gitlab/adapter.js'

const installers = new Map([[gitlabInstaller.id, gitlabInstaller], [githubInstaller.id, githubInstaller]])

export async function repositoryInstaller({ store, input = {}, session }) {
  const server = await store.getGitServer(input.gitServerId || session?.gitServerId || '')
  if (!server) throw Object.assign(new Error('git_server_not_found'), { status: 404 })
  const installer = installers.get(server.type)
  if (!installer) throw Object.assign(new Error('git_server_type_unsupported'), { status: 400 })
  return installer
}
