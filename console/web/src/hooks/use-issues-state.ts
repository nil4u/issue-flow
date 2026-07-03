import { useCallback, useRef, useState } from "react"

import { api, type IssueRow } from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

export function useIssuesState() {
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [loadingIssues, setLoadingIssues] = useState(false)
  const autoSyncedRepoIds = useRef(new Set<string>())

  const loadIssues = useCallback(async (repoId?: string) => {
    if (!repoId) {
      setIssues([])
      return []
    }
    const body = await api<{ issues: IssueRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/issues`)
    const nextIssues = body.issues || []
    setIssues(nextIssues)
    return nextIssues
  }, [])

  const syncIssues = useCallback(async (repoId?: string) => {
    if (!repoId) return []
    setLoadingIssues(true)
    try {
      const body = await api<{ issues: IssueRow[] }>(`/api/repositories/${encodeURIComponent(repoId)}/issues/sync`, {
        method: "POST",
      })
      const nextIssues = body.issues || []
      setIssues(nextIssues)
      return nextIssues
    } catch (error) {
      notifyError(error, "同步 issues 失败")
      return []
    } finally {
      setLoadingIssues(false)
    }
  }, [])

  const markAutoSynced = useCallback((repoId: string) => {
    autoSyncedRepoIds.current.add(repoId)
  }, [])

  const hasAutoSynced = useCallback((repoId: string) => autoSyncedRepoIds.current.has(repoId), [])

  return {
    issues,
    loadingIssues,
    loadIssues,
    syncIssues,
    hasAutoSynced,
    markAutoSynced,
  }
}
