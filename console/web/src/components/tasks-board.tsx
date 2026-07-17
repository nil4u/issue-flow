import { useEffect, useState } from "react"
import {
  AlertCircle,
  Bot,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitMerge,
  ExternalLink,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react"

import { EmptyPanel } from "@/components/empty-panel"
import { Button } from "@/components/ui/button"
import {
  api,
  formatWhen,
  type RepoWorkspaceProps,
  type TaskPage,
  type TaskRow,
} from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

const TASKS_PER_PAGE = 20
const taskStatusTones: Record<string, string> = {
  unknown: "muted",
  succeeded: "success",
  failed: "failed",
  running: "running",
  cancelled: "muted",
}
const emptyPage: TaskPage = {
  tasks: [],
  agentrixBaseUrl: "",
  page: 1,
  perPage: TASKS_PER_PAGE,
  total: 0,
  hasMore: false,
}

export function TasksBoard({
  gitServer,
  user,
  project,
  repository,
  onLogin,
}: RepoWorkspaceProps) {
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<TaskPage>(emptyPage)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const repoId = repository?.id || ""

  useEffect(() => {
    if (!repoId) return
    const controller = new AbortController()
    const query = new URLSearchParams({
      page: String(page),
      perPage: String(TASKS_PER_PAGE),
    })
    void api<TaskPage>(
      `/api/repositories/${encodeURIComponent(repoId)}/tasks?${query}`,
      { signal: controller.signal }
    )
      .then((body) => {
        setResult(body)
        if (page > 1 && body.tasks.length === 0 && body.total > 0)
          setPage(Math.ceil(body.total / body.perPage))
      })
      .catch((error) => {
        if (!controller.signal.aborted) notifyError(error, "加载 tasks 失败")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [page, refreshKey, repoId])

  if (!gitServer)
    return (
      <EmptyPanel
        icon={<GitBranch className="size-6" />}
        title="没有 Git server"
        detail="请先在后台配置 Git server。"
      />
    )
  if (!user) {
    return (
      <EmptyPanel
        icon={<AlertCircle className="size-6" />}
        title="当前 Git server 未连接"
        detail="连接当前 Git server 后查看 task 列表。"
      >
        <Button onClick={onLogin}>
          <GitMerge className="size-4" />
          连接 Git server
        </Button>
      </EmptyPanel>
    )
  }
  if (!project)
    return (
      <EmptyPanel
        icon={<Search className="size-6" />}
        title="选择仓库"
        detail="从左侧列表选择一个 repo。"
      />
    )
  if (!repository)
    return (
      <EmptyPanel
        icon={<ListChecks className="size-6" />}
        title="还没有仓库记录"
        detail="先同步仓库列表后再查看 tasks。"
      />
    )

  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage))

  return (
    <div className="tasks-board">
      <header className="tasks-board-toolbar">
        <div>
          <strong>{result.total} tasks</strong>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setLoading(true)
            setRefreshKey((value) => value + 1)
          }}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          刷新
        </Button>
      </header>

      <TaskTable
        tasks={result.tasks}
        loading={loading}
        agentrixBaseUrl={result.agentrixBaseUrl}
      />

      <footer className="tasks-pagination" aria-label="Task pagination">
        <span>
          第 {result.total === 0 ? 0 : result.page} /{" "}
          {result.total === 0 ? 0 : totalPages} 页
        </span>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoading(true)
              setPage((value) => Math.max(1, value - 1))
            }}
            disabled={loading || page <= 1}
          >
            <ChevronLeft className="size-4" />
            上一页
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setLoading(true)
              setPage((value) => value + 1)
            }}
            disabled={loading || !result.hasMore}
          >
            下一页
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  )
}

function TaskTable({
  tasks,
  loading,
  agentrixBaseUrl,
}: {
  tasks: TaskRow[]
  loading: boolean
  agentrixBaseUrl: string
}) {
  if (loading && tasks.length === 0) {
    return (
      <div className="tasks-list-state">
        <Loader2 className="size-5 animate-spin" />
        正在加载 tasks...
      </div>
    )
  }
  if (tasks.length === 0) {
    return (
      <div className="tasks-list-state">
        <Bot className="size-5" />
        当前 repo 还没有 task
      </div>
    )
  }
  return (
    <div className="tasks-list-panel">
      <table className="tasks-list-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Status</th>
            <th>Action</th>
            <th>Issue</th>
            <th>Agent</th>
            <th>Model</th>
            <th>Turns</th>
            <th>Execution</th>
            <th>Duration</th>
            <th>Updated</th>
            <th className="task-link-cell"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskTableRow
              key={task.id}
              task={task}
              agentrixBaseUrl={agentrixBaseUrl}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TaskTableRow({
  task,
  agentrixBaseUrl,
}: {
  task: TaskRow
  agentrixBaseUrl: string
}) {
  return (
    <tr>
      <td>
        <code title={task.taskId}>{shortTaskId(task.taskId)}</code>
      </td>
      <td>
        <span className={`task-status ${taskStatusTone(task.status)}`}>
          <i aria-hidden="true" />
          {task.status || "unknown"}
        </span>
      </td>
      <td>{task.action || "-"}</td>
      <td>{task.issueNumber > 0 ? `#${task.issueNumber}` : "-"}</td>
      <td>{task.agent || "-"}</td>
      <td>
        <span className="task-model" title={task.model}>
          {task.model || "-"}
        </span>
      </td>
      <td className="task-number">{task.turns || 0}</td>
      <td className="task-number">{formatDurationMs(task.executionMs)}</td>
      <td className="task-number">{taskDuration(task)}</td>
      <td>
        {formatWhen(
          task.updatedAt || task.finishedAt || task.startedAt || task.queuedAt
        ) || "-"}
      </td>
      <td className="task-link-cell">
        <a
          className="task-external-link"
          href={taskUrl(agentrixBaseUrl, task.taskId)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`在 Agentrix 中打开 task ${task.taskId}`}
          title="在 Agentrix 中打开"
        >
          <ExternalLink className="size-4" />
        </a>
      </td>
    </tr>
  )
}

function shortTaskId(taskId: string) {
  if (taskId.length <= 18) return taskId
  return `${taskId.slice(0, 8)}…${taskId.slice(-7)}`
}

function taskStatusTone(status: string) {
  return taskStatusTones[status] || "queued"
}

function taskUrl(baseUrl: string, taskId: string) {
  return `${baseUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(taskId)}`
}

function taskDuration(task: TaskRow) {
  if (!task.startedAt) return "-"
  const start = new Date(task.startedAt).getTime()
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "-"
  return formatDurationMs(end - start)
}

function formatDurationMs(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "-"
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes < 60)
    return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
