import { useEffect, useState, type KeyboardEvent } from "react"
import { BarChart3, ChevronLeft, ChevronRight, Loader2, RefreshCw, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import { api, type InstalledAutomation, type InstalledAutomationPage } from "@/issue-flow-model"
import { notifyError } from "@/lib/errors"

const INSTALLATIONS_PER_PAGE = 20
const emptyPage: InstalledAutomationPage = {
  installations: [],
  page: 1,
  perPage: INSTALLATIONS_PER_PAGE,
  total: 0,
  hasMore: false,
}

export function InstalledAutomationsPage({
  onOpenRepository,
}: {
  onOpenRepository: (gitServerId: string, projectId: string, repositoryId: string) => void
}) {
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<InstalledAutomationPage>(emptyPage)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const query = new URLSearchParams({
      page: String(page),
      perPage: String(INSTALLATIONS_PER_PAGE),
    })
    void api<InstalledAutomationPage>(`/api/insights/installations?${query}`, { signal: controller.signal })
      .then((body) => {
        setResult(body)
        if (page > 1 && body.installations.length === 0 && body.total > 0)
          setPage(Math.ceil(body.total / body.perPage))
      })
      .catch((error) => {
        if (!controller.signal.aborted) notifyError(error, "加载已安装 repositories 失败")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [page, refreshKey])

  const installations = result.installations || []

  function refresh() {
    setLoading(true)
    setRefreshKey((value) => value + 1)
  }

  function changePage(nextPage: number) {
    setLoading(true)
    setPage(nextPage)
  }

  return (
    <div className="insights-page">
      <header className="insights-page-header">
        <div>
          <span className="insights-eyebrow"><BarChart3 className="size-4" />Insights</span>
          <h1>Installed repositories</h1>
        </div>
        <Button type="button" variant="secondary" onClick={refresh} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </header>

      <section className="insights-installations">
        {loading && installations.length === 0 ? (
          <div className="insights-list-state"><Loader2 className="size-5 animate-spin" />正在加载已安装 repositories...</div>
        ) : installations.length === 0 ? (
          <div className="insights-list-state"><Workflow className="size-5" />还没有已安装的 repository。</div>
        ) : (
          <InstallationTable installations={installations} onOpenRepository={onOpenRepository} />
        )}
        <InstallationsPagination result={result} loading={loading} onPage={changePage} />
      </section>
    </div>
  )
}

function InstallationTable({
  installations,
  onOpenRepository,
}: {
  installations: InstalledAutomation[]
  onOpenRepository: (gitServerId: string, projectId: string, repositoryId: string) => void
}) {
  return (
    <div className="insights-table-wrap">
      <table className="insights-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th>Version</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {installations.map((installation) => (
            <InstallationRow key={installation.id} installation={installation} onOpenRepository={onOpenRepository} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InstallationRow({
  installation,
  onOpenRepository,
}: {
  installation: InstalledAutomation
  onOpenRepository: (gitServerId: string, projectId: string, repositoryId: string) => void
}) {
  const status = installationStatus(installation)
  const repositoryName = installation.projectPath || installation.name

  function openRepository() {
    onOpenRepository(installation.gitServerId, installation.projectId, installation.id)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>) {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    openRepository()
  }

  return (
    <tr
      className="insights-table-row"
      tabIndex={0}
      role="link"
      aria-label={`打开 ${repositoryName} Overview`}
      onClick={openRepository}
      onKeyDown={handleKeyDown}
    >
      <td>
        <div className="insights-repo-cell">
          <span className="insights-repo-icon"><Workflow className="size-4" /></span>
          <span>
            <strong>{repositoryName}</strong>
            <small>{installation.serverName || installation.provider || "Git server"}</small>
          </span>
        </div>
      </td>
      <td>
        <div className="insights-version-cell">
          <strong>{versionLabel(installation.plugin.installedVersion)}</strong>
          <small>最新 {versionLabel(installation.plugin.latestVersion)}</small>
        </div>
      </td>
      <td>
        <span className={`insights-status ${status.tone}`}>
          <i aria-hidden="true" />
          {status.label}
        </span>
      </td>
    </tr>
  )
}

function InstallationsPagination({
  result,
  loading,
  onPage,
}: {
  result: InstalledAutomationPage
  loading: boolean
  onPage: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(result.total / result.perPage))
  const hasItems = result.total > 0

  return (
    <footer className="insights-pagination" aria-label="Installed repositories pagination">
      <span>共 {result.total} 个仓库 · 第 {hasItems ? result.page : 0} / {hasItems ? totalPages : 0} 页</span>
      <div>
        <Button type="button" variant="secondary" size="sm" onClick={() => onPage(Math.max(1, result.page - 1))} disabled={loading || !hasItems || result.page <= 1}>
          <ChevronLeft className="size-4" />
          上一页
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={() => onPage(result.page + 1)} disabled={loading || !result.hasMore}>
          下一页
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </footer>
  )
}

function installationStatus(installation: InstalledAutomation) {
  if (installation.plugin.needsUpgrade) return { label: "可升级", tone: "warning" }
  return { label: "已安装", tone: "success" }
}

function versionLabel(version?: string) {
  const normalized = String(version || "").replace(/^v/, "")
  return normalized ? `v${normalized}` : "-"
}
