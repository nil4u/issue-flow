import type { WorkspaceRoute } from "@/app-route"
import type { GitLabProject, Repository } from "@/issue-flow-model"

export function repositoryMatchesProject(repository: Repository, projectId: string, gitServerId: string) {
  if (!projectId) return false
  if (gitServerId && repository.gitServerId && repository.gitServerId !== gitServerId) return false
  return repository.id === projectId
    || String(repository.projectId || repository.serverRepoId || "") === projectId
}

export function findSelectedRepository(repositories: Repository[], projectId: string, gitServerId: string) {
  return repositories.find((repository) => repositoryMatchesProject(repository, projectId, gitServerId))
}

export function selectedRepositoryForWorkspace(
  repositories: Repository[],
  snapshot: Repository | undefined,
  projectId: string,
  gitServerId: string,
) {
  return findSelectedRepository(repositories, projectId, gitServerId)
    || (snapshot && repositoryMatchesProject(snapshot, projectId, gitServerId) ? snapshot : undefined)
}

export function retainedSelectedProjectId({
  route,
  currentProjectId,
  projects,
  fallbackProject,
}: {
  route: WorkspaceRoute
  currentProjectId: string
  projects: GitLabProject[]
  fallbackProject?: "first" | "none"
}) {
  if (route.view === "repos" && route.projectId) return route.projectId
  if (currentProjectId) return currentProjectId
  if (fallbackProject === "none") return ""
  return projects[0]?.id || ""
}
