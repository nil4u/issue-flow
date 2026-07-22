// @ts-nocheck
import { createProviderIssue, createProviderIssueComment, getProviderIssue, listProviderIssueLabels, listProviderIssueMentionUsers, listProviderIssues, updateProviderIssue, updateProviderIssueState } from "./issue-provider.js"
import { renderProviderMarkdown } from "./provider-api.js"

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
  const detail = await getProviderIssue(server, repo, normalizeIssueNumber(issueNumber))
  const [bodyHtml, commentHtml] = await Promise.all([
    renderProviderMarkdown(server, repo, detail.issue.body),
    Promise.all(detail.comments.map((comment) => renderProviderMarkdown(server, repo, comment.body))),
  ])
  return {
    ...detail,
    issue: { ...detail.issue, bodyHtml },
    comments: detail.comments.map((comment, index) => ({ ...comment, bodyHtml: commentHtml[index] || "" })),
    repository: { id: repo.id, fullName: repo.fullName, provider: server.type, webUrl: repo.webUrl || repo.url || "" },
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
  const action = input.action === "close" || input.action === "reopen" ? input.action : ""
  if (!action) throw requestError("issue state action must be close or reopen")
  return { issue: await updateProviderIssueState(server, repo, normalizeIssueNumber(issueNumber), action) }
}

async function renderIssueMarkdown({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireIssueContext(store, gitServerId, projectId, userId, session)
  return { html: await renderProviderMarkdown(server, repo, String(input.body || "")) }
}

export { createIssue, getIssue, getIssueMentionUsers, listIssueLabels, listIssues, renderIssueMarkdown, submitIssueComment, updateIssue, updateIssueState }
