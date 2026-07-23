import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react"
import {
  AlertCircle,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitFork,
  Loader2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Server,
  Settings,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ownerOf, type GitLabProject, type GitLabUser, type GitServer, type IssueFlowUser } from "@/issue-flow-model"

type SidebarGroupId = "repositories" | "insights" | "admin"

export function RepoSidebar(props: {
  collapsed: boolean
  insightsActive: boolean
  gitServersAdminActive: boolean
  showAdmin: boolean
  gitServers: GitServer[]
  selectedGitServerId: string
  selectedGitServer?: GitServer
  user?: GitLabUser | IssueFlowUser
  currentUser?: GitLabUser
  projects: GitLabProject[]
  selectedProjectId: string
  owner: string
  owners: string[]
  filter: string
  loading: boolean
  loadingMore?: boolean
  hasMore?: boolean
  loadingLabel?: string
  onSelectGitServer: (id: string) => void
  onOwner: (value: string) => void
  onFilter: (value: string) => void
  onLoadMore: () => void
  onSelectProject: (id: string, gitServerId?: string) => void
  onLoginCurrent: () => void
  onRefresh: (gitServerId?: string) => void | Promise<void>
  onLogout: () => void
  onOpenUserSettings: () => void
  onOpenInsights: () => void
  onOpenGitServersAdmin: () => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const {
    collapsed,
    insightsActive,
    gitServersAdminActive,
    showAdmin,
    gitServers,
    selectedGitServerId,
    selectedGitServer,
    user,
    currentUser,
    projects,
    selectedProjectId,
    owner,
    owners,
    filter,
    loading,
    loadingMore,
    hasMore,
    loadingLabel,
    onSelectGitServer,
    onOwner,
    onFilter,
    onLoadMore,
    onSelectProject,
    onLoginCurrent,
    onRefresh,
    onLogout,
    onOpenUserSettings,
    onOpenInsights,
    onOpenGitServersAdmin,
    onCollapsedChange,
  } = props
  const [pickerOpen, setPickerOpen] = useState<"server" | "owner" | null>(null)
  const [openGroups, setOpenGroups] = useState(() => ({
    repositories: sidebarGroupOpen("repositories"),
    insights: sidebarGroupOpen("insights"),
    admin: sidebarGroupOpen("admin"),
  }))
  const selectedProjectRef = useRef<HTMLButtonElement>(null)
  const searching = Boolean(filter.trim())

  useEffect(() => {
    if (!selectedProjectId) return
    selectedProjectRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [projects, selectedProjectId, selectedGitServerId])

  function toggleGroup(group: SidebarGroupId) {
    setOpenGroups((current) => {
      const next = !current[group]
      window.localStorage.setItem(`issue-flow.sidebarGroup.${group}`, next ? "1" : "0")
      return { ...current, [group]: next }
    })
  }

  function handleFilter(value: string) {
    if (value.trim()) setPickerOpen(null)
    onFilter(value)
  }

  function togglePicker(next: "server" | "owner") {
    setPickerOpen((current) => current === next ? null : next)
  }

  function targetInPickerScope(target: EventTarget | null) {
    return target instanceof HTMLElement && Boolean(target.closest("[data-sidebar-picker-scope]"))
  }

  function closePickerOnOutsideFocus(event: FocusEvent<HTMLElement>) {
    if (!targetInPickerScope(event.target)) setPickerOpen(null)
  }

  function closePickerOnOutsideBlur(event: FocusEvent<HTMLElement>) {
    if (!targetInPickerScope(event.relatedTarget)) setPickerOpen(null)
  }

  if (collapsed) {
    return (
      <aside className="repo-sidebar collapsed">
        <div className="sidebar-titlebar compact">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="展开 sidebar" onClick={() => onCollapsedChange(false)}>
                <PanelLeftOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>展开 sidebar</TooltipContent>
          </Tooltip>
        </div>

        <div className="sidebar-rail">
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="sidebar-rail-button" aria-label="Repositories" onClick={() => onCollapsedChange(false)}>
                <FolderGit2 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Repositories</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className={`sidebar-rail-button ${insightsActive ? "active" : ""}`} aria-label="Insights" onClick={onOpenInsights}>
                <BarChart3 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Insights</TooltipContent>
          </Tooltip>
          {showAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className={`sidebar-rail-button ${gitServersAdminActive ? "active" : ""}`} aria-label="Git servers" onClick={onOpenGitServersAdmin}>
                  <Server className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Git servers</TooltipContent>
            </Tooltip>
          )}
        </div>

        <ScrollArea className="repo-list-scroll collapsed">
          <div className="repo-list collapsed">
            {projects.map((project) => (
              <Tooltip key={`${project.gitServerId || ""}:${project.id}`}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    ref={isSelectedProject(project, selectedProjectId, selectedGitServerId) ? selectedProjectRef : undefined}
                    className={`repo-row compact ${isSelectedProject(project, selectedProjectId, selectedGitServerId) ? "active" : ""}`}
                    onClick={() => onSelectProject(project.id, project.gitServerId)}
                  >
                    <span className="repo-initial">{repoInitial(project.name)}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{project.pathWithNamespace}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </ScrollArea>

        <UserMenu
          compact
          user={user}
          onLogout={onLogout}
          onOpenUserSettings={onOpenUserSettings}
        />
      </aside>
    )
  }

  return (
    <aside className="repo-sidebar" onBlurCapture={closePickerOnOutsideBlur} onFocusCapture={closePickerOnOutsideFocus}>
      <div className="sidebar-titlebar">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="收起 sidebar" onClick={() => onCollapsedChange(true)}>
              <PanelLeftClose className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>收起 sidebar</TooltipContent>
        </Tooltip>
        <strong>Issue flow</strong>
        <span className="sidebar-title-spacer" aria-hidden="true" />
      </div>

      <div className="sidebar-groups">
        <SidebarGroup id="repositories" title="Repositories" open={openGroups.repositories} onToggle={() => toggleGroup("repositories")}>
          <div className="search-row">
            <Search className="size-4" />
            <input value={filter} onChange={(event) => handleFilter(event.currentTarget.value)} placeholder="Search repos..." disabled={!user} />
          </div>

          {!searching && (
            <>
              <div className="repo-switchers" data-sidebar-picker-scope>
                <button type="button" className="server-trigger" onClick={() => togglePicker("server")}>
                  <GitBranch className="size-3.5" />
                  <span>{selectedGitServer?.name || selectedGitServer?.id || "Git server"}</span>
                  <ChevronDown className={`size-3.5 ${pickerOpen === "server" ? "expanded" : ""}`} />
                </button>
                <ChevronRight className="switcher-divider size-3" />
                <button type="button" className="owner-trigger" disabled={!currentUser || owners.length === 0} onClick={() => togglePicker("owner")}>
                  <GitFork className="size-3.5" />
                  <span>{owner === "all" ? "All owners" : owner}</span>
                  <ChevronDown className={`size-3.5 ${pickerOpen === "owner" ? "expanded" : ""}`} />
                </button>
              </div>

              {pickerOpen === "server" && (
                <div className="sidebar-picker" data-sidebar-picker-scope>
                  {gitServers.map((server) => (
                    <div
                      className={`picker-row server-picker-row ${server.id === selectedGitServerId ? "active" : ""}`}
                      key={server.id}
                    >
                      <button
                        type="button"
                        className="picker-select"
                        onClick={() => {
                          onSelectGitServer(server.id)
                          setPickerOpen(null)
                        }}
                      >
                        <GitBranch className="size-4" />
                        <span>{server.name || server.id}</span>
                        {server.id === selectedGitServerId && <Check className="size-4" />}
                      </button>
                      <button
                        type="button"
                        className="picker-icon-action"
                        disabled={!currentUser || loading}
                        title="强制刷新同步"
                        onClick={() => onRefresh(server.id)}
                      >
                        {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {pickerOpen === "owner" && (
                <div className="sidebar-picker" data-sidebar-picker-scope>
                  <button
                    type="button"
                    className={`picker-row ${owner === "all" ? "active" : ""}`}
                    onClick={() => {
                      onOwner("all")
                      setPickerOpen(null)
                    }}
                  >
                    <GitFork className="size-4" />
                    <span>All owners</span>
                    {owner === "all" && <Check className="size-4" />}
                  </button>
                  {owners.map((item) => (
                    <button
                      type="button"
                      className={`picker-row ${owner === item ? "active" : ""}`}
                      key={item}
                      onClick={() => {
                        onOwner(item)
                        setPickerOpen(null)
                      }}
                    >
                      <GitFork className="size-4" />
                      <span>{item}</span>
                      {owner === item && <Check className="size-4" />}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {!currentUser && !searching && (
            <div className="server-connect">
              <AlertCircle className="size-4" />
              <span>
                <strong>{selectedGitServer?.name || selectedGitServer?.id || "Git server"}</strong>
                <small>当前 Git server 尚未授权</small>
              </span>
              <Button size="sm" onClick={onLoginCurrent}>连接</Button>
            </div>
          )}

          <ScrollArea className="repo-list-scroll" viewportProps={{ onScroll: (event) => {
            const target = event.currentTarget
            if (!hasMore || loading || loadingMore) return
            if (target.scrollHeight - target.scrollTop - target.clientHeight < 96) onLoadMore()
          } }}>
            <div className="repo-list">
              {(currentUser || searching) && loading && <div className="repo-row muted"><Loader2 className="size-4 animate-spin" /> {loadingLabel || "加载仓库..."}</div>}
              {(currentUser || searching) && !loading && projects.length === 0 && <div className="repo-row muted">没有匹配仓库</div>}
              {projects.map((project) => {
                const selected = isSelectedProject(project, selectedProjectId, selectedGitServerId)
                return (
                  <button
                    type="button"
                    key={`${project.gitServerId || ""}:${project.id}`}
                    ref={selected ? selectedProjectRef : undefined}
                    className={`repo-row ${selected ? "active" : ""}`}
                    title={project.pathWithNamespace}
                    onClick={() => onSelectProject(project.id, project.gitServerId)}
                  >
                    <span className="repo-icon-wrap"><GitBranch className="size-4" /></span>
                    <span className="repo-row-copy">
                      <strong>{project.name}</strong>
                      {searching && <small>{projectSearchContext(project, gitServers)}</small>}
                    </span>
                  </button>
                )
              })}
              {(currentUser || searching) && loadingMore && <div className="repo-row muted"><Loader2 className="size-4 animate-spin" /> 加载更多...</div>}
              {(currentUser || searching) && !loading && !loadingMore && hasMore && <div className="repo-row muted">继续向下滚动加载更多</div>}
            </div>
          </ScrollArea>
        </SidebarGroup>

        <SidebarGroup id="insights" title="Insights" open={openGroups.insights} onToggle={() => toggleGroup("insights")}>
          <div className="sidebar-nav-list">
            <button type="button" className={`sidebar-nav-row ${insightsActive ? "active" : ""}`} onClick={onOpenInsights}>
              <BarChart3 className="size-4" />
              <span>Installations</span>
            </button>
          </div>
        </SidebarGroup>

        {showAdmin && (
          <SidebarGroup id="admin" title="Admin" open={openGroups.admin} onToggle={() => toggleGroup("admin")}>
            <div className="sidebar-nav-list">
              <button type="button" className={`sidebar-nav-row ${gitServersAdminActive ? "active" : ""}`} onClick={onOpenGitServersAdmin}>
                <Server className="size-4" />
                <span>Git servers</span>
              </button>
            </div>
          </SidebarGroup>
        )}
      </div>

      <UserMenu
        user={user}
        onLogout={onLogout}
        onOpenUserSettings={onOpenUserSettings}
      />
    </aside>
  )
}

function SidebarGroup({ id, title, open, onToggle, children }: { id: SidebarGroupId; title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`sidebar-group ${id} ${open ? "open" : "closed"}`}>
      <button type="button" className="sidebar-group-header" aria-expanded={open} onClick={onToggle}>
        <ChevronDown className="size-3" />
        <span>{title}</span>
      </button>
      {open && <div className="sidebar-group-content">{children}</div>}
    </section>
  )
}

function sidebarGroupOpen(group: SidebarGroupId) {
  if (typeof window === "undefined") return true
  return window.localStorage.getItem(`issue-flow.sidebarGroup.${group}`) !== "0"
}

function isSelectedProject(project: GitLabProject, selectedProjectId: string, selectedGitServerId: string) {
  return project.id === selectedProjectId && (!project.gitServerId || project.gitServerId === selectedGitServerId)
}

function projectSearchContext(project: GitLabProject, gitServers: GitServer[]) {
  const server = gitServers.find((item) => item.id === project.gitServerId)
  return [server?.name || project.gitServerId || "Git server", ownerOf(project)].filter(Boolean).join(" · ")
}

function repoInitial(name: string) {
  return (name.trim()[0] || "R").toUpperCase()
}

function UserMenu({
  compact,
  user,
  onLogout,
  onOpenUserSettings,
}: {
  compact?: boolean
  user?: GitLabUser | IssueFlowUser
  onLogout: () => void
  onOpenUserSettings: () => void
}) {
  const profile = userProfile(user)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={`user-menu ${compact ? "compact" : ""}`} title={profile.displayName}>
          <span className="avatar-dot">
            {profile.avatarUrl
              ? <img src={profile.avatarUrl} alt={profile.displayName} />
              : profile.initial}
          </span>
          {!compact && (
            <>
              <span>
                <strong>{profile.displayName}</strong>
                <small>{profile.email || "未设置邮箱"}</small>
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? "start" : "end"} side={compact ? "right" : "top"} className="user-menu-content">
        <DropdownMenuLabel>{profile.displayName}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenUserSettings}>
          <Settings className="size-4" />
          账户设置
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onLogout}>
          <LogOut className="size-4" />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function userProfile(user?: GitLabUser | IssueFlowUser) {
  const displayName = user
    ? "username" in user
      ? user.name || user.username || "issue-flow user"
      : user.displayName || user.email || "issue-flow user"
    : "issue-flow user"
  const email = user && "email" in user ? user.email || "" : ""
  const avatarUrl = user?.avatarUrl || ""
  return {
    displayName,
    email,
    avatarUrl,
    initial: (displayName.trim()[0] || "U").toUpperCase(),
  }
}
