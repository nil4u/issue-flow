import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { gitConnectionPresentation, type GitConnection } from '@/lib/git-connection'

type Props = { connection?: GitConnection; onAuthorize: () => void; onSync: () => void; onConnect: () => void }

export function GithubRepositoryEmpty({ connection, onAuthorize, onSync, onConnect }: Props) {
  const view = gitConnectionPresentation('github', true, connection)
  const description = {
    checking: '正在确认可访问的 GitHub 仓库…',
    needs_authorization: '账号已登录，还需要选择允许 Console 访问的仓库。',
    no_repositories: 'App 已安装，当前账号没有可见仓库。请选择仓库或确认组织授权。',
    suspended: 'App 授权已暂停，请在 GitHub 恢复授权。',
    sync_failed: '暂时无法同步仓库，请重试。',
    needs_login: 'GitHub 登录已过期，请重新登录。',
    connected: '仓库已同步，正在加载列表。也可以重新同步。',
  }[connection?.status || 'checking']
  const act = view.action === 'connect' ? onConnect : view.action === 'authorize' ? onAuthorize : onSync
  return <div className="github-repository-empty" role="status">
    <strong>{view.busy ? <><Loader2 className="size-4 animate-spin" />正在同步</> : 'GitHub 仓库'}</strong>
    <p>{description}</p>
    {!view.busy && <Button size="sm" onClick={act}>{view.button === '授权仓库' ? '授权 GitHub 仓库' : view.button}</Button>}
  </div>
}
