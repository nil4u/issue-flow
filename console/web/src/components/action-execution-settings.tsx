import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useActionExecution } from "@/hooks/use-action-execution"
import {
  actionExecutionMessages,
  actionExecutionEditable,
  actionFieldPlaceholder,
  actionValuesChanged,
} from "@/lib/action-execution"
import type { RepoWorkspaceProps } from "@/issue-flow-model"

export function ActionExecutionSettings({
  gitServer,
  project,
  repository,
  tab,
}: RepoWorkspaceProps) {
  const execution = useActionExecution(
    gitServer?.id || project?.gitServerId || "",
    project?.id || "",
    tab === "settings" && !!repository
  )
  const { snapshot, draft, setDraft, busy, canManage, error } = execution
  if (!project || !repository) return null
  const editable = actionExecutionEditable(snapshot, canManage, busy, error)
  const dirty =
    snapshot?.explicit && actionValuesChanged(draft, snapshot.explicit)
  const valid =
    snapshot &&
    Object.values(draft).every(
      (values) =>
        !values.reasoningEffort ||
        snapshot.reasoningEfforts.includes(values.reasoningEffort)
    )

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold">Issue Flow 执行配置</h3>
        <Button variant="outline" onClick={execution.reload} disabled={busy}>
          刷新配置
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        编辑显式覆盖；留空表示继承 defaults，defaults
        留空由运行时决定。显式运行参数优先于仓库配置。配置 MR
        合并后仅影响新任务，不改变运行中或续跑任务。
      </p>
      {busy && <p role="status">正在读取或提交配置…</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {snapshot && snapshot.state !== "ready" && (
        <p role="alert">
          {actionExecutionMessages[snapshot.state] || "配置需要刷新。"}{" "}
          {snapshot.detail}
        </p>
      )}
      {snapshot?.refreshError && (
        <p role="alert">待合并 MR 状态刷新失败；保留待审状态，请重试。</p>
      )}
      {!canManage && snapshot && (
        <p className="text-sm text-muted-foreground">
          只读：需要 Maintainer 或 Owner 权限才能编辑和提交。
        </p>
      )}
      {snapshot?.state === "ready" && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left">环节</th>
                {snapshot.fields.map((field) => (
                  <th key={field} className="p-2 text-left">
                    {field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {snapshot.actionNames.map((action) => (
                <tr key={action}>
                  <th className="p-2 text-left">{action}</th>
                  {snapshot.fields.map((field) => {
                    const placeholder = actionFieldPlaceholder(
                      action,
                      field,
                      draft
                    )
                    const value = draft[action]?.[field] || ""
                    const update = (next: string) =>
                      setDraft((current) => ({
                        ...current,
                        [action]: { ...current[action], [field]: next },
                      }))
                    return (
                      <td key={field} className="min-w-48 p-2 align-top">
                        {field === "reasoningEffort" ? (
                          <select
                            aria-label={`${action} ${field}`}
                            value={value}
                            disabled={!editable}
                            onChange={(event) => update(event.target.value)}
                            className="h-9 w-full rounded-md border bg-background px-2"
                          >
                            <option value="">{placeholder}</option>
                            {snapshot.reasoningEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            aria-label={`${action} ${field}`}
                            value={value}
                            disabled={!editable}
                            placeholder={placeholder}
                            onChange={(event) => update(event.target.value)}
                          />
                        )}
                        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>
                            {value.trim()
                              ? `显式覆盖: ${value.trim()}`
                              : placeholder}
                          </span>
                          <button
                            type="button"
                            disabled={!editable || !value}
                            onClick={() => update("")}
                          >
                            清除覆盖
                          </button>
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {snapshot?.pendingMergeRequest && (
        <p className="text-sm">
          配置{" "}
          <a
            className="underline"
            href={snapshot.pendingMergeRequest.webUrl}
            target="_blank"
            rel="noreferrer"
          >
            MR !{snapshot.pendingMergeRequest.iid}
          </a>{" "}
          待审，合并后生效；当前显示默认分支生效值。
        </p>
      )}
      {snapshot && (
        <p className="text-xs text-muted-foreground">
          {snapshot.branch} · {snapshot.path} · 最近检查 {snapshot.checkedAt}
        </p>
      )}
      <Button
        onClick={() => void execution.save()}
        disabled={!editable || !dirty || !valid}
      >
        提交配置 MR
      </Button>
    </section>
  )
}
