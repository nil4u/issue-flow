// @ts-nocheck
import fs from "node:fs"
import path from "node:path"
import { createProviderIssue, createProviderIssueComment, getProviderIssue, listProviderIssueLabels, listProviderIssueMentionUsers, listProviderIssues, updateProviderIssue, updateProviderIssueState } from "./issue-provider.js"
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
  if (!userId) throw requestError("login required", 401, "login_required")
  if (!session || !session.token || session.userId !== userId || session.gitServerId !== gitServerId) throw requestError("current Git credential is required", 401, "git_credential_required")
  const repo = await store.findRepositoryByProject({ gitServerId, projectId })
  if (!repo || !await store.userCanAccessRepo(userId, repo.id)) throw requestError("repository not found", 404, "repository_not_found")
  const server = await store.getGitServer(repo.gitServerId, { includeSecret: true })
  if (!server) throw requestError("git server not found", 404, "git_server_not_found")
  return { repo, server: { ...server, userToken: session.token } }
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

function automationOptimizationSourceIssue(body) {
  const match = String(body || "").match(/<!--\s*issue-flow:automation-optimization\s+source-issue=(\d+)\s*-->/i)
  return match ? Number(match[1]) : 0
}

function optimizationStateFromLabels(labels = []) {
  const names = labels.map((label) => typeof label === "string" ? label : label?.name).filter(Boolean)
  if (names.includes("optimization::analyzed")) return "analyzed"
  if (names.includes("optimization::analyzing")) return "analyzing"
  return ""
}

function labelsWithOptimizationState(labels = [], state) {
  return [...labels.map((label) => typeof label === "string" ? label : label?.name).filter((name) => name && !name.startsWith("optimization::")), state]
}

function labelsWithoutOptimizationState(labels = []) {
  return labels.map((label) => typeof label === "string" ? label : label?.name).filter((name) => name && !name.startsWith("optimization::"))
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
  return { issues: await listProviderIssues(server, repo, { state, search: input.search }), repository: { id: repo.id, fullName: repo.fullName, provider: server.type }, state }
}

async function listIssueLabels({ store, gitServerId, projectId, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { labels: await listProviderIssueLabels(server, repo) }
}

async function getIssue({ store, gitServerId, projectId, issueNumber, userId, session }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const [detail, mergeRequests] = await Promise.all([
    getProviderIssue(server, repo, normalizedIssueNumber),
    listIssuePullRequestSummaries(store, repo, normalizedIssueNumber),
  ])
  const [bodyHtml, commentHtml] = await Promise.all([
    renderProviderMarkdown(server, repo, detail.issue.body),
    Promise.all(detail.comments.map((comment) => renderProviderMarkdown(server, repo, comment.body))),
  ])
  return {
    ...detail,
    issue: { ...detail.issue, bodyHtml },
    comments: detail.comments.map((comment, index) => ({ ...comment, bodyHtml: commentHtml[index] || "" })),
    mergeRequests,
    repository: { id: repo.id, fullName: repo.fullName, provider: server.type, webUrl: repo.webUrl || repo.url || "" },
  }
}

async function createAutomationOptimizationIssue({ store, gitServerId, projectId, issueNumber, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const normalizedIssueNumber = normalizeIssueNumber(issueNumber)
  const local = await localIssueWithStats(store, repo, normalizedIssueNumber)
  const phases = automationOptimizationPhases(local.issue, local.stats)
  if (!phases.length) throw requestError("issue has no phase eligible for automation optimization", 409, "automation_optimization_not_eligible")

  const providerIssues = await listProviderIssues(server, repo, { state: "all" })
  const sourceIssue = providerIssues.find((issue) => issue.number === normalizedIssueNumber)
    || (await getProviderIssue(server, repo, normalizedIssueNumber)).issue
  if (parseProposalMarker(sourceIssue.body)) throw requestError("optimization-generated issue is not eligible for automation optimization", 409, "automation_optimization_not_eligible")
  const optimizationState = optimizationStateFromLabels(sourceIssue.labels)
  if (optimizationState) throw requestError(`issue automation optimization is ${optimizationState}`, 409, "automation_optimization_already_started")
  const title = `优化任务自动化：#${normalizedIssueNumber} ${local.issue.title || ""}`.trim()
  const body = automationOptimizationIssueBody({ sourceIssue: local.issue, phases })
  const issue = await createProviderIssue(server, repo, { title, body, labels: AUTOMATION_OPTIMIZATION_LABELS })
  await updateProviderIssue(server, repo, normalizedIssueNumber, {
    labels: labelsWithOptimizationState(sourceIssue.labels, "optimization::analyzing"),
  })
  return { issue, created: true }
}

async function listAutomationOptimizations({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  const issueNumbers = [...new Set((Array.isArray(input.issueNumbers) ? input.issueNumbers : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]
  if (!issueNumbers.length) return { items: [] }

  const sourceIssues = await store.db.issue.findMany({
    where: {
      gitServerId: repo.gitServerId,
      repositoryId: repo.serverRepoId,
      issueNumber: { in: issueNumbers },
    },
  })
  const stats = await store.db.issueStat.findMany({ where: { id: { in: sourceIssues.map((issue) => issue.id) } } })
  const statsById = new Map(stats.map((item) => [item.id, item]))
  const providerIssues = await listProviderIssues(server, repo, { state: "all" })
  const providerIssueByNumber = new Map(providerIssues.map((issue) => [issue.number, issue]))
  const optimizationBySource = new Map()
  for (const issue of providerIssues) {
    if (!issue.labels.some((label) => label.name === "type::optimization")) continue
    const sourceIssueNumber = automationOptimizationSourceIssue(issue.body)
    if (!sourceIssueNumber) continue
    const current = optimizationBySource.get(sourceIssueNumber)
    if (!current || issue.state === "open" || current.state !== "open" && Number(issue.number) > Number(current.number)) {
      optimizationBySource.set(sourceIssueNumber, issue)
    }
  }

  return {
    items: sourceIssues.filter((issue) => {
      const providerIssue = providerIssueByNumber.get(issue.issueNumber)
      return issue.type !== "optimization" && !parseProposalMarker(providerIssue && providerIssue.body)
    }).map((issue) => {
      const phases = automationOptimizationPhases(issue, statsById.get(issue.id))
      const optimizationIssue = optimizationBySource.get(issue.issueNumber)
      const optimizationState = optimizationStateFromLabels(providerIssueByNumber.get(issue.issueNumber)?.labels || [])
      return {
        sourceIssueNumber: issue.issueNumber,
        phases,
        status: optimizationState || (phases.length ? "available" : "unavailable"),
        optimizationIssueNumber: optimizationIssue?.number || 0,
        optimizationIssueUrl: optimizationIssue?.webUrl || "",
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
  if (action === "close" && issue.labels.some((label) => label.name === "type::optimization")) {
    const sourceIssueNumber = automationOptimizationSourceIssue(issue.body)
    if (sourceIssueNumber) {
      const sourceIssue = (await getProviderIssue(server, repo, sourceIssueNumber)).issue
      await updateProviderIssue(server, repo, sourceIssueNumber, { labels: labelsWithoutOptimizationState(sourceIssue.labels) })
    }
  }
  return { issue }
}

async function renderIssueMarkdown({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { html: await renderProviderMarkdown(server, repo, String(input.body || "")) }
}

export {
  automationOptimizationIssueBody,
  automationOptimizationPhases,
  labelsWithOptimizationState,
  createAutomationOptimizationIssue,
  createIssue,
  getIssue,
  getIssueMentionUsers,
  listIssueLabels,
  listIssues,
  listAutomationOptimizations,
  renderIssueMarkdown,
  submitIssueComment,
  updateIssue,
  updateIssueState,
}
