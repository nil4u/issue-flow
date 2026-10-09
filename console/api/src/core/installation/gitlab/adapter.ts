// @ts-nocheck
import { publicIssueFlowBaseUrl } from '../config.js'
import { gitlabInstallContext, resolveGitlabProjectAccess, openPendingMergeRequest, readGitlabIssueFlowManifest } from './context.js'
import { checkGitlabAdminPatPermission, setGitlabProjectInstallPermission } from './permissions.js'
import { checkWebhook, setGitlabProjectInstallWebhook } from './webhook.js'
import { checkVariables, setGitlabProjectInstallVariable } from './variables.js'
import { checkGitlabIssueFlowLabels, setGitlabProjectInstallLabels } from './labels.js'
import { checkRunners, setGitlabProjectInstallRunner } from './runners.js'
import { checkPlugin } from '../plugin.js'
import { installGitlabPluginMergeRequest } from '../../gitlab-bootstrap.js'

function pluginProvider(context) {
  const { server, config, project, existing, apiInput, basePublicUrl } = context
  const branch = project.defaultBranch || existing?.defaultBranch || 'main'
  return {
    id: 'gitlab',
    isChangeOpen: (pending) => openPendingMergeRequest(apiInput, pending),
    readManifest: () => readGitlabIssueFlowManifest(apiInput, branch),
    install: (input) => installGitlabPluginMergeRequest({
      ...apiInput, ...input, baseUrl: config.baseUrl,
      projectPath: project.pathWithNamespace, gitServerId: server.id, projectId: project.id,
      issueFlowBaseUrl: publicIssueFlowBaseUrl(basePublicUrl, context.env), branch, commitAuthor: config.commitAuthor,
      mergeRequestTitle: input.mergeRequestTitle || `${input.operation === 'upgrade' ? 'Upgrade' : 'Install'} issue-flow plugin`,
    }),
  }
}

export const gitlabInstaller = {
  id: 'gitlab',
  context: gitlabInstallContext,
  access: resolveGitlabProjectAccess,
  plugin: pluginProvider,
  steps: [
    { id: 'permissions', label: 'Permissions', check: checkGitlabAdminPatPermission, configure: setGitlabProjectInstallPermission, stopWhenBlocked: true },
    { id: 'webhook', label: 'Webhook', check: checkWebhook, configure: setGitlabProjectInstallWebhook },
    { id: 'variables', label: 'Variables', check: checkVariables, configure: setGitlabProjectInstallVariable },
    { id: 'labels', label: 'Labels', check: checkGitlabIssueFlowLabels, configure: setGitlabProjectInstallLabels },
    { id: 'runners', label: 'GitLab Runner', check: checkRunners, configure: setGitlabProjectInstallRunner },
    { id: 'plugins', label: 'Plugins', check: (context) => checkPlugin({ ...context, provider: pluginProvider(context) }) },
  ],
}
