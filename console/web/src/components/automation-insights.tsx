import { AlertCircle, Check, CircleDot, Lightbulb, Loader2, RefreshCw, Sparkles } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { EmptyPanel } from "@/components/empty-panel"
import { Button } from "@/components/ui/button"
import {
  api,
  type AutomationOptimizationItem,
  type RepoWorkspaceProps,
} from "@/issue-flow-model"

export function AutomationInsights({ gitServer, user, project, repository, onLogin }: RepoWorkspaceProps) {
  const [items, setItems] = useState<AutomationOptimizationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [creatingIssueNumber, setCreatingIssueNumber] = useState(0)
  const gitServerId = gitServer?.id || ""
  const projectId = repository?.serverRepoId || project?.id || ""
  const baseApi = `/api/issues/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}`

  const loadInsights = useCallback(async () => {
    if (!gitServerId || !projectId || !user) return
    setLoading(true); setError("")
    try {
      const optimizationBody = await api<{ items?: AutomationOptimizationItem[] }>(`${baseApi}/automation-optimizations`, {
        method: "POST",
        body: "{}",
      })
      setItems((optimizationBody.items || []).filter((optimization) => optimization.status !== "unavailable"))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载自动化优化 Insights 失败")
    } finally {
      setLoading(false)
    }
  }, [baseApi, gitServerId, projectId, user])

  useEffect(() => { void loadInsights() }, [loadInsights])

  async function createOptimization(sourceIssueNumber: number) {
    if (creatingIssueNumber) return
    setCreatingIssueNumber(sourceIssueNumber); setError("")
    try {
      const result = await api<{ issue: { number: number; webUrl?: string } }>(`${baseApi}/${sourceIssueNumber}/automation-optimization`, {
        method: "POST",
        body: "{}",
      })
      setItems((current) => current.map((item) => item.issue.number === sourceIssueNumber ? {
        ...item,
        status: "analyzing",
        optimizationIssueNumber: result.issue.number,
        optimizationIssueUrl: result.issue.webUrl || "",
      } : item))
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建优化 Issue 失败")
    } finally {
      setCreatingIssueNumber(0)
    }
  }

  const counts = useMemo(() => ({
    available: items.filter((item) => item.status === "available").length,
    analyzing: items.filter((item) => item.status === "analyzing").length,
    analyzed: items.filter((item) => item.status === "analyzed").length,
  }), [items])

  if (!gitServer) return <EmptyPanel icon={<Lightbulb className="size-6" />} title="没有 Git server" detail="请先在后台配置 Git server。" />
  if (!user) return <EmptyPanel icon={<AlertCircle className="size-6" />} title="当前 Git server 未连接" detail="连接当前 Git server 后查看自动化优化 Insights。"><Button onClick={onLogin}>连接 Git server</Button></EmptyPanel>
  if (!project) return <EmptyPanel icon={<Lightbulb className="size-6" />} title="选择仓库" detail="从左侧列表选择一个 repo。" />
  if (!repository) return <EmptyPanel icon={<Lightbulb className="size-6" />} title="还没有仓库记录" detail="先同步仓库列表后再查看 Insights。" />

  return (
    <div className="automation-insights">
      <header className="automation-insights-header">
        <div><span><Lightbulb className="size-4" />Automation Insights</span><h2>可分析优化的 Issues</h2><p>阶段 Turns 大于 1 的任务会出现在这里。</p></div>
        <Button variant="secondary" onClick={() => void loadInsights()} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}刷新</Button>
      </header>
      <div className="automation-insights-summary">
        <InsightCount label="待分析" value={counts.available} />
        <InsightCount label="分析中" value={counts.analyzing} />
        <InsightCount label="已分析" value={counts.analyzed} />
      </div>
      {error ? <div className="provider-issues-error"><AlertCircle className="size-4" />{error}</div> : null}
      <section className="automation-insights-list">
        {loading && !items.length ? <div className="automation-insights-empty"><Loader2 className="size-5 animate-spin" />正在加载 Insights…</div>
          : !items.length ? <div className="automation-insights-empty"><Check className="size-5" />当前没有可分析优化的 Issue</div>
            : items.map((item) => <AutomationInsightRow key={item.issue.id || item.issue.number} item={item} gitServerId={gitServerId} projectId={projectId} creating={creatingIssueNumber === item.issue.number} onCreate={() => createOptimization(item.issue.number)} />)}
      </section>
    </div>
  )
}

function InsightCount({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function AutomationInsightRow({ item, gitServerId, projectId, creating, onCreate }: { item: AutomationOptimizationItem; gitServerId: string; projectId: string; creating: boolean; onCreate: () => Promise<void> }) {
  const { issue } = item
  const sourceHref = issueHref(gitServerId, projectId, issue.number)
  return (
    <article className="automation-insight-row">
      <a className="automation-insight-issue" href={sourceHref}><span className={`provider-issue-state state-${issue.state}`}><CircleDot className="size-3.5" />{issue.state === "closed" ? "Closed" : "Open"}</span><div><strong>#{issue.number} {issue.title}</strong><small>{issue.author.name || issue.author.username || "Unknown"}</small></div></a>
      <div className="automation-insight-phases">{item.phases.map((phase) => <span key={phase.phase}>{phaseName(phase.phase)} <b>{phase.turns}</b></span>)}</div>
      <div className="automation-insight-action">
        {item.status === "available" ? <button type="button" className="metrics-optimization-action" disabled={creating} onClick={() => void onCreate()}>{creating ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}{creating ? "正在创建" : "分析优化"}</button>
          : <span className={`metrics-optimization-status is-${item.status}`}>{item.status === "analyzing" ? <><Loader2 className="size-3.5 animate-spin" />正在分析优化</> : <><Check className="size-3.5" />已分析优化</>}</span>}
      </div>
    </article>
  )
}

function issueHref(gitServerId: string, projectId: string, issueNumber: number) {
  const returnTo = `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/insights`
  return `/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/issues/${issueNumber}?${new URLSearchParams({ returnTo })}`
}

function phaseName(phase: AutomationOptimizationItem["phases"][number]["phase"]) {
  return ({ triage: "Triage", plan: "Plan", build: "Build", review: "Review" })[phase]
}
