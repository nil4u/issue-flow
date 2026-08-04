// @ts-nocheck
import fs from "node:fs"
import path from "node:path"
import domain from "issue-flow/domain"
import { createProviderIssue, createProviderIssueComment, getProviderIssue, getProviderIssueSnapshot, listProviderIssueComments, listProviderIssueLabels, listProviderIssueMentionUsers, listProviderIssuesPage, updateProviderIssue, updateProviderIssueState } from "./issue-provider.js"
import { applyProviderIssueSnapshotToFacts } from "./issue-projection.js"
import { applyWorkflowChanges, normalizeWorkflowChanges } from "./managed-issue-labels.js"
import { applyOptimizationIssueLifecycle } from "./optimization-lifecycle.js"
import { parseProposalMarker } from "./optimization-artifact.js"
import { issueFlowPluginDir } from "./plugin-paths.js"
import { renderProviderMarkdown } from "./provider-api.js"
import { listIssuePullRequestSummaries } from "./pull-request-facts.js"

const AUTOMATION_OPTIMIZATION_PHASES = [
  ["triage", "triageTaskTurns"],
  ["plan", "planTaskTurns"],
  ["build", "buildTaskTurns"],
  ["review", "reviewTaskTurns"],
]
const AUTOMATION_OPTIMIZATION_LABELS = [
  "type::optimization",
  "status::active",
  "flow::plan",
  "automation::build",
  "priority::p2",
  "size::M",
]

function requestError(message, status = 400, code = "issue_error") {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function normalizeIssueNumber(value) {
  const number = Number.parseInt(String(value || ""), 10)
  if (!Number.isFinite(number) || number <= 0) throw requestError("issue number must be positive")
  return number
}

async function requireIssueContext(store, gitServerId, projectId, userId, session) {
  const repo = await requireIssueRepository(store, gitServerId, projectId, userId)
  if (!session || !session.token || session.userId !== userId || session.gitServerId !== gitServerId) throw requestError("current Git credential is required", 401, "git_credential_required")
  const server = await store.getGitServer(repo.gitServerId, { includeSecret: true })
  if (!server) throw requestError("git server not found", 404, "git_server_not_found")
  return { repo, server: { ...server, userToken: session.token } }
}

async function requireIssueRepository(store, gitServerId, projectId, userId) {
  if (!userId) throw requestError("login required", 401, "login_required")
  const repo = await store.findRepositoryByProject({ gitServerId, projectId })
  if (!repo || !await store.userCanAccessRepo(userId, repo.id)) throw requestError("repository not found", 404, "repository_not_found")
  return repo
}

async function localIssueWithStats(store, repo, issueNumber) {
  const issue = await store.db.issue.findUnique({
    where: {
      gitServerId_repositoryId_issueNumber: {
        gitServerId: repo.gitServerId,
        repositoryId: repo.serverRepoId,
        issueNumber,
      },
    },
  })
  if (!issue) return {}
  return { issue, stats: await store.getIssueStats(issue.id) }
}

function automationOptimizationPhases(issue, stats) {
  if (!issue || issue.type === "optimization" || !stats) return []
  return AUTOMATION_OPTIMIZATION_PHASES
    .map(([phase, field]) => ({ phase, turns: Number(stats[field] || 0) }))
    .filter((item) => item.turns > 1)
}

function isOpenIssueState(state) {
  return state === "open" || state === "opened"
}

function optimizationStateFromLabels(labels = []) {
  return domain.managedLabelValue(labels, "optimizationState", (value) => value.toLowerCase())
}

function automationOptimizationTemplatePath() {
  return path.join(issueFlowPluginDir(), "skills", "issue-flow", "assets", "agentrix", "runtime", "templates", "type-optimization.md")
}

function automationOptimizationIssueBody({ sourceIssue, phases }) {
  const phaseTurns = phases.map((item) => `- \`${item.phase}\`：${item.turns} Turns`).join("\n")
  return fs.readFileSync(automationOptimizationTemplatePath(), "utf8")
    .replaceAll("{{sourceIssueNumber}}", String(sourceIssue.issueNumber))
    .replaceAll("{{sourceIssueTitle}}", String(sourceIssue.title || ""))
    .replaceAll("{{phaseTurns}}", phaseTurns)
}

async function listIssues({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const state = ["open", "closed", "all"].includes(input.state) ? input.state : "open"
  const result = await listProviderIssuesPage(server, repo, { state, search: input.search, page: input.page, perPage: input.perPage })
  return { ...result, repository: { id: repo.id, fullName: repo.fullName, provider: server.type }, state }
}

async function listIssueLabels({ store, gitServerId, projectId, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { labels: await listProviderIssueLabels(server, repo) }
}

async function getIssue({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const [detail, mergeRequests] = await Promise.all([
    getProviderIssue(server, repo, normalizedIssueNumber, { includeComments: false, includeLabels: false }),
    listIssuePullRequestSummaries(store, repo, normalizedIssueNumber),
  ])
  const bodyHtml = await renderProviderMarkdown(server, repo, detail.issue.body)
  return {
    ...detail,
    issue: { ...detail.issue, bodyHtml },
    mergeRequests,
    repository: { id: repo.id, fullName: repo.fullName, provider: server.type, webUrl: repo.webUrl || repo.url || "" },
  }
}

async function getIssueComments({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const comments = await listProviderIssueComments(server, repo, normalizeIssueNumber(issueNumber))
  const commentHtml = await Promise.all(comments.map((comment) => renderProviderMarkdown(server, repo, comment.body)))
  return { comments: comments.map((comment, index) => ({ ...comment, bodyHtml: commentHtml[index] || "" })) }
}

async function createAutomationOptimizationIssue({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const local = await localIssueWithStats(store, repo, normalizedIssueNumber)
  const phases = automationOptimizationPhases(local.issue, local.stats)
  if (!phases.length) throw requestError("issue has no phase eligible for automation optimization", 409, "automation_optimization_not_eligible")

  const sourceIssue = await getProviderIssueSnapshot(server, repo, normalizedIssueNumber)
  if (parseProposalMarker(sourceIssue.body)) throw requestError("optimization-generated issue is not eligible for automation optimization", 409, "automation_optimization_not_eligible")
  const optimizationState = optimizationStateFromLabels(sourceIssue.labels)
  const existingOptimizationIssues = await store.db.issue.findMany({
    where: {
      gitServerId: repo.gitServerId,
      repositoryId: repo.serverRepoId,
      type: "optimization",
      optimizationSourceIssueNumber: normalizedIssueNumber,
    },
  })
  const optimizationIsActive = optimizationState === "analyzed"
    || existingOptimizationIssues.some((issue) => isOpenIssueState(issue.state))
    || optimizationState === "analyzing" && !existingOptimizationIssues.length
  if (optimizationIsActive) throw requestError(`issue automation optimization is ${optimizationState}`, 409, "automation_optimization_already_started")
  const title = `优化任务自动化：#${normalizedIssueNumber} ${local.issue.title || ""}`.trim()
  const body = automationOptimizationIssueBody({ sourceIssue: local.issue, phases })
  const issue = await createProviderIssue(server, repo, { title, body, labels: AUTOMATION_OPTIMIZATION_LABELS })
  await applyProviderIssueSnapshotToFacts(store, repo, issue)
  if (server.type !== "gitlab") await applyOptimizationIssueLifecycle({ server, repo, issue })
  return { issue, created: true }
}

async function listAutomationOptimizations({ store, gitServerId, projectId, userId, session, input = {} }) {
  const repo = await requireIssueRepository(store, gitServerId, projectId, userId)
  const issueNumbers = [...new Set((Array.isArray(input.issueNumbers) ? input.issueNumbers : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]

  const sourceIssues = await store.db.issue.findMany({
    where: {
      gitServerId: repo.gitServerId,
      repositoryId: repo.serverRepoId,
      ...(issueNumbers.length ? { issueNumber: { in: issueNumbers } } : {}),
    },
  })
  const stats = await store.db.issueStat.findMany({ where: { id: { in: sourceIssues.map((issue) => issue.id) } } })
  const statsById = new Map(stats.map((item) => [item.id, item]))
  const eligibleIssues = sourceIssues.filter((issue) => issue.type !== "optimization" && !issue.optimizationSourceIssueNumber && automationOptimizationPhases(issue, statsById.get(issue.id)).length)
  const optimizationIssues = eligibleIssues.length
    ? await store.db.issue.findMany({
        where: {
          gitServerId: repo.gitServerId,
          repositoryId: repo.serverRepoId,
          type: "optimization",
          optimizationSourceIssueNumber: { in: eligibleIssues.map((issue) => issue.issueNumber) },
        },
        orderBy: { issueNumber: "asc" },
      })
    : []
  const optimizationBySource = new Map()
  for (const issue of optimizationIssues) {
    const sourceIssueNumber = issue.optimizationSourceIssueNumber
    if (!sourceIssueNumber) continue
    const current = optimizationBySource.get(sourceIssueNumber)
    if (!current || isOpenIssueState(issue.state) || !isOpenIssueState(current.state) && Number(issue.issueNumber) > Number(current.issueNumber)) {
      optimizationBySource.set(sourceIssueNumber, issue)
    }
  }

  return {
    items: eligibleIssues.map((issue) => {
      const phases = automationOptimizationPhases(issue, statsById.get(issue.id))
      const optimizationIssue = optimizationBySource.get(issue.issueNumber)
      const optimizationIssueIsOpen = optimizationIssue && isOpenIssueState(optimizationIssue.state)
      const status = issue.optimizationState === "analyzed"
        ? "analyzed"
        : optimizationIssueIsOpen || issue.optimizationState === "analyzing" && !optimizationIssue
          ? "analyzing"
          : phases.length ? "available" : "unavailable"
      return {
        issue: {
          id: issue.issueId || issue.id,
          number: issue.issueNumber,
          title: issue.title,
          state: issue.state === "closed" ? "closed" : "open",
          author: { id: "", username: "", name: issue.author, avatarUrl: "", url: "" },
        },
        sourceIssueNumber: issue.issueNumber,
        phases,
        status,
        optimizationIssueNumber: status === "available" ? 0 : optimizationIssue?.issueNumber || 0,
        optimizationIssueUrl: "",
      }
    }),
  }
}

async function getIssueMentionUsers({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { users: await listProviderIssueMentionUsers(server, repo, normalizeIssueNumber(issueNumber)) }
}

async function createIssue({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { issue: await createProviderIssue(server, repo, input) }
}

async function updateIssue({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  if (input.title !== undefined && !String(input.title).trim()) throw requestError("issue title is required")
  return { issue: await updateProviderIssue(server, repo, normalizeIssueNumber(issueNumber), input) }
}

async function updateIssueWorkflow({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const changes = normalizeWorkflowChanges(input)
  const current = (await getProviderIssue(server, repo, normalizedIssueNumber)).issue
  const labels = applyWorkflowChanges(current.labels.map((label) => label.name), changes)
  return { issue: await updateProviderIssue(server, repo, normalizedIssueNumber, { labels }) }
}

async function submitIssueComment({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const body = String(input.body || "").trim()
  if (!body) throw requestError("comment body is required")
  return { comment: await createProviderIssueComment(server, repo, normalizeIssueNumber(issueNumber), body) }
}

async function updateIssueState({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const action = input.action === "close" || input.action === "reopen" ? input.action : ""
  if (!action) throw requestError("issue state action must be close or reopen")
  const issue = await updateProviderIssueState(server, repo, normalizedIssueNumber, action)
  if (server.type !== "gitlab") await applyOptimizationIssueLifecycle({ server, repo, issue })
  return { issue }
}

async function renderIssueMarkdown({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { html: await renderProviderMarkdown(server, repo, String(input.body || "")) }
}

export {
  automationOptimizationIssueBody,
  automationOptimizationPhases,
  createAutomationOptimizationIssue,
  createIssue,
  getIssue,
  getIssueComments,
  getIssueMentionUsers,
  listIssueLabels,
  listIssues,
  listAutomationOptimizations,
  renderIssueMarkdown,
  submitIssueComment,
  updateIssue,
  updateIssueWorkflow,
  updateIssueState,
}
