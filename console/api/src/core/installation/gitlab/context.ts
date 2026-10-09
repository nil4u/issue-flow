// @ts-nocheck
import { getGitlabCurrentUser, getGitlabProjectForInstall, getGitlabProjectMember, getGitlabMergeRequest, getGitlabRepositoryFile, listGitlabProjects } from '../../gitlab.js'
import { resolveGitServer, sessionToken } from '../../common.js'
import { mergeAgentrixInstallInput, savedAgentrixDefaults } from '../../user-agentrix-config.js'
import { ISSUE_FLOW_MANIFEST_PATH } from '../../issue-flow-plugin.js'



function gitlabRoleFromAccessLevel(accessLevel = 0) {
  if (accessLevel >= 50) return 'Owner';
  if (accessLevel >= 40) return 'Maintainer';
  if (accessLevel >= 30) return 'Developer';
  if (accessLevel >= 20) return 'Reporter';
  if (accessLevel >= 10) return 'Guest';
  return 'No access';
}

async function resolveGitlabProjectAccess({ project, apiInput, user } = {}) {
  let accessLevel = Number(project && project.accessLevel || 0);
  let accessLevelKnown = Boolean(project && project.accessLevelKnown);
  if ((!accessLevelKnown || accessLevel < 40) && user && user.id) {
    const member = await getGitlabProjectMember({
      ...apiInput,
      userId: user.id,
    });
    if (member && (member.access_level !== undefined || member.accessLevel !== undefined)) {
      accessLevel = Math.max(accessLevel, Number(member.access_level || member.accessLevel || 0));
      accessLevelKnown = true;
    }
  }
  return {
    accessLevel,
    accessLevelKnown,
    role: gitlabRoleFromAccessLevel(accessLevel),
    canManage: accessLevelKnown && accessLevel >= 40,
  };
}

async function gitlabInstallContext({ store, input = {}, session, env = process.env, logger = undefined }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const projectIdOrPath = input.projectId || input.projectPath || '';
  if (!token) {
    const error = new Error('gitlab_login_required');
    error.status = 401;
    error.code = 'gitlab_login_required';
    throw error;
  }
  const user = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType,
    logger,
  });
  if (user.status !== 'valid') {
    const error = new Error('gitlab_login_required');
    error.status = 401;
    error.code = 'gitlab_login_required';
    error.validation = user;
    throw error;
  }
  if (!projectIdOrPath) {
    const error = new Error('project_required');
    error.status = 400;
    error.code = 'project_required';
    throw error;
  }
  const project = await getGitlabProjectForInstall({
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath,
    logger,
  });
  const existing = await store.findRepositoryByProject({
    gitServerId: server.id,
    projectId: project.id,
    projectPath: project.pathWithNamespace,
  });
  // 安装流程要求已登录,session 是真正的 git 凭证,userId 必有。
  const defaults = await savedAgentrixDefaults(store, session && session.userId || '', env);
  let agentrixDefaults = defaults;
  if (existing) {
    agentrixDefaults = {
      automation: {
        ...(defaults.automation || {}),
        ...(existing.automation || {}),
      },
      agentrix: {
        ...(defaults.agentrix || {}),
        ...(existing.agentrix || {}),
        apiKey: defaults.agentrix && defaults.agentrix.apiKey || '',
      },
    };
  }
  const installConfig = mergeAgentrixInstallInput(input, agentrixDefaults, env);
  const apiInput = {
    apiUrl: config.apiUrl,
    token,
    authType,
    projectIdOrPath: project.id || project.pathWithNamespace,
    projectPath: project.pathWithNamespace,
    logger,
  };
  return {
    server,
    config,
    user,
    token,
    authType,
    project,
    existing,
    installConfig,
    apiInput,
  };
}

async function listGitlabProjectsWithInstallStatus({ store, input = {}, session, logger = undefined }) {
  const { server, config } = await resolveGitServer(store, input, session, 'gitlab');
  const token = sessionToken(input, session);
  const authType = input.token ? config.tokenAuth : 'bearer';
  const user = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token,
    authType,
    logger,
  });
  if (user.status !== 'valid') {
    return { status: 401, body: { error: 'gitlab_login_required', validation: user } };
  }
  const projects = await listGitlabProjects({
    apiUrl: config.apiUrl,
    token,
    authType,
    logger,
  });
  await store.syncRepositories({
    gitServerId: server.id,
    userId: input.userId || session && session.userId || '',
    projects,
  });
  return {
    status: 200,
    body: {
      projects: projects.map((project) => ({
        ...project,
        canInstall: Boolean(project.canInstall),
      })),
    },
  };
}

async function getGitlabProjectRole({ store, input = {}, session, env = process.env, logger = undefined }) {
  try {
    const { server, project, apiInput, user } = await gitlabInstallContext({ store, input, session, env, logger });
    const access = await resolveGitlabProjectAccess({ project, apiInput, user });
    return {
      status: 200,
      body: {
        gitServer: { id: server.id, name: server.name },
        project,
        access,
      },
    };
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_project_role_failed',
        validation: error && error.validation || undefined,
        detail: error && error.message || '',
      },
    };
  }
}

function decodeGitlabFile(file) {
  if (!file || file.content === undefined || file.content === null) return ''
  if (file.encoding === 'base64' || !file.encoding) {
    return Buffer.from(String(file.content || ''), 'base64').toString('utf8')
  }
  return String(file.content || '')
}

async function openPendingMergeRequest(apiInput, pending) {
  if (!pending || !pending.iid) return false
  const mergeRequest = await getGitlabMergeRequest({
    ...apiInput,
    iid: pending.iid,
  })
  return Boolean(mergeRequest && String(mergeRequest.state || '').toLowerCase() === 'opened')
}

async function readGitlabIssueFlowManifest(apiInput, branch) {
  const file = await getGitlabRepositoryFile({
    ...apiInput,
    filePath: ISSUE_FLOW_MANIFEST_PATH,
    ref: branch,
  })
  if (!file) return undefined
  const content = decodeGitlabFile(file)
  return JSON.parse(content)
}

export { gitlabRoleFromAccessLevel, resolveGitlabProjectAccess, gitlabInstallContext, listGitlabProjectsWithInstallStatus, getGitlabProjectRole, openPendingMergeRequest, readGitlabIssueFlowManifest }
