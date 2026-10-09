// @ts-nocheck
import { createGitlabMergeRequest } from './gitlab.js'
import { installPluginChange } from './installation/checkout.js'
export { configureIssueFlow } from './installation/checkout.js'

function gitlabRemoteUrl(input = {}) {
  const url = new URL(input.baseUrl || '');
  const rootPath = url.pathname.replace(/\/+$/, '');
  const projectPath = String(input.projectPath || '').replace(/^\/+/, '');
  url.pathname = `${rootPath}/${projectPath}.git`;
  url.username = 'oauth2';
  url.password = input.token || '';
  return url.toString();
}

const gitlabCheckout = {
  id: 'gitlab',
  changeName: 'MR',
  remoteUrl: gitlabRemoteUrl,
  sparsePaths: ['.gitlab-ci.yml', '.gitlab/**', '.issue-flow/**', '.agentrix/plugins/issue-flow/**'],
  paths: ['.gitlab-ci.yml', '.gitlab', '.issue-flow', '.agentrix/plugins/issue-flow'],
  async createChange(input) {
    const result = await createGitlabMergeRequest({
      ...input,
      title: input.mergeRequestTitle || 'Install issue-flow plugin',
      description: input.mergeRequestDescription || [
        `${input.operation === 'upgrade' ? 'Upgrades' : 'Installs'} issue-flow plugin files.`,
        '',
        'Merge this request, then issue-flow will refresh the plugin status from .issue-flow/install-manifest.json.',
      ].join('\n'),
      removeSourceBranch: true,
    })
    return { id: String(result.id || ''), iid: String(result.iid || ''), webUrl: result.web_url || result.webUrl || '' }
  },
}

export function installGitlabPluginMergeRequest(input = {}) {
  return installPluginChange(input, gitlabCheckout)
}
