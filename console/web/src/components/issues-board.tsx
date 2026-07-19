import { useEffect, useMemo, useState } from "react"
import { AlertCircle, CircleDot, GitBranch, GitMerge, LayoutGrid, List, Loader2, RefreshCw, Search } from "lucide-react"

import { EmptyPanel } from "@/components/empty-panel"
import { IssuesKanban } from "@/components/issues/issues-kanban"
import { IssuesList } from "@/components/issues/issues-list"
import {
  activeIssueFilters,
  emptyIssueFilters,
  filterIssues,
  groupIssuesByLane,
  issueFilterOptions,
  issueWebUrl,
  openActiveIssues,
  sortIssuesByUpdatedDesc,
  type IssueFilters,
} from "@/components/issues/issue-view-model"
import { Button } from "@/components/ui/button"
import { api, type RepoWorkspaceProps, type ReviewablePlanArtifact } from "@/issue-flow-model"

type IssueViewMode = "board" | "list"

export function IssuesBoard({
  gitServer,
  user,
  project,
  repository,
  issues,
  loadingIssues,
  onLogin,
  onSyncIssues,
}: RepoWorkspaceProps) {
  const [viewMode, setViewMode] = useState<IssueViewMode>("board")
  const [filters, setFilters] = useState<IssueFilters>(emptyIssueFilters)
  const [reviewArtifacts, setReviewArtifacts] = useState<ReviewablePlanArtifact[]>([])
  const openIssues = useMemo(() => openActiveIssues(issues || []), [issues])
  const sortedOpenIssues = useMemo(() => sortIssuesByUpdatedDesc(openIssues), [openIssues])
  const grouped = useMemo(() => groupIssuesByLane(sortedOpenIssues), [sortedOpenIssues])
  const filterOptions = useMemo(() => issueFilterOptions(openIssues), [openIssues])
  const filteredIssues = useMemo(() => filterIssues(sortedOpenIssues, filters), [filters, sortedOpenIssues])
  const activeFilterCount = activeIssueFilters(filters)

  useEffect(() => {
    const gitServerId = gitServer?.id
    const projectId = repository?.serverRepoId || project?.id
    if (!gitServerId || !projectId || !user) {
      setReviewArtifacts([])
      return
    }
    let active = true
    api<{ artifacts?: ReviewablePlanArtifact[] }>(`/api/visual-artifacts/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/reviewable`)
      .then((body) => {
        if (active) setReviewArtifacts(Array.isArray(body.artifacts) ? body.artifacts : [])
      })
      .catch(() => {
        if (active) setReviewArtifacts([])
      })
    return () => { active = false }
  }, [gitServer?.id, project?.id, repository?.serverRepoId, user?.username])

  if (!gitServer) return <EmptyPanel icon={<GitBranch className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) {
    return (
      <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后查看 issue 看板。">
        <Button onClick={onLogin}><GitMerge className="size-4" />连接 Git server</Button>
      </EmptyPanel>
    )
  }
  if (!project) return <EmptyPanel icon={<Search className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<CircleDot className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再查看 issue 看板。" />

  const gitBaseUrl = (repository.baseUrl || gitServer.baseUrl || "").replace(/\/+$/, "")
  const projectPath = project.pathWithNamespace || repository.projectPath
  const projectWebUrl = project.webUrl || repository.webUrl || repository.url
    || (gitBaseUrl && projectPath ? `${gitBaseUrl}/${projectPath.replace(/^\/+/, "")}` : "")
  const issueHref = (issueNumber: number) => issueWebUrl(projectWebUrl, gitServer.type, issueNumber)
  const reviewHref = (issueNumber: number, artifactType: "decision" | "plan") => (
    `/repos/${encodeURIComponent(gitServer.id)}/${encodeURIComponent(repository.serverRepoId || project.id)}/plan/${issueNumber}/${artifactType}`
  )

  return (
    <div className="issue-board">
      <header className="issue-board-toolbar">
        <div>
          <strong>{openIssues.length} open issues</strong>
        </div>
        <div className="issue-board-actions">
          <div className="issue-view-switch" role="group" aria-label="Issue view mode">
            <Button type="button" variant={viewMode === "board" ? "secondary" : "ghost"} size="sm" onClick={() => setViewMode("board")} aria-pressed={viewMode === "board"}>
              <LayoutGrid className="size-4" />
              看板
            </Button>
            <Button type="button" variant={viewMode === "list" ? "secondary" : "ghost"} size="sm" onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"}>
              <List className="size-4" />
              列表
            </Button>
          </div>
          <Button type="button" variant="secondary" onClick={() => void onSyncIssues()} disabled={loadingIssues}>
            {loadingIssues ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            同步
          </Button>
        </div>
      </header>
      {viewMode === "board" ? (
        <IssuesKanban groupedIssues={grouped} issueHref={issueHref} reviewArtifacts={reviewArtifacts} reviewHref={reviewHref} />
      ) : (
        <IssuesList
          issues={filteredIssues}
          filters={filters}
          options={filterOptions}
          activeFilterCount={activeFilterCount}
          onFilters={setFilters}
          issueHref={issueHref}
          reviewArtifacts={reviewArtifacts}
          reviewHref={reviewHref}
        />
      )}
    </div>
  )
}
