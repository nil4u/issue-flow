// @ts-nocheck

const TASK_CONTEXT_PHASES = ["triage", "plan", "build", "review"]
const TASK_CONTEXT_PHASE_SET = new Set(TASK_CONTEXT_PHASES)

function taskContextError(message, status, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

async function getTaskContext({ store, repoId = "", gitServerId = "", projectId = "", issueNumber, phase }) {
  const normalizedRepoId = String(repoId || "").trim()
  const normalizedGitServerId = String(gitServerId || "").trim()
  const normalizedProjectId = String(projectId || "").trim()
  const normalizedIssueNumber = Number(issueNumber || 0)
  const normalizedPhase = String(phase || "").trim().toLowerCase()
  if (!normalizedRepoId && (!normalizedGitServerId || !normalizedProjectId)) {
    throw taskContextError("repository route is required", 400, "repository_route_required")
  }
  if (!Number.isInteger(normalizedIssueNumber) || normalizedIssueNumber <= 0) {
    throw taskContextError("issue number is required", 400, "issue_number_required")
  }
  if (normalizedPhase && !TASK_CONTEXT_PHASE_SET.has(normalizedPhase)) {
    throw taskContextError("phase must be one of: triage, plan, build, review", 400, "invalid_task_context_phase")
  }

  const repo = normalizedRepoId
    ? await store.db.repo.findUnique({ where: { id: normalizedRepoId } })
    : await store.findRepositoryByProject({ gitServerId: normalizedGitServerId, projectId: normalizedProjectId })
  if (!repo || !repo.gitServerId || !repo.serverRepoId) {
    throw taskContextError("repository not found", 404, "repository_not_found")
  }
  const issue = await store.db.issue.findUnique({
    where: {
      gitServerId_repositoryId_issueNumber: {
        gitServerId: repo.gitServerId,
        repositoryId: repo.serverRepoId,
        issueNumber: normalizedIssueNumber,
      },
    },
  })
  if (!issue) {
    throw taskContextError("issue not found", 404, "issue_not_found")
  }

  const tasks = await store.getIssueTaskContext({
    gitServerId: repo.gitServerId,
    repositoryId: repo.serverRepoId,
    issueNumber: normalizedIssueNumber,
    ...(normalizedPhase ? { action: normalizedPhase } : { actions: TASK_CONTEXT_PHASES }),
  })
  if (normalizedPhase) {
    return {
      status: 200,
      body: {
        repositoryId: repo.id,
        issueNumber: normalizedIssueNumber,
        phase: normalizedPhase,
        tasks,
      },
    }
  }
  return {
    status: 200,
    body: {
      repositoryId: repo.id,
      issueNumber: normalizedIssueNumber,
      phases: TASK_CONTEXT_PHASES.map((phaseName) => ({
        phase: phaseName,
        tasks: tasks.filter((task) => task.action === phaseName),
      })),
    },
  }
}

export {
  getTaskContext,
  TASK_CONTEXT_PHASES,
}
