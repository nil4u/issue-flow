// @ts-nocheck
import { getProviderMergeRequest, getProviderMergeRequestFileDiff, listProviderMentionUsers, listProviderMergeRequests, mergeProviderMergeRequest, submitProviderMergeRequestComment, submitProviderMergeRequestReply, submitProviderMergeRequestReview, updateProviderMergeRequestState } from "./merge-request-provider.js"
import { renderProviderMarkdown } from "./provider-api.js"

function requestError(message, status = 400, code = "merge_request_error") {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

function normalizeMergeRequestNumber(value) {
  const number = Number.parseInt(String(value || ""), 10)
  if (!Number.isFinite(number) || number <= 0) throw requestError("merge request number must be positive")
  return number
}

async function requireMergeRequestContext(store, gitServerId, projectId, userId, session) {
  if (!userId) throw requestError("login required", 401, "login_required")
  if (!session || !session.token || session.userId !== userId || session.gitServerId !== gitServerId) {
    throw requestError("current Git credential is required", 401, "git_credential_required")
  }
  const repo = await store.findRepositoryByProject({ gitServerId, projectId })
  if (!repo || !await store.userCanAccessRepo(userId, repo.id)) throw requestError("repository not found", 404, "repository_not_found")
  const server = await store.getGitServer(repo.gitServerId, { includeSecret: true })
  if (!server) throw requestError("git server not found", 404, "git_server_not_found")
  return { repo, server: { ...server, userToken: session.token } }
}

async function listMergeRequests({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const state = ["open", "closed", "merged", "all"].includes(input.state) ? input.state : "open"
  return {
    mergeRequests: await listProviderMergeRequests(server, repo, state),
    repository: { id: repo.id, fullName: repo.fullName, provider: server.type },
    state,
  }
}

async function getMergeRequest({ store, gitServerId, projectId, mergeRequestNumber, userId, session }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const detail = await getProviderMergeRequest(server, repo, normalizeMergeRequestNumber(mergeRequestNumber))
  const [bodyHtml, commentHtml] = await Promise.all([
    renderProviderMarkdown(server, repo, detail.mergeRequest.body),
    Promise.all(detail.comments.map((comment) => renderProviderMarkdown(server, repo, comment.body))),
  ])
  return {
    ...detail,
    mergeRequest: { ...detail.mergeRequest, bodyHtml },
    comments: detail.comments.map((comment, index) => ({ ...comment, bodyHtml: commentHtml[index] || "" })),
    repository: {
      id: repo.id,
      fullName: repo.fullName,
      provider: server.type,
      webUrl: repo.webUrl || repo.url || `${String(server.baseUrl || "").replace(/\/+$/, "")}/${String(repo.fullName || "").replace(/^\/+/, "")}`,
    },
  }
}

async function getMergeRequestMentionUsers({ store, gitServerId, projectId, mergeRequestNumber, userId, session }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  return { users: await listProviderMentionUsers(server, repo, normalizeMergeRequestNumber(mergeRequestNumber)) }
}

async function getMergeRequestFileDiff({ store, gitServerId, projectId, mergeRequestNumber, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const path = String(input.path || "").trim()
  if (!path) throw requestError("merge request file path is required")
  return { file: await getProviderMergeRequestFileDiff(server, repo, normalizeMergeRequestNumber(mergeRequestNumber), path) }
}

async function submitMergeRequestReview({ store, gitServerId, projectId, mergeRequestNumber, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const detail = await getProviderMergeRequest(server, repo, normalizeMergeRequestNumber(mergeRequestNumber))
  if (detail.mergeRequest.state !== "open") throw requestError("merge request is not open", 409)
  return { review: await submitProviderMergeRequestReview(server, repo, detail.mergeRequest, input) }
}

async function submitMergeRequestComment({ store, gitServerId, projectId, mergeRequestNumber, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const body = String(input.body || "").trim()
  if (!body) throw requestError("comment body is required")
  return { comment: await submitProviderMergeRequestComment(server, repo, normalizeMergeRequestNumber(mergeRequestNumber), body) }
}

async function submitMergeRequestReply({ store, gitServerId, projectId, mergeRequestNumber, commentId, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const body = String(input.body || "").trim()
  if (!body) throw requestError("reply body is required")
  return { comment: await submitProviderMergeRequestReply(server, repo, normalizeMergeRequestNumber(mergeRequestNumber), { commentId: String(commentId || ""), discussionId: String(input.discussionId || ""), type: input.type === "inline" ? "inline" : "comment" }, body) }
}

async function renderMergeRequestMarkdown({ store, gitServerId, projectId, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  return { html: await renderProviderMarkdown(server, repo, String(input.body || "")) }
}

async function mergeMergeRequest({ store, gitServerId, projectId, mergeRequestNumber, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  return { merge: await mergeProviderMergeRequest(server, repo, normalizeMergeRequestNumber(mergeRequestNumber), { method: input.method === "squash" ? "squash" : "merge", commitMessage: String(input.commitMessage || "") }) }
}

async function updateMergeRequestState({ store, gitServerId, projectId, mergeRequestNumber, userId, session, input = {} }) {
  const { repo, server } = await requireMergeRequestContext(store, gitServerId, projectId, userId, session)
  const action = input.action === "close" || input.action === "reopen" ? input.action : ""
  if (!action) throw requestError("merge request state action must be close or reopen")
  return { mergeRequest: await updateProviderMergeRequestState(server, repo, normalizeMergeRequestNumber(mergeRequestNumber), action) }
}

export { getMergeRequest, getMergeRequestFileDiff, getMergeRequestMentionUsers, listMergeRequests, mergeMergeRequest, renderMergeRequestMarkdown, submitMergeRequestComment, submitMergeRequestReply, submitMergeRequestReview, updateMergeRequestState }
