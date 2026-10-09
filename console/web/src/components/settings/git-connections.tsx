import { useState } from 'react'
import { Check, GitBranch, Link2, Loader2, MoreHorizontal, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { GitServer, UserGitAccount } from '@/issue-flow-model'
import { gitConnectionPresentation, type GitConnections } from '@/lib/git-connection'

type Props = {
  servers: GitServer[]
  accounts: Map<string, UserGitAccount | undefined>
  connections: GitConnections
  pendingId: string
  onConnect: (id: string) => void
  onAuthorize: (id: string) => void
  onSync: (id: string) => Promise<unknown>
}

export function GitConnectionsGroup(props: Props) {
  const ready = props.servers.filter((server) => gitConnectionPresentation(server.type, props.accounts.has(server.id), props.connections[server.id]).ready).length
  return <div className="account-group">
    <header><strong>Git 账号与仓库</strong><span>已就绪 {ready} / {props.servers.length}</span></header>
    <div className="account-list">
      {props.servers.map((server) => <ConnectionRow key={server.id} {...props} server={server} />)}
      {!props.servers.length && <div className="account-empty">还没有配置 Git server</div>}
    </div>
  </div>
}

function ConnectionRow({ server, accounts, connections, pendingId, onConnect, onAuthorize, onSync }: Props & { server: GitServer }) {
  const [syncing, setSyncing] = useState(false)
  const account = accounts.get(server.id)
  const linked = accounts.has(server.id)
  const view = gitConnectionPresentation(server.type, linked, connections[server.id])
  const busy = syncing || view.busy || pendingId === server.id
  const title = account?.displayName || account?.username || server.name || server.id
  async function sync() {
    setSyncing(true)
    try { await onSync(server.id) } finally { setSyncing(false) }
  }
  const act = () => {
    if (view.action === 'connect') onConnect(server.id)
    else if (view.action === 'authorize') onAuthorize(server.id)
    else void sync()
  }
  return <div className="account-row git-connection-row">
    <span className="account-provider-icon"><GitBranch className={`size-4 ${server.type === 'github' ? 'rotate-270' : ''}`} /></span>
    <span className="account-row-copy"><strong>{title}</strong><small>{server.name || server.id} · {account?.username ? `@${account.username}` : server.type}</small></span>
    <span className={`account-status ${view.tone}`} role="status" aria-live="polite">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : view.ready ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
      {pendingId === server.id ? '正在连接…' : syncing ? '正在同步仓库…' : view.text}
    </span>
    <div className="git-connection-actions">
      <Button size="sm" variant={view.ready ? 'outline' : 'default'} disabled={busy} onClick={act}>{pendingId === server.id ? '连接中' : syncing ? '同步中' : view.button}</Button>
      {linked && <DropdownMenu>
        <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`${server.name || server.id} 更多操作`} disabled={busy}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {server.type === 'github' && <DropdownMenuItem onSelect={() => { void sync() }}><RefreshCw />同步仓库</DropdownMenuItem>}
          <DropdownMenuItem onSelect={() => onConnect(server.id)}><Link2 />重新关联账号</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
  </div>
}
