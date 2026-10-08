import { useCallback, useEffect, useState } from "react"
import {
  api,
  type ActionExecutionResult,
  type ActionExecutionSnapshot,
  type ActionExecutionValues,
} from "@/issue-flow-model"
import {
  actionExecutionMessages,
  normalizedActionValues,
} from "@/lib/action-execution"

export function useActionExecution(
  gitServerId: string,
  projectId: string,
  enabled: boolean
) {
  const [snapshot, setSnapshot] = useState<ActionExecutionSnapshot>()
  const [draft, setDraft] = useState<Record<string, ActionExecutionValues>>({})
  const [canManage, setCanManage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const pending = !!snapshot?.pendingMergeRequest

  useEffect(() => {
    if (!enabled || !gitServerId || !projectId) return
    const controller = new AbortController()
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return
        setBusy(true)
        setError("")
        return api<ActionExecutionResult>("/api/gitlab/action-execution/read", {
          method: "POST",
          body: JSON.stringify({ gitServerId, projectId }),
          signal: controller.signal,
        })
      })
      .then((result) => {
        if (!result || controller.signal.aborted) return
        setSnapshot(result.actionExecution)
        setDraft(result.actionExecution.explicit || {})
        setCanManage(result.access.canManage === true)
      })
      .catch((failure: Error) => {
        if (!controller.signal.aborted)
          setError(
            actionExecutionMessages[failure.message] ||
              "加载执行配置失败，请重试。"
          )
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [gitServerId, projectId, enabled, refresh])

  useEffect(() => {
    if (!enabled || !pending) return
    const timer = window.setInterval(
      () => setRefresh((value) => value + 1),
      30_000
    )
    return () => window.clearInterval(timer)
  }, [enabled, pending])

  const save = useCallback(async () => {
    if (!snapshot || busy || !canManage || pending) return
    setBusy(true)
    setError("")
    try {
      const result = await api<ActionExecutionResult>(
        "/api/gitlab/action-execution/submit",
        {
          method: "POST",
          body: JSON.stringify({
            gitServerId,
            projectId,
            baseRevision: snapshot.revision,
            actions: normalizedActionValues(draft),
          }),
        }
      )
      setSnapshot(result.actionExecution)
      setDraft(result.actionExecution.explicit || {})
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : ""
      setError(
        actionExecutionMessages[message] || "提交配置 MR 失败，请刷新后重试。"
      )
    } finally {
      setBusy(false)
    }
  }, [snapshot, busy, canManage, pending, gitServerId, projectId, draft])

  return {
    snapshot,
    draft,
    setDraft,
    busy,
    canManage,
    error,
    save,
    reload: () => setRefresh((value) => value + 1),
  }
}
