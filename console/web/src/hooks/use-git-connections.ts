import { useCallback, useEffect, useRef, useState } from 'react'
import { api, API_BASE_URL, type GitServer, type UserSession } from '@/issue-flow-model'
import { githubAuthorizationPath, type GitConnection, type GitConnections } from '@/lib/git-connection'

type PendingSync = { controller: AbortController; promise: Promise<GitConnection | undefined> }

export function useGitConnections(userSession: UserSession, gitServers: GitServer[], onSynced: (id: string) => Promise<unknown>) {
  const [connections, setConnections] = useState<GitConnections>({})
  const pending = useRef(new Map<string, PendingSync>())
  const onSyncedRef = useRef(onSynced)
  useEffect(() => { onSyncedRef.current = onSynced }, [onSynced])
  const linkedIds = (userSession.accounts || []).map((item) => item.account?.gitServerId || item.gitServer?.id || item.session?.gitServerId || '')
  const ids = gitServers.filter((server) => server.type === 'github' && linkedIds.includes(server.id)).map((server) => server.id)
  const accountKey = JSON.stringify({ user: userSession.user && 'id' in userSession.user ? userSession.user.id : '', ids: userSession.authenticated ? ids : [] })

  const sync = useCallback((id: string): Promise<GitConnection | undefined> => {
    const current = pending.current.get(id)
    if (current) return current.promise
    const controller = new AbortController()
    setConnections((value) => ({ ...value, [id]: { ...value[id], status: 'checking' } }))
    const promise = (async () => {
      try {
        const result = await api<{ connection: GitConnection }>('/api/github/projects', { method: 'POST', body: JSON.stringify({ gitServerId: id }), signal: controller.signal })
        if (controller.signal.aborted) return
        setConnections((value) => ({ ...value, [id]: result.connection }))
        await onSyncedRef.current(id)
        return result.connection
      } catch (error) {
        if (controller.signal.aborted) return
        const needsLogin = error instanceof Error && /login_required|unauthorized|HTTP_?401/i.test(error.message)
        const connection: GitConnection = { status: needsLogin ? 'needs_login' : 'sync_failed' }
        setConnections((value) => ({ ...value, [id]: connection }))
        return connection
      } finally {
        if (pending.current.get(id)?.controller === controller) pending.current.delete(id)
      }
    })()
    pending.current.set(id, { controller, promise })
    return promise
  }, [])

  useEffect(() => {
    const activeIds: string[] = JSON.parse(accountKey).ids
    setConnections({})
    const refresh = () => {
      if (document.visibilityState === 'visible') activeIds.forEach((id) => { void sync(id) })
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const requests = pending.current
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      requests.forEach(({ controller }) => controller.abort())
      requests.clear()
    }
  }, [accountKey, sync])

  function authorize(id: string) {
    window.location.assign(`${API_BASE_URL}${githubAuthorizationPath(id, `${window.location.pathname}${window.location.search}`)}`)
  }

  return { connections, sync, authorize }
}
