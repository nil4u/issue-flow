export type GitConnectionStatus = 'checking' | 'connected' | 'needs_authorization' | 'no_repositories' | 'suspended' | 'sync_failed' | 'needs_login'
export type GitConnection = { status: GitConnectionStatus; repositoryCount?: number; installationCount?: number }
export type GitConnections = Record<string, GitConnection | undefined>
export type ConnectionAction = 'connect' | 'authorize' | 'sync'

export function gitConnectionPresentation(provider: string, linked: boolean, connection?: GitConnection) {
  if (!['github', 'gitlab'].includes(provider)) return { text: '暂不支持', button: '待支持', action: 'connect' as ConnectionAction, ready: false, busy: true, tone: '' }
  if (!linked) return { text: '尚未连接', button: provider === 'github' ? '连接 GitHub' : '连接 GitLab', action: 'connect' as ConnectionAction, ready: false, busy: false, tone: '' }
  if (provider === 'gitlab') return { text: '已连接', button: '同步仓库', action: 'sync' as ConnectionAction, ready: true, busy: false, tone: 'connected' }
  const state = connection?.status || 'checking'
  const states = {
    checking: { text: '正在同步仓库…', button: '同步中', action: 'sync', ready: false, busy: true, tone: '' },
    connected: { text: `已连接 · ${connection?.repositoryCount ?? 0} 个仓库`, button: '管理仓库授权', action: 'authorize', ready: true, busy: false, tone: 'connected' },
    needs_authorization: { text: '已登录 · 待授权仓库', button: '授权仓库', action: 'authorize', ready: false, busy: false, tone: 'pending' },
    no_repositories: { text: '已授权 · 无可见仓库', button: '选择仓库', action: 'authorize', ready: false, busy: false, tone: 'pending' },
    suspended: { text: 'App 授权已暂停', button: '管理仓库授权', action: 'authorize', ready: false, busy: false, tone: 'pending' },
    sync_failed: { text: '仓库同步失败', button: '重试', action: 'sync', ready: false, busy: false, tone: 'failed' },
    needs_login: { text: '登录已过期', button: '重新登录', action: 'connect', ready: false, busy: false, tone: 'pending' },
  } as const
  return states[state]
}

export function githubAuthorizationPath(gitServerId: string, returnTo: string) {
  return `/api/auth/github/install?${new URLSearchParams({ gitServerId, returnTo })}`
}
