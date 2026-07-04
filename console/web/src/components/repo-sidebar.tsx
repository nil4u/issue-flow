import { useState } from "react"
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitFork,
  Loader2,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
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
import type { GitLabProject, GitLabUser, GitServer, IssueFlowUser } from "@/issue-flow-model"

export function RepoSidebar(props: {
  collapsed: boolean
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
  onSelectGitServer: (id: string) => void
  onOwner: (value: string) => void
  onFilter: (value: string) => void
  onSelectProject: (id: string) => void
  onLoginCurrent: () => void
  onRefresh: (gitServerId?: string) => void | Promise<void>
  onLogout: () => void
  onOpenUserSettings: () => void
  onCollapsedChange: (collapsed: boolean) => void
}) {
  const {
    collapsed,
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
    onSelectGitServer,
    onOwner,
    onFilter,
    onSelectProject,
    onLoginCurrent,
    onRefresh,
    onLogout,
    onOpenUserSettings,
    onCollapsedChange,
  } = props
  const [pickerOpen, setPickerOpen] = useState<"server" | "owner" | null>(null)

  function togglePicker(next: "server" | "owner") {
    setPickerOpen((current) => current === next ? null : next)
  }

  if (collapsed) {
    return (
      <aside className="repo-sidebar collapsed">
        <div className="sidebar-titlebar compact">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => onCollapsedChange(false)}>
                <PanelLeftOpen className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>展开 sidebar</TooltipContent>
          </Tooltip>
        </div>

        <ScrollArea className="repo-list-scroll collapsed">
          <div className="repo-list collapsed">
            {projects.map((project) => (
              <Tooltip key={project.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={`repo-row compact ${project.id === selectedProjectId ? "active" : ""}`}
                    onClick={() => onSelectProject(project.id)}
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
    <aside className="repo-sidebar">
      <div className="sidebar-titlebar">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={() => onCollapsedChange(true)}>
              <PanelLeftClose className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>收起 sidebar</TooltipContent>
        </Tooltip>
        <strong>Repos</strong>
        <span className="sidebar-title-spacer" aria-hidden="true" />
      </div>

      <div className="search-row">
        <Search className="size-4" />
        <input value={filter} onChange={(event) => onFilter(event.currentTarget.value)} placeholder="Search repos..." disabled={!currentUser} />
      </div>

      <div className="repo-switchers">
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
        <div className="sidebar-picker">
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
        <div className="sidebar-picker">
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

      {!currentUser && (
        <div className="server-connect">
          <AlertCircle className="size-4" />
          <span>
            <strong>{selectedGitServer?.name || selectedGitServer?.id || "Git server"}</strong>
            <small>当前 Git server 尚未授权</small>
          </span>
          <Button size="sm" onClick={onLoginCurrent}>连接</Button>
        </div>
      )}

      <ScrollArea className="repo-list-scroll">
        <div className="repo-list">
          {currentUser && loading && <div className="repo-row muted"><Loader2 className="size-4 animate-spin" /> 同步仓库...</div>}
          {currentUser && !loading && projects.length === 0 && <div className="repo-row muted">没有匹配仓库</div>}
          {projects.map((project) => {
            return (
              <button
                type="button"
                key={project.id}
                className={`repo-row ${project.id === selectedProjectId ? "active" : ""}`}
                title={project.pathWithNamespace}
                onClick={() => onSelectProject(project.id)}
              >
                <span className="repo-icon-wrap"><GitBranch className="size-4" /></span>
                <span>
                  <strong>{project.name}</strong>
                </span>
              </button>
            )
          })}
        </div>
      </ScrollArea>

      <UserMenu
        user={user}
        onLogout={onLogout}
        onOpenUserSettings={onOpenUserSettings}
      />
    </aside>
  )
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
