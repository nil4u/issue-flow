// @ts-nocheck
import { actionExecutionForProject } from '../action-execution.js'
import { githubInstallContext, githubProjectAccess } from '../installation/github/context.js'
import { readGithubFile } from '../installation/github/plugin.js'
import { providerFetch, githubRepoPath } from '../provider-api.js'
import { githubError } from './api.js'

function actionProvider(client, project) {
  const root = githubRepoPath(project)
  return {
    async readFile({ filePath, ref }) {
      const file = await readGithubFile(client, project, filePath, ref)
      return file ? { ...file, last_commit_id: file.sha } : undefined
    },
    async readChange({ iid }) {
      const pr = await providerFetch(client, 'GET', `${root}/pulls/${iid}`)
      return { ...pr, state: pr.merged ? 'merged' : pr.state === 'open' ? 'opened' : 'closed' }
    },
    async commit({ branch, startBranch, actions, commitMessage }) {
      const ref = await providerFetch(client, 'GET', `${root}/git/ref/heads/${encodeURIComponent(startBranch)}`)
      const action = actions[0]
      const file = await readGithubFile(client, project, action.file_path, ref.object.sha)
      if (!file || file.sha !== action.last_commit_id) throw githubError('action_execution_revision_conflict', 409)
      await providerFetch(client, 'POST', `${root}/git/refs`, { ref: `refs/heads/${branch}`, sha: ref.object.sha })
      await providerFetch(client, 'PUT', `${root}/contents/${action.file_path}`, { branch, sha: file.sha, message: commitMessage, content: Buffer.from(action.content).toString('base64') })
    },
    async createChange({ sourceBranch, targetBranch, title, description }) {
      const pr = await providerFetch(client, 'POST', `${root}/pulls`, { head: sourceBranch, base: targetBranch, title, body: description })
      return { id: pr.id, iid: pr.number, web_url: pr.html_url }
    },
  }
}

export async function configureGithubActionExecution(options) {
  const context = await githubInstallContext(options)
  const access = githubProjectAccess(context)
  if (options.save && !access.canManage) throw githubError('github_project_permission_required', 403)
  const { client } = await context.appAccess()
  const result = await actionExecutionForProject({ ...options, context: { ...context, actionProvider: actionProvider(client, context.project) } })
  return { ...result, body: { ...result.body, access } }
}
