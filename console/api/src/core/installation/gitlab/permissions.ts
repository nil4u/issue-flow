// @ts-nocheck
import { getGitlabCurrentUser, getGitlabProjectMember, upsertGitlabProjectMember } from '../../gitlab.js'
import { sanitizeError } from '../../sanitize.js'
import { gitlabRoleFromAccessLevel, resolveGitlabProjectAccess, gitlabInstallContext } from './context.js'
import { installStep } from '../steps.js'

const ADMIN_PAT_PERMISSION_KEY = 'admin-pat'

function projectMembersUrl(project = {}) {
  const webUrl = String(project.webUrl || project.web_url || '').replace(/\/+$/, '')
  return webUrl ? `${webUrl}/-/project_members` : ''
}

function adminPermissionCache(input = {}) {
  const accessLevel = Number(input.accessLevel || 0)
  return {
    key: ADMIN_PAT_PERMISSION_KEY,
    source: 'gitlab',
    userId: input.userId || '',
    username: input.username || '',
    name: input.name || '',
    email: input.email || '',
    avatarUrl: input.avatarUrl || '',
    accessLevel,
    role: gitlabRoleFromAccessLevel(accessLevel),
    canManage: accessLevel >= 40,
    memberUrl: input.memberUrl || '',
  }
}

function adminPermissionStep(cache) {
  if (!cache) {
    return installStep(
      'permissions',
      'auth',
      'Admin PAT',
      'blocked',
      'Git server 未配置 admin PAT'
    )
  }
  if (cache.canManage) {
    return installStep('permissions', 'auth', 'Admin PAT', 'passed', cache.role, {
      permissions: [cache],
    })
  }
  const account = cache.name || cache.username || cache.email || 'admin PAT 对应账号'
  return installStep(
    'permissions',
    'auth',
    'Admin PAT',
    'blocked',
    `请将 ${account} 加入该 repo 或上级 group，并授予 Maintainer 权限`,
    {
      permissions: [cache],
      memberUrl: cache.memberUrl || '',
    }
  )
}

async function checkGitlabAdminPatPermission({ store, config, project, existing, apiInput }) {
  const memberUrl = projectMembersUrl(project)
  if (!config.adminPat) {
    const cache = adminPermissionCache({ memberUrl })
    if (existing) {
      await store.updateRepositorySettingsCache(existing.id, {
        permissions: { items: [cache], checkedAt: new Date().toISOString() },
      })
    }
    return adminPermissionStep(undefined)
  }
  const adminAuthType = 'private-token'
  const adminUser = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token: config.adminPat,
    authType: adminAuthType,
    logger: apiInput.logger,
  })
  if (adminUser.status !== 'valid') {
    const cache = adminPermissionCache({ memberUrl })
    if (existing) {
      await store.updateRepositorySettingsCache(existing.id, {
        permissions: { items: [cache], checkedAt: new Date().toISOString() },
      })
    }
    return installStep('permissions', 'auth', 'Admin PAT', 'blocked', 'admin PAT 无效或已过期', {
      permissions: [cache],
      memberUrl,
    })
  }
  let accessLevel = 0
  try {
    const member = await getGitlabProjectMember({
      ...apiInput,
      projectIdOrPath: apiInput.projectIdOrPath,
      userId: adminUser.id,
    })
    accessLevel = Math.max(accessLevel, Number(member && (member.access_level || member.accessLevel) || 0))
  } catch {
    accessLevel = 0
  }
  const cache = adminPermissionCache({
    userId: adminUser.id,
    username: adminUser.username,
    name: adminUser.name,
    email: adminUser.email,
    avatarUrl: adminUser.avatarUrl,
    accessLevel,
    memberUrl,
  })
  if (existing) {
    await store.updateRepositorySettingsCache(existing.id, {
      permissions: { items: [cache], checkedAt: new Date().toISOString() },
    })
  }
  return adminPermissionStep(cache)
}

async function setGitlabProjectInstallPermission({ store, input = {}, session, env = process.env, logger = undefined }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env, logger });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_permission_set_failed',
        validation: error && error.validation || undefined,
      },
    };
  }

  const { config, project, existing, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return { status: 403, body: { error: 'gitlab_project_permission_required', access } };
  }
  if (!existing) {
    return { status: 404, body: { error: 'repository_not_found' } };
  }
  if (!config.adminPat) {
    return { status: 400, body: { error: 'git_server_admin_pat_required' } };
  }

  const adminUser = await getGitlabCurrentUser({
    apiUrl: config.apiUrl,
    token: config.adminPat,
    authType: 'private-token',
    logger: apiInput.logger,
  });
  if (adminUser.status !== 'valid' || !adminUser.id) {
    return { status: 400, body: { error: 'git_server_admin_pat_invalid', validation: adminUser } };
  }

  try {
    await upsertGitlabProjectMember({
      ...apiInput,
      userId: adminUser.id,
      accessLevel: 40,
    });
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        error: 'gitlab_admin_member_set_failed',
        detail: sanitizeError(error),
      },
    };
  }

  const step = await checkGitlabAdminPatPermission({ store, config, project, existing, apiInput });
  return {
    status: 200,
    body: {
      repository: await store.getRepository(existing.id),
      access,
      step,
      steps: [step],
      permission: step.permissions && step.permissions[0] || undefined,
      installable: step.status !== 'blocked',
    },
  };
}

export { checkGitlabAdminPatPermission, setGitlabProjectInstallPermission }
