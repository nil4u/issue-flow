import { AlertCircle, ExternalLink, RefreshCw, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useActionExecution } from "@/hooks/use-action-execution"
import {
  actionExecutionMessages,
  actionExecutionEditable,
  actionFieldPlaceholder,
  actionValuesChanged,
} from "@/lib/action-execution"
import type {
  ActionExecutionValues,
  RepoWorkspaceProps,
} from "@/issue-flow-model"

type Props = Pick<
  RepoWorkspaceProps,
  "gitServer" | "project" | "repository" | "tab"
>
const actionLabels: Record<string, string> = {
  defaults: "默认",
  triage: "Triage",
  plan: "Plan",
  build: "Build",
  review: "Review",
  general: "General",
}
const fieldLabels: Record<keyof ActionExecutionValues, string> = {
  agent: "Agent",
  model: "模型",
  reasoningEffort: "推理强度",
}

export function ActionExecutionSettings({
  gitServer,
  project,
  repository,
  tab,
}: Props) {
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
  const pending = snapshot?.pendingMergeRequest

  return (
    <section className="check-group action-execution-settings">
      <header>
        <strong>Agent Customize</strong>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="刷新执行配置"
          title="刷新"
          onClick={execution.reload}
          disabled={busy}
        >
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </header>
      {pending && (
        <div className="check-table-row needs_action" role="status">
          <div className="check-row-main">
            <span className="check-status-icon">
              <AlertCircle className="size-4" />
            </span>
            <span className="check-row-copy">
              <strong>MR !{pending.iid} 待合并</strong>
              <small>配置合并后生效</small>
            </span>
            <div className="check-row-upgrade">
              <Button asChild size="sm" variant="secondary">
                <a href={pending.webUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  去合并
                </a>
              </Button>
            </div>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="action-execution-notice text-destructive">
          {error}
        </p>
      )}
      {snapshot && snapshot.state !== "ready" && (
        <p role="alert" className="action-execution-notice text-destructive">
          {actionExecutionMessages[snapshot.state] || "请刷新配置。"}
        </p>
      )}
      {snapshot?.refreshError && (
        <p role="alert" className="action-execution-notice text-destructive">
          MR 状态刷新失败，请重试。
        </p>
      )}
      {!snapshot && !error && (
        <p role="status" className="action-execution-notice">
          加载中…
        </p>
      )}
      {snapshot?.state === "ready" && (
        <>
          <div className="action-execution-scroll">
            <table className="action-execution-table">
              <thead>
                <tr>
                  <th scope="col">环节</th>
                  {snapshot.fields.map((field) => (
                    <th scope="col" key={field}>
                      {fieldLabels[field]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snapshot.actionNames.map((action) => (
                  <tr key={action}>
                    <th scope="row">{actionLabels[action] || action}</th>
                    {snapshot.fields.map((field) => {
                      const value = draft[action]?.[field] || ""
                      const placeholder = actionFieldPlaceholder(
                        action,
                        field,
                        draft
                      )
                      const label = `${actionLabels[action] || action} ${fieldLabels[field]}`
                      const update = (next: string) =>
                        setDraft((current) => ({
                          ...current,
                          [action]: { ...current[action], [field]: next },
                        }))
                      return (
                        <td key={field}>
                          {field === "reasoningEffort" ? (
                            <Select
                              value={value || "inherit"}
                              disabled={!editable}
                              onValueChange={(next) =>
                                update(next === "inherit" ? "" : next)
                              }
                            >
                              <SelectTrigger
                                aria-label={label}
                                className={`w-full ${!value ? "text-muted-foreground" : ""}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="inherit">
                                  {placeholder}
                                </SelectItem>
                                {snapshot.reasoningEfforts.map((effort) => (
                                  <SelectItem key={effort} value={effort}>
                                    {effort}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <div className="action-execution-input">
                              <Input
                                aria-label={label}
                                value={value}
                                disabled={!editable}
                                placeholder={placeholder}
                                onChange={(event) => update(event.target.value)}
                                className={value ? "pr-7" : undefined}
                              />
                              {value && editable && (
                                <button
                                  type="button"
                                  aria-label={`清除 ${label} 覆盖`}
                                  title="清除覆盖"
                                  onClick={() => update("")}
                                >
                                  <X className="size-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!pending && (
            <footer className="action-execution-footer">
              <span>
                {!canManage
                  ? "只读 · 需要 Maintainer 权限"
                  : "留空继承默认值 · 合并后生效"}
              </span>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void execution.save()}
                  disabled={!editable || !dirty || !valid}
                >
                  提交 MR
                </Button>
              )}
            </footer>
          )}
        </>
      )}
    </section>
  )
}
