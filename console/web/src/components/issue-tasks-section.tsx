import { useEffect, useState } from "react"
import { AlertCircle, Bot, Loader2 } from "lucide-react"

import { api, type IssueTaskList } from "@/issue-flow-model"
import { agentrixTaskLabel, agentrixTaskUrl } from "@/lib/agentrix-task"

type LoadState = { key: string; status: "ready" | "error"; result?: IssueTaskList }

// Sidebar section shared by issue and MR details. It loads tasks on its own
// so a failure here never blocks the rest of the detail page.
export function IssueTasksSection({ gitServerId, projectId, issueNumber }: { gitServerId: string; projectId: string; issueNumber: number }) {
  const endpoint = issueNumber > 0 ? `/api/issues/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/${issueNumber}/tasks` : ""
  const [state, setState] = useState<LoadState>()

  useEffect(() => {
    if (!endpoint) return
    const controller = new AbortController()
    void api<IssueTaskList>(endpoint, { signal: controller.signal })
      .then((result) => setState({ key: endpoint, status: "ready", result }))
      .catch(() => { if (!controller.signal.aborted) setState({ key: endpoint, status: "error" }) })
    return () => controller.abort()
  }, [endpoint])

  const current = state?.key === endpoint ? state : undefined
  return (
    <section className="issue-tasks-section" aria-label="Tasks">
      <strong>Tasks</strong>
      {!endpoint ? <p>No linked tasks</p>
        : !current ? <p className="issue-tasks-state" role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden="true" />Loading tasks…</p>
        : current.status === "error" ? <p className="issue-tasks-state" role="alert"><AlertCircle className="size-3.5" aria-hidden="true" />Unable to load tasks</p>
        : !current.result?.tasks.length ? <p>No linked tasks</p>
        : (
          <ul className="issue-tasks-list">
            {current.result.tasks.map((task) => {
              const label = agentrixTaskLabel(task)
              const href = agentrixTaskUrl(current.result?.agentrixBaseUrl || "", task.taskId)
              const tooltip = `${label} (${task.taskId})`
              return (
                <li key={task.taskId}>
                  <Bot className="size-3.5" aria-hidden="true" />
                  {href
                    ? <a href={href} target="_blank" rel="noopener noreferrer" title={tooltip}>{label}</a>
                    : <span title={tooltip}>{label}</span>}
                  {task.action ? <small>{task.action}</small> : null}
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
