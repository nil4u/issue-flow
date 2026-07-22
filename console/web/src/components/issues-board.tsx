import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"
import { AlertCircle, ChevronDown, ChevronRight, CircleDot, ExternalLink, Eye, GitBranch, GitMerge, LayoutGrid, List, Loader2, MessageCircle, Plus, RefreshCw, Search } from "lucide-react"

import { EmptyPanel } from "@/components/empty-panel"
import { ProviderLabel, ProviderLabelPicker } from "@/components/issues/provider-label-picker"
import { ProviderMarkdownEditor } from "@/components/issues/provider-markdown"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { api, formatWhen, type ProviderIssueLabel, type ProviderIssueSummary, type RepoWorkspaceProps, type ReviewablePlanArtifact } from "@/issue-flow-model"

type IssueState = "open" | "closed"
type IssueViewMode = "board" | "list"

const stateOptions: Array<{ value: IssueState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
]

const lanes = [
  { id: "clarify", title: "Clarify" },
  { id: "approve", title: "Approve" },
  { id: "triage", title: "Triage" },
  { id: "plan", title: "Plan" },
  { id: "build", title: "Build" },
  { id: "untriaged", title: "No flow" },
]

function issueStateFromLocation(): IssueState {
  return new URLSearchParams(window.location.search).get("state") === "closed" ? "closed" : "open"
}

function laneId(issue: ProviderIssueSummary) {
  const flow = issue.labels.find((label) => label.name.startsWith("flow::"))?.name.slice("flow::".length).toLowerCase() || ""
  return lanes.some((lane) => lane.id === flow) ? flow : "untriaged"
}

export function IssuesBoard({ gitServer, user, project, repository, onLogin }: RepoWorkspaceProps) {
  const initialState = issueStateFromLocation()
  const [state, setState] = useState<IssueState>(initialState)
  const [viewMode, setViewMode] = useState<IssueViewMode>(initialState === "open" ? "board" : "list")
  const [laneCollapseOverrides, setLaneCollapseOverrides] = useState<Record<string, boolean>>({})
  const [issues, setIssues] = useState<ProviderIssueSummary[]>([])
  const [labels, setLabels] = useState<ProviderIssueLabel[]>([])
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState("")
  const [newBody, setNewBody] = useState("")
  const [newLabels, setNewLabels] = useState<string[]>([])
  const [reviewArtifacts, setReviewArtifacts] = useState<ReviewablePlanArtifact[]>([])
  const gitServerId = gitServer?.id || ""
  const projectId = repository?.serverRepoId || project?.id || ""
  const baseApi = `/api/issues/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}`

  const loadIssues = useCallback(async () => {
    if (!gitServerId || !projectId || !user) return
    setLoading(true); setError("")
    try {
      const body = await api<{ issues?: ProviderIssueSummary[] }>(`${baseApi}?state=${state}`)
      setIssues(Array.isArray(body.issues) ? body.issues : [])
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "加载 Issues 失败") }
    finally { setLoading(false) }
  }, [baseApi, gitServerId, projectId, state, user])

  useEffect(() => { void loadIssues() }, [loadIssues])

  useEffect(() => { setLaneCollapseOverrides({}) }, [gitServerId, projectId])

  useEffect(() => {
    if (!gitServerId || !projectId || !user) return
    let active = true
    void Promise.all([
      api<{ labels?: ProviderIssueLabel[] }>(`${baseApi}/metadata`).catch(() => ({ labels: [] })),
      api<{ artifacts?: ReviewablePlanArtifact[] }>(`/api/visual-artifacts/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/reviewable`).catch(() => ({ artifacts: [] })),
    ]).then(([labelBody, artifactBody]) => {
      if (!active) return
      setLabels(Array.isArray(labelBody.labels) ? labelBody.labels : [])
      setReviewArtifacts(Array.isArray(artifactBody.artifacts) ? artifactBody.artifacts : [])
    })
    return () => { active = false }
  }, [baseApi, gitServerId, projectId, user])

  const filteredIssues = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? issues.filter((issue) => [`#${issue.number}`, issue.title, ...issue.labels.map((label) => label.name)].join(" ").toLowerCase().includes(needle)) : issues
  }, [issues, query])
  const groupedIssues = useMemo(() => {
    const grouped = new Map(lanes.map((lane) => [lane.id, [] as ProviderIssueSummary[]]))
    for (const issue of filteredIssues) grouped.get(laneId(issue))?.push(issue)
    return grouped
  }, [filteredIssues])

  function issueHref(issueNumber: number) { return `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues/${issueNumber}${state === "closed" ? "?state=closed" : ""}` }
  function reviewHref(issueNumber: number) { return `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/plan/${issueNumber}` }
  function artifactFor(issueNumber: number) { return reviewArtifacts.find((artifact) => artifact.issueNumber === issueNumber) }
  function selectState(nextState: IssueState) {
    setState(nextState)
    setViewMode(nextState === "open" ? "board" : "list")
    const url = new URL(window.location.href)
    if (nextState === "closed") url.searchParams.set("state", "closed")
    else url.searchParams.delete("state")
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
  }
  function toggleLane(lane: string, issueCount: number) {
    setLaneCollapseOverrides((current) => ({ ...current, [lane]: !(current[lane] ?? (issueCount === 0)) }))
  }

  async function createIssue() {
    if (!newTitle.trim() || creating) return
    setCreating(true); setError("")
    try {
      const result = await api<{ issue: ProviderIssueSummary }>(baseApi, { method: "POST", body: JSON.stringify({ title: newTitle.trim(), body: newBody, labels: newLabels }) })
      window.location.assign(issueHref(result.issue.number))
    } catch (createError) { setError(createError instanceof Error ? createError.message : "创建 Issue 失败") }
    finally { setCreating(false) }
  }

  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) return <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后管理 Issues。"><Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button></EmptyPanel>
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<CircleDot className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再管理 Issues。" />

  const laneViews = lanes.map((lane) => {
    const laneIssues = groupedIssues.get(lane.id) || []
    return { ...lane, issues: laneIssues, collapsed: laneCollapseOverrides[lane.id] ?? laneIssues.length === 0 }
  })
  const collapsedLanes = laneViews.filter((lane) => lane.collapsed)
  const expandedLanes = laneViews.filter((lane) => !lane.collapsed)
  const laneGridStyle = { "--issue-lane-count": Math.max(expandedLanes.length, 1) } as CSSProperties

  return <div className="provider-issues-board"><header className="provider-issues-toolbar"><div className="provider-issue-state-filter" role="group" aria-label="Issue state">{stateOptions.map((option) => <Button key={option.value} type="button" variant={state === option.value ? "secondary" : "ghost"} size="sm" aria-pressed={state === option.value} onClick={() => selectState(option.value)}>{option.label}</Button>)}</div><label className="provider-issues-search"><Search className="size-4" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search issues…" /></label><div className="provider-issues-actions">{state === "open" ? <div className="issue-view-switch"><Button variant={viewMode === "list" ? "secondary" : "ghost"} size="sm" onClick={() => setViewMode("list")}><List className="size-4" />列表</Button><Button variant={viewMode === "board" ? "secondary" : "ghost"} size="sm" onClick={() => setViewMode("board")}><LayoutGrid className="size-4" />看板</Button></div> : null}<Button variant="secondary" onClick={() => void loadIssues()} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button><Button onClick={() => setCreateOpen(true)}><Plus className="size-4" />New issue</Button></div></header>{error ? <div className="provider-issues-error"><AlertCircle className="size-4" />{error}</div> : null}{loading && !issues.length ? <div className="provider-issues-empty"><Loader2 className="size-5 animate-spin" />正在读取 Issues…</div> : !filteredIssues.length ? <div className="provider-issues-empty"><CircleDot className="size-5" />当前筛选条件下没有 Issue</div> : viewMode === "board" && state === "open" ? <div className="issue-board-shell">{collapsedLanes.length ? <div className="issue-board-collapsed-lanes"><span>已收起</span>{collapsedLanes.map((lane) => <button key={lane.id} type="button" className="issue-lane-collapsed" aria-label={`展开 ${lane.title}`} aria-expanded={false} onClick={() => toggleLane(lane.id, lane.issues.length)}><span>{lane.title}</span><b>{lane.issues.length}</b><ChevronRight className="size-4" /></button>)}</div> : null}<div className="issue-board-lanes" style={laneGridStyle}>{expandedLanes.map((lane) => <section key={lane.id} className="issue-lane"><header><button type="button" className="issue-lane-toggle" aria-expanded onClick={() => toggleLane(lane.id, lane.issues.length)}><span><strong>{lane.title}</strong><small>{lane.id === "untriaged" ? "无 flow:: 标签" : `flow::${lane.id}`}</small></span><span className="issue-lane-toggle-meta"><b>{lane.issues.length}</b><ChevronDown className="size-4" /></span></button></header><div className="issue-lane-list">{lane.issues.map((issue) => <IssueBoardCard key={issue.id} issue={issue} href={issueHref(issue.number)} artifact={artifactFor(issue.number)} reviewHref={reviewHref(issue.number)} />)}</div></section>)}</div></div> : <div className="provider-issue-list">{filteredIssues.map((issue) => <IssueListRow key={issue.id || issue.number} issue={issue} href={issueHref(issue.number)} artifact={artifactFor(issue.number)} reviewHref={reviewHref(issue.number)} />)}</div>}<Dialog open={createOpen} onOpenChange={setCreateOpen}><DialogContent className="provider-issue-dialog"><DialogHeader><DialogTitle>Create new issue</DialogTitle></DialogHeader><label className="provider-issue-field"><span>Title</span><Input value={newTitle} onChange={(event) => setNewTitle(event.currentTarget.value)} placeholder="Issue title" autoFocus /></label><label className="provider-issue-field"><span>Description</span><ProviderMarkdownEditor endpoint={`${baseApi}/markdown`} value={newBody} onChange={setNewBody} placeholder="Describe the issue…" /></label><div className="provider-issue-field"><span>Labels</span><ProviderLabelPicker labels={labels} selected={newLabels} onChange={setNewLabels} /></div><div className="provider-issue-dialog-actions"><Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button><Button onClick={() => void createIssue()} disabled={creating || !newTitle.trim()}>{creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{creating ? "Creating…" : "Create issue"}</Button></div></DialogContent></Dialog></div>
}

function IssueListRow({ issue, href, artifact, reviewHref }: { issue: ProviderIssueSummary; href: string; artifact?: ReviewablePlanArtifact; reviewHref: string }) {
  return <article className="provider-issue-row"><a href={href} className="provider-issue-row-main"><span className={`provider-issue-state state-${issue.state}`}><CircleDot className="size-4" />{issue.state === "closed" ? "Closed" : "Open"}</span><div><strong>#{issue.number} {issue.title}</strong><p>opened by {issue.author.name || issue.author.username || "Unknown"} · updated {formatWhen(issue.updatedAt) || "-"}</p>{issue.labels.length ? <div className="provider-issue-labels">{issue.labels.map((label) => <ProviderLabel key={label.name} label={label} />)}</div> : null}</div><span className="provider-issue-comments">{issue.commentsCount > 0 ? <><MessageCircle className="size-4" />{issue.commentsCount}</> : null}</span></a><div className="provider-issue-row-actions">{artifact ? <Button asChild variant="secondary" size="sm"><a href={reviewHref}><Eye className="size-4" />{artifact.type === "decision" ? "Decision" : "Plan"}</a></Button> : null}{issue.webUrl ? <Button asChild variant="ghost" size="icon-sm"><a href={issue.webUrl} target="_blank" rel="noreferrer" aria-label={`在 Git server 打开 issue #${issue.number}`}><ExternalLink className="size-4" /></a></Button> : null}</div></article>
}

function IssueBoardCard({ issue, href, artifact, reviewHref }: { issue: ProviderIssueSummary; href: string; artifact?: ReviewablePlanArtifact; reviewHref: string }) {
  return <article className="issue-card"><header><strong>#{issue.number}</strong><small>{formatWhen(issue.updatedAt) || ""}</small></header><a className="provider-issue-card-link" href={href}>{issue.title}</a>{issue.labels.length ? <div className="provider-issue-labels">{issue.labels.slice(0, 4).map((label) => <ProviderLabel key={label.name} label={label} />)}</div> : null}{artifact ? <a className="issue-review-link" href={reviewHref}><Eye className="size-4" />{artifact.type === "decision" ? "Decision" : "Plan"}</a> : null}</article>
}
