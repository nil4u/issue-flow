import { useEffect, useMemo, useState } from "react"
import { Loader2, Wrench } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { InstallConflict, InstallConflictAction, RepoWorkspaceProps } from "@/issue-flow-model"

const conflictCategoryLabels: Record<InstallConflict["category"], string> = {
  gitlab_ci: "GitLab CI",
  user_customizations: "用户自定义",
  managed: "Installer 管理文件",
  stale: "过期文件",
}

const conflictActionLabels: Record<InstallConflictAction, string> = {
  overwrite: "使用新版本",
  keep: "保留当前",
  remove: "删除文件",
  forget: "仅忘记记录",
  use_proposed: "使用建议",
  keep_current: "保留当前",
}

const conflictReasonLabels: Record<string, string> = {
  modified: "本地与上游同时修改",
  untracked: "存在未跟踪的本地文件",
  "stale-modified": "已修改且不再由安装器生成",
  missing_issue_flow_include: "根 CI 缺少 issue-flow include",
  complex_include: "include 结构复杂，需手动处理",
}

export function InstallConflictWizard({
  checking,
  plan,
  onCancel,
  onConfirm,
}: {
  checking: boolean
  plan?: RepoWorkspaceProps["installConflictPlan"]
  onCancel: () => void
  onConfirm: RepoWorkspaceProps["onConfirmInstallConflicts"]
}) {
  const [actions, setActions] = useState<Record<string, InstallConflictAction>>({})

  useEffect(() => {
    const defaults: Record<string, InstallConflictAction> = {}
    for (const conflict of plan?.conflicts || []) {
      defaults[conflict.id] = conflict.defaultAction
    }
    setActions(defaults)
  }, [plan?.fingerprint])

  const groups = useMemo(() => {
    const byCategory = new Map<InstallConflict["category"], InstallConflict[]>()
    for (const conflict of plan?.conflicts || []) {
      byCategory.set(conflict.category, [...(byCategory.get(conflict.category) || []), conflict])
    }
    return Array.from(byCategory.entries())
  }, [plan])

  function setCategoryAction(category: InstallConflict["category"], action: InstallConflictAction) {
    setActions((current) => {
      const next = { ...current }
      for (const conflict of plan?.conflicts || []) {
        if (conflict.category === category && conflict.allowedActions.includes(action)) {
          next[conflict.id] = action
        }
      }
      return next
    })
  }

  async function confirm() {
    if (!plan) return
    await onConfirm({
      fingerprint: plan.fingerprint,
      actions,
    })
  }

  return (
    <Dialog open={Boolean(plan)} onOpenChange={(open) => {
      if (!open && !checking) onCancel()
    }}>
      <DialogContent className="install-conflict-dialog">
        <DialogHeader>
          <DialogTitle>确认安装冲突</DialogTitle>
        </DialogHeader>
        <div className="install-conflict-body">
          {groups.map(([category, conflicts]) => (
            <section className="install-conflict-category" key={category}>
              <header>
                <div>
                  <strong>{conflictCategoryLabels[category]}</strong>
                  <span>{conflicts.length} 个冲突</span>
                </div>
                <ConflictBatchActions
                  category={category}
                  onDefault={() => {
                    setActions((current) => {
                      const next = { ...current }
                      for (const conflict of conflicts) next[conflict.id] = conflict.defaultAction
                      return next
                    })
                  }}
                  onSetAction={(action) => setCategoryAction(category, action)}
                />
              </header>
              <div className="install-conflict-list">
                {conflicts.map((conflict) => (
                  <ConflictRow
                    action={actions[conflict.id] || conflict.defaultAction}
                    conflict={conflict}
                    key={conflict.id}
                    onAction={(action) => setActions((current) => ({ ...current, [conflict.id]: action }))}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="install-conflict-actions">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={checking}>取消</Button>
          <Button type="button" onClick={confirm} disabled={checking}>
            {checking ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
            继续安装
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConflictBatchActions({
  category,
  onDefault,
  onSetAction,
}: {
  category: InstallConflict["category"]
  onDefault: () => void
  onSetAction: (action: InstallConflictAction) => void
}) {
  return (
    <div className="install-conflict-batch">
      {category === "user_customizations" && (
        <>
          <Button type="button" size="sm" variant="secondary" onClick={() => onSetAction("keep")}>全部保留</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => onSetAction("overwrite")}>全部覆盖</Button>
        </>
      )}
      {category === "managed" && (
        <>
          <Button type="button" size="sm" variant="secondary" onClick={() => onSetAction("overwrite")}>全部用新版本</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => onSetAction("keep")}>全部保留</Button>
        </>
      )}
      {category === "stale" && (
        <>
          <Button type="button" size="sm" variant="secondary" onClick={onDefault}>推荐处理</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => onSetAction("forget")}>全部保留</Button>
        </>
      )}
    </div>
  )
}

function ConflictRow({
  action,
  conflict,
  onAction,
}: {
  action: InstallConflictAction
  conflict: InstallConflict
  onAction: (action: InstallConflictAction) => void
}) {
  return (
    <div className="install-conflict-row">
      <div className="install-conflict-main">
        <strong>{conflict.path}</strong>
        <span>{conflictReasonLabels[conflict.reason] || conflict.reason}</span>
        {conflict.message && <p>{conflict.message}</p>}
        {conflict.category === "gitlab_ci" && action === "keep_current" && (
          <p className="install-conflict-warning">保留当前内容后，根 CI 不会引入 issue-flow，CI 任务将保持未启用。</p>
        )}
        {conflict.category === "gitlab_ci" && conflict.currentContent !== undefined && (
          <div className="install-conflict-diff">
            <figure>
              <figcaption>当前</figcaption>
              <pre>{conflict.currentContent}</pre>
            </figure>
            {conflict.proposedContent !== undefined && (
              <figure>
                <figcaption>建议</figcaption>
                <pre>{conflict.proposedContent}</pre>
              </figure>
            )}
          </div>
        )}
      </div>
      <select
        aria-label={`${conflict.path} action`}
        value={action}
        onChange={(event) => onAction(event.target.value as InstallConflictAction)}
      >
        {conflict.allowedActions.map((item) => (
          <option key={item} value={item}>{conflictActionLabels[item]}</option>
        ))}
      </select>
    </div>
  )
}
