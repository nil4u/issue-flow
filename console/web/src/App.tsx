import { LoginPage } from "@/components/login-page"
import { InstalledAutomationsPage } from "@/components/installed-automations-page"
import { RepoSidebar } from "@/components/repo-sidebar"
import { RepoWorkspace } from "@/components/repo-workspace"
import { SetupPage } from "@/components/setup-page"
import { UserSettings } from "@/components/user-settings"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useDashboardController } from "@/hooks/use-dashboard-controller"
import { parseVisualArtifactRoute } from "@/app-route"
import { VisionPlanPage } from "@/vision-plan/VisionPlanPage"

function AppShell() {
  return (
    <TooltipProvider>
      <Dashboard />
      <Toaster position="top-center" closeButton visibleToasts={3} />
    </TooltipProvider>
  )
}

function Dashboard() {
  const dashboard = useDashboardController()
  const visualRoute = parseVisualArtifactRoute()

  if (dashboard.booting) {
    return <main className="login-screen"><div className="shell-loading">正在检查控制台配置...</div></main>
  }

  if (dashboard.setupStatus?.needsSetup) {
    return (
      <SetupPage
        status={dashboard.setupStatus}
        loading={dashboard.initializingSetup}
        onInitialize={dashboard.initializeSetup}
      />
    )
  }

  if (!dashboard.userSession.authenticated) {
    return (
      <LoginPage
        gitServers={dashboard.gitServers}
        loading={dashboard.loadingLoginState}
        onLogin={dashboard.loginGitLab}
        onReload={dashboard.reloadLoginState}
      />
    )
  }

  if (visualRoute) {
    return <VisionPlanPage {...visualRoute} />
  }

  return (
    <main className={`issue-app ${dashboard.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <RepoSidebar {...dashboard.sidebar} />

      <section className="workspace-surface">
        {dashboard.route.view === "insights" ? (
          <InstalledAutomationsPage {...dashboard.insights} />
        ) : dashboard.route.view === "settings" ? (
          <UserSettings {...dashboard.userSettings} />
        ) : (
          <RepoWorkspace {...dashboard.workspace} />
        )}
      </section>
    </main>
  )
}

export default AppShell
