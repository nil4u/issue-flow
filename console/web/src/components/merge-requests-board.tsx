import { useCallback, useEffect, useState } from "react"
import { AlertCircle, ExternalLink, GitBranch, GitMerge, Loader2, RefreshCw, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyPanel } from "@/components/empty-panel"
import { api, formatWhen, type MergeRequestSummary, type RepoWorkspaceProps } from "@/issue-flow-model"

type MergeRequestState = "open" | "merged" | "closed" | "all"

const stateOptions: Array<{ value: MergeRequestState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
]

function stateLabel(mergeRequest: MergeRequestSummary) {
  if (mergeRequest.merged || mergeRequest.state === "merged") return "Merged"
  if (mergeRequest.state === "open") return mergeRequest.draft ? "Draft" : "Open"
  return "Closed"
}

export function MergeRequestsBoard({ gitServer, user, project, repository, onLogin }: RepoWorkspaceProps) {
  const [state, setState] = useState<MergeRequestState>("open")
  const [mergeRequests, setMergeRequests] = useState<MergeRequestSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const gitServerId = gitServer?.id || ""
  const projectId = repository?.serverRepoId || project?.id || ""

  const loadMergeRequests = useCallback(async () => {
    if (!gitServerId || !projectId || !user) return
    setLoading(true)
    setError("")
    try {
      const body = await api<{ mergeRequests?: MergeRequestSummary[] }>(
        `/api/merge-requests/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}?state=${state}`,
      )
      setMergeRequests(Array.isArray(body.mergeRequests) ? body.mergeRequests : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载 Merge Requests 失败")
    } finally {
      setLoading(false)
    }
  }, [gitServerId, projectId, state, user])

  useEffect(() => {
    if (!gitServerId || !projectId || !user) return
    let active = true
    void api<{ mergeRequests?: MergeRequestSummary[] }>(
      `/api/merge-requests/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}?state=${state}`,
    ).then((body) => {
      if (active) setMergeRequests(Array.isArray(body.mergeRequests) ? body.mergeRequests : [])
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "加载 Merge Requests 失败")
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [gitServerId, projectId, state, user])

  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) {
    return (
      <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后查看 Merge Requests。">
        <Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button>
      </EmptyPanel>
    )
  }
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<GitMerge className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再查看 Merge Requests。" />

  const reviewHref = (number: number) => `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/merge-requests/${number}`

  return (
    <div className="merge-requests-board">
      <header className="merge-requests-toolbar">
        <div>
          <strong>{mergeRequests.length} merge requests</strong>
        </div>
        <div className="merge-requests-actions">
          <div className="merge-request-state-filter" role="group" aria-label="Merge request state">
            {stateOptions.map((option) => (
              <Button key={option.value} type="button" variant={state === option.value ? "secondary" : "ghost"} size="sm" aria-pressed={state === option.value} onClick={() => {
                if (state === option.value) return
                setLoading(true)
                setError("")
                setState(option.value)
              }}>
                {option.label}
              </Button>
            ))}
          </div>
          <Button type="button" variant="secondary" onClick={() => void loadMergeRequests()} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            刷新
          </Button>
        </div>
      </header>

      {error ? <div className="merge-request-error"><AlertCircle className="size-4" />{error}</div> : null}
      {loading && mergeRequests.length === 0 ? (
        <div className="merge-request-empty"><Loader2 className="size-5 animate-spin" />正在读取 Merge Requests…</div>
      ) : mergeRequests.length === 0 ? (
        <div className="merge-request-empty"><GitMerge className="size-5" />当前筛选条件下没有 Merge Request</div>
      ) : (
        <div className="merge-request-list">
          {mergeRequests.map((mergeRequest) => (
            <article key={mergeRequest.id || mergeRequest.number} className="merge-request-row">
              <a className="merge-request-row-review" href={reviewHref(mergeRequest.number)} aria-label={`审阅 MR !${mergeRequest.number} ${mergeRequest.title}`}>
                <div className="merge-request-primary">
                  <div className="merge-request-title-line">
                    <span className={`merge-request-state state-${stateLabel(mergeRequest).toLowerCase()}`}>{stateLabel(mergeRequest)}</span>
                    <strong>!{mergeRequest.number} {mergeRequest.title}</strong>
                  </div>
                  <div className="merge-request-meta">
                    <span>{mergeRequest.author?.name || mergeRequest.author?.username || "Unknown"}</span>
                    <span><code>{mergeRequest.sourceBranch}</code> → <code>{mergeRequest.targetBranch}</code></span>
                    {mergeRequest.sourceIssueNumber > 0 ? <span>Mentions issue #{mergeRequest.sourceIssueNumber}</span> : null}
                    <span>更新于 {formatWhen(mergeRequest.updatedAt) || "-"}</span>
                  </div>
                  {mergeRequest.labels.length ? <div className="merge-request-labels">{mergeRequest.labels.map((label) => <span key={label}>{label}</span>)}</div> : null}
                </div>
                <div className="merge-request-stats">
                  {mergeRequest.changedFilesCount > 0 ? <span>{mergeRequest.changedFilesCount} files</span> : null}
                  {mergeRequest.commentsCount > 0 ? <span>{mergeRequest.commentsCount} comments</span> : null}
                </div>
              </a>
              <div className="merge-request-row-actions">
                {mergeRequest.webUrl ? <Button asChild variant="ghost" size="icon-sm"><a href={mergeRequest.webUrl} target="_blank" rel="noreferrer" aria-label={`在 Git server 打开 MR !${mergeRequest.number}`}><ExternalLink className="size-4" /></a></Button> : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
