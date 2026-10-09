// @ts-nocheck
import { publicIssueFlowBaseUrl } from '../config.js'
import { githubRepoPath, providerFetch } from '../../provider-api.js'
import { ISSUE_FLOW_MANIFEST_PATH } from '../../issue-flow-plugin.js'
import { installPluginChange } from '../checkout.js'

export async function readGithubFile(client, project, filePath, branch) {
  try {
    return await providerFetch(client, 'GET', `${githubRepoPath(project)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)
  } catch (error) {
    if (error.status === 404) return undefined
    throw error
  }
}

export function githubPluginProvider(context) {
  const { server, project, existing, basePublicUrl } = context
  const branch = project.defaultBranch || existing.defaultBranch || 'main'
  return {
    id: 'github',
    async isChangeOpen(pending) {
      const { client } = await context.appAccess()
      const pr = await providerFetch(client, 'GET', `${githubRepoPath(project)}/pulls/${pending.iid}`)
      return pr.state === 'open'
    },
    async readManifest() {
      const { client } = await context.appAccess()
      const file = await readGithubFile(client, project, ISSUE_FLOW_MANIFEST_PATH, branch)
      return file ? JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) : undefined
    },
    async install(input) {
      const { client, token } = await context.appAccess()
      return installPluginChange({ ...input, branch, token, gitServerId: server.id, projectId: project.id, issueFlowBaseUrl: publicIssueFlowBaseUrl(basePublicUrl, context.env), commitAuthor: server.commitAuthor }, {
        id: 'github', changeName: 'PR',
        remoteUrl() {
          const url = new URL(`${server.baseUrl}/${project.fullName}.git`)
          url.username = 'x-access-token'; url.password = token
          return url.toString()
        },
        sparsePaths: ['.github/workflows/**', '.issue-flow/**', '.agentrix/plugins/issue-flow/**'],
        paths: ['.github/workflows', '.issue-flow', '.agentrix/plugins/issue-flow'],
        async createChange(change) {
          const pr = await providerFetch(client, 'POST', `${githubRepoPath(project)}/pulls`, {
            head: change.sourceBranch, base: change.targetBranch,
            title: input.mergeRequestTitle || `${input.operation === 'upgrade' ? 'Upgrade' : 'Install'} issue-flow plugin`,
            body: 'Install Issue Flow workflows and configuration. Merge this pull request to enable the installation.',
          })
          return { id: String(pr.id), iid: String(pr.number), webUrl: pr.html_url }
        },
      })
    },
  }
}
