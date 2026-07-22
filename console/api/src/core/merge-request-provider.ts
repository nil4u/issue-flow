// @ts-nocheck
import { issueFlowMarkers } from "./provenance-marker.js"
import { githubRepoPath, gitlabProjectPath, providerApiError, providerFetch, uniqueMentionUsers } from "./provider-api.js"

function normalizeUser(user = {}) {
  return {
    id: String(user.id || user.node_id || ""),
    username: user.username || user.login || "",
    name: user.name || user.display_name || user.username || user.login || "",
    avatarUrl: user.avatar_url || "",
    url: user.web_url || user.html_url || "",
  }
}

function normalizeLabels(labels = []) {
  return (Array.isArray(labels) ? labels : []).map((label) => typeof label === "string" ? label : label && label.name).filter(Boolean)
}

function planPreview(body, labels) {
  const sourceIssueNumber = issueFlowMarkers(body).sourceIssueNumber
  return {
    sourceIssueNumber,
    previewable: sourceIssueNumber > 0 && labels.includes("mr-by::plan"),
  }
}

function normalizeGithubMergeRequest(pullRequest = {}) {
  const body = pullRequest.body || ""
  const labels = normalizeLabels(pullRequest.labels)
  const merged = Boolean(pullRequest.merged_at || pullRequest.merged)
  return {
    id: String(pullRequest.id || ""), number: Number(pullRequest.number), title: pullRequest.title || "", body,
    state: merged ? "merged" : pullRequest.state || "", draft: Boolean(pullRequest.draft), merged,
    author: normalizeUser(pullRequest.user), sourceBranch: pullRequest.head && pullRequest.head.ref || "",
    targetBranch: pullRequest.base && pullRequest.base.ref || "", headSha: pullRequest.head && pullRequest.head.sha || "",
    webUrl: pullRequest.html_url || "", labels, ...planPreview(body, labels),
    commentsCount: Number(pullRequest.comments || pullRequest.review_comments || 0), commitsCount: Number(pullRequest.commits || 0),
    changedFilesCount: Number(pullRequest.changed_files || 0), additions: Number(pullRequest.additions || 0), deletions: Number(pullRequest.deletions || 0),
    mergeable: pullRequest.mergeable === null || pullRequest.mergeable === undefined ? null : Boolean(pullRequest.mergeable),
    mergeStatus: pullRequest.mergeable_state || "",
    createdAt: pullRequest.created_at || "", updatedAt: pullRequest.updated_at || "", mergedAt: pullRequest.merged_at || "", closedAt: pullRequest.closed_at || "",
  }
}

function normalizeGitlabMergeRequest(mergeRequest = {}) {
  const body = mergeRequest.description || ""
  const labels = normalizeLabels(mergeRequest.labels)
  const merged = mergeRequest.state === "merged" || Boolean(mergeRequest.merged_at)
  return {
    id: String(mergeRequest.id || ""), number: Number(mergeRequest.iid), title: mergeRequest.title || "", body,
    state: merged ? "merged" : mergeRequest.state === "opened" ? "open" : mergeRequest.state || "",
    draft: Boolean(mergeRequest.draft || mergeRequest.work_in_progress), merged, author: normalizeUser(mergeRequest.author),
    sourceBranch: mergeRequest.source_branch || "", targetBranch: mergeRequest.target_branch || "",
    headSha: mergeRequest.sha || mergeRequest.diff_refs && mergeRequest.diff_refs.head_sha || "", webUrl: mergeRequest.web_url || "",
    labels, ...planPreview(body, labels), commentsCount: Number(mergeRequest.user_notes_count || 0),
    commitsCount: Number(mergeRequest.commits_count || 0), changedFilesCount: Number.parseInt(String(mergeRequest.changes_count || "0"), 10) || 0,
    additions: 0, deletions: 0,
    mergeable: mergeRequest.has_conflicts === true ? false : null,
    mergeStatus: mergeRequest.detailed_merge_status || mergeRequest.merge_status || "",
    approvedBy: (mergeRequest.approved_by || []).map((item) => normalizeUser(item.user || item)),
    diffRefs: mergeRequest.diff_refs ? { baseSha: mergeRequest.diff_refs.base_sha || "", startSha: mergeRequest.diff_refs.start_sha || "", headSha: mergeRequest.diff_refs.head_sha || "" } : undefined,
    createdAt: mergeRequest.created_at || "", updatedAt: mergeRequest.updated_at || "", mergedAt: mergeRequest.merged_at || "", closedAt: mergeRequest.closed_at || "",
  }
}

function githubMergeRequestPermissions(repository = {}, currentUser = {}, mergeRequest = {}, reviews = []) {
  const permissions = repository.permissions || {}
  const canManage = Boolean(permissions.admin || permissions.maintain || permissions.push)
  const isAuthor = String(currentUser.login || "").toLowerCase() === String(mergeRequest.user && mergeRequest.user.login || "").toLowerCase()
  const currentUsername = String(currentUser.login || "").toLowerCase()
  const hasApproved = (Array.isArray(reviews) ? reviews : []).some((review) => String(review.user && review.user.login || "").toLowerCase() === currentUsername && review.state === "APPROVED")
  return { canMerge: canManage, canClose: canManage || Boolean(permissions.triage) || isAuthor, canApprove: Boolean(currentUsername) && !isAuthor && Boolean(permissions.pull || permissions.triage || canManage), hasApproved }
}

function gitlabMergeRequestPermissions(project = {}, currentUser = {}, mergeRequest = {}, approvals = {}) {
  const accessLevel = Math.max(Number(project.permissions && project.permissions.project_access && project.permissions.project_access.access_level || 0), Number(project.permissions && project.permissions.group_access && project.permissions.group_access.access_level || 0))
  const isAuthor = String(currentUser.id || "") === String(mergeRequest.author && mergeRequest.author.id || "")
  return { canMerge: mergeRequest.user && typeof mergeRequest.user.can_merge === "boolean" ? mergeRequest.user.can_merge : accessLevel >= 30, canClose: accessLevel >= 30 || isAuthor, canApprove: typeof approvals.user_can_approve === "boolean" ? approvals.user_can_approve : accessLevel >= 20 && !isAuthor, hasApproved: Boolean(approvals.user_has_approved) }
}

async function listProviderMergeRequests(server, repo, state = "open") {
  if (server.type === "github") {
    const providerState = state === "open" ? "open" : state === "closed" || state === "merged" ? "closed" : "all"
    const result = await providerFetch(server, "GET", `${githubRepoPath(repo)}/pulls?state=${providerState}&per_page=100&sort=updated&direction=desc`)
    return (Array.isArray(result) ? result : []).map(normalizeGithubMergeRequest).filter((item) => {
      if (state === "merged") return item.merged
      if (state === "closed") return !item.merged
      return true
    })
  }
  if (server.type === "gitlab") {
    const providerState = state === "open" ? "opened" : state === "all" ? "all" : state
    const result = await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/merge_requests?scope=all&state=${encodeURIComponent(providerState)}&per_page=100&order_by=updated_at&sort=desc`)
    return (Array.isArray(result) ? result : []).map(normalizeGitlabMergeRequest)
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function listProviderMentionUsers(server, repo, mergeRequestNumber) {
  if (server.type === "gitlab") {
    const root = gitlabProjectPath(repo)
    const [members, participants] = await Promise.all([
      providerFetch(server, "GET", `${root}/members/all?per_page=100`).catch(() => []),
      providerFetch(server, "GET", `${root}/merge_requests/${mergeRequestNumber}/participants`).catch(() => []),
    ])
    return uniqueMentionUsers([...(Array.isArray(members) ? members : []), ...(Array.isArray(participants) ? participants : [])])
  }
  if (server.type === "github") {
    const root = githubRepoPath(repo)
    const [members, pullRequest, issueComments, reviewComments] = await Promise.all([
      providerFetch(server, "GET", `${root}/collaborators?affiliation=all&per_page=100`).catch(() => providerFetch(server, "GET", `${root}/contributors?per_page=100`).catch(() => [])),
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}`).catch(() => ({})),
      providerFetch(server, "GET", `${root}/issues/${mergeRequestNumber}/comments?per_page=100`).catch(() => []),
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}/comments?per_page=100`).catch(() => []),
    ])
    return uniqueMentionUsers([
      ...(Array.isArray(members) ? members : []),
      pullRequest.user,
      ...(Array.isArray(pullRequest.requested_reviewers) ? pullRequest.requested_reviewers : []),
      ...(Array.isArray(issueComments) ? issueComments.map((comment) => comment.user) : []),
      ...(Array.isArray(reviewComments) ? reviewComments.map((comment) => comment.user) : []),
    ].filter(Boolean))
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

function normalizeGithubFile(file = {}) {
  return { path: file.filename || "", oldPath: file.previous_filename || file.filename || "", status: file.status || "modified", additions: Number(file.additions || 0), deletions: Number(file.deletions || 0), patch: file.patch || "", collapsed: false, truncated: !file.patch }
}

function countPatchChanges(patch = "") {
  let additions = 0
  let deletions = 0
  for (const line of String(patch || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1
  }
  return { additions, deletions }
}

function normalizeGitlabFile(file = {}, options = {}) {
  const patch = file.diff || ""
  return { path: file.new_path || "", oldPath: file.old_path || file.new_path || "", status: file.new_file ? "added" : file.deleted_file ? "removed" : file.renamed_file ? "renamed" : "modified", ...countPatchChanges(patch), patch, collapsed: options.raw !== true && file.too_large !== true && (file.collapsed === true || !patch), truncated: file.too_large === true }
}

async function getProviderMergeRequestFileDiff(server, repo, mergeRequestNumber, path) {
  if (server.type !== "gitlab") throw providerApiError("expanded diffs are only supported for GitLab", 400)
  const root = `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}`
  const changes = await providerFetch(server, "GET", `${root}/changes?access_raw_diffs=true`)
  const file = (Array.isArray(changes && changes.changes) ? changes.changes : []).find((candidate) => candidate && (candidate.new_path === path || candidate.old_path === path))
  if (!file) throw providerApiError("merge request file not found", 404)
  return normalizeGitlabFile(file, { raw: true })
}

function normalizeGithubComment(comment = {}, type = "comment") {
  const id = String(comment.id || "")
  const rootId = String(comment.in_reply_to_id || comment.id || "")
  return { id, type, body: comment.body || "", state: comment.state || "", author: normalizeUser(comment.user), path: comment.path || "", oldPath: "", line: Number(comment.line || comment.original_line || 0), side: comment.side || "", createdAt: comment.submitted_at || comment.created_at || "", resolved: false, discussionId: type === "inline" ? `review-comment:${rootId}` : `${type}:${id}`, discussionRoot: !comment.in_reply_to_id }
}

function normalizeGitlabComment(note = {}, discussion = {}, rootPosition = {}) {
  const position = note.position || rootPosition || {}
  return { id: String(note.id || ""), type: position.new_path || position.old_path ? "inline" : "comment", body: note.body || "", state: note.resolved ? "resolved" : "", author: normalizeUser(note.author), path: position.new_path || position.old_path || "", oldPath: position.old_path || "", line: Number(position.new_line || position.old_line || 0), side: position.new_line ? "RIGHT" : position.old_line ? "LEFT" : "", createdAt: note.created_at || "", resolved: Boolean(note.resolved), discussionId: String(discussion.id || note.discussion_id || note.id || ""), discussionRoot: Boolean(discussion.rootNoteId ? String(note.id) === String(discussion.rootNoteId) : true) }
}

async function hydrateGitlabAvatars(server, detail) {
  const users = [detail.mergeRequest.author, ...detail.comments.map((comment) => comment.author)]
  const missingUserIds = [...new Set(users.filter((user) => user && user.id && !user.avatarUrl).map((user) => user.id))]
  if (!missingUserIds.length) return detail
  const profiles = await Promise.all(missingUserIds.map(async (userId) => {
    const profile = await providerFetch(server, "GET", `/users/${encodeURIComponent(userId)}`).catch(() => undefined)
    return profile ? [userId, normalizeUser(profile)] : undefined
  }))
  const profilesById = new Map(profiles.filter(Boolean))
  const hydrateUser = (user) => profilesById.has(user.id) ? { ...user, ...profilesById.get(user.id) } : user
  return {
    ...detail,
    mergeRequest: { ...detail.mergeRequest, author: hydrateUser(detail.mergeRequest.author) },
    comments: detail.comments.map((comment) => ({ ...comment, author: hydrateUser(comment.author) })),
  }
}

async function getProviderMergeRequest(server, repo, mergeRequestNumber) {
  if (server.type === "github") {
    const root = githubRepoPath(repo)
    const [pullRequest, files, issueComments, reviews, inlineComments, repository, currentUser] = await Promise.all([
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}`),
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}/files?per_page=100`),
      providerFetch(server, "GET", `${root}/issues/${mergeRequestNumber}/comments?per_page=100`),
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}/reviews?per_page=100`),
      providerFetch(server, "GET", `${root}/pulls/${mergeRequestNumber}/comments?per_page=100`),
      providerFetch(server, "GET", root).catch(() => ({})),
      providerFetch(server, "GET", "/user").catch(() => ({})),
    ])
    const comments = [
      ...(Array.isArray(issueComments) ? issueComments : []).map((item) => normalizeGithubComment(item)),
      ...(Array.isArray(reviews) ? reviews : []).map((item) => normalizeGithubComment(item, "review")),
      ...(Array.isArray(inlineComments) ? inlineComments : []).map((item) => normalizeGithubComment(item, "inline")),
    ].filter((item) => item.body || item.type === "review").sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    return { mergeRequest: { ...normalizeGithubMergeRequest(pullRequest), permissions: githubMergeRequestPermissions(repository, currentUser, pullRequest, reviews) }, files: (Array.isArray(files) ? files : []).map(normalizeGithubFile), comments }
  }
  if (server.type === "gitlab") {
    const root = `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}`
    const [mergeRequest, changes, discussions, approvals, project, currentUser] = await Promise.all([
      providerFetch(server, "GET", root),
      providerFetch(server, "GET", `${root}/changes`),
      providerFetch(server, "GET", `${root}/discussions?per_page=100`),
      providerFetch(server, "GET", `${root}/approvals`).catch(() => undefined),
      providerFetch(server, "GET", gitlabProjectPath(repo)).catch(() => ({})),
      providerFetch(server, "GET", "/user").catch(() => ({})),
    ])
    if (!mergeRequest.diff_refs && changes && changes.diff_refs) mergeRequest.diff_refs = changes.diff_refs
    if (approvals) mergeRequest.approved_by = approvals.approved_by
    const comments = (Array.isArray(discussions) ? discussions : []).flatMap((discussion) => {
      const notes = (Array.isArray(discussion.notes) ? discussion.notes : []).filter((note) => !note.system)
      const rootNote = notes[0] || {}
      const rootPosition = rootNote.position || {}
      return notes.map((note) => normalizeGitlabComment(note, { id: discussion.id, rootNoteId: rootNote.id }, rootPosition))
    }).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    return hydrateGitlabAvatars(server, { mergeRequest: { ...normalizeGitlabMergeRequest(mergeRequest), permissions: gitlabMergeRequestPermissions(project, currentUser, mergeRequest, approvals) }, files: (Array.isArray(changes && changes.changes) ? changes.changes : []).map(normalizeGitlabFile), comments })
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function submitProviderMergeRequestReview(server, repo, mergeRequest, input = {}) {
  const body = String(input.body || "").trim()
  const comments = (Array.isArray(input.comments) ? input.comments : []).filter((comment) => comment && comment.body && comment.path && comment.line)
  if (!body && !comments.length && input.action !== "approve") throw providerApiError("review content is required", 400)
  if (server.type === "github") {
    return providerFetch(server, "POST", `${githubRepoPath(repo)}/pulls/${mergeRequest.number}/reviews`, {
      event: input.action === "approve" ? "APPROVE" : "COMMENT", body,
      comments: comments.map((comment) => ({ body: String(comment.body), path: String(comment.path), line: Number(comment.line), side: comment.side === "LEFT" ? "LEFT" : "RIGHT" })),
    })
  }
  if (server.type === "gitlab") {
    const root = `${gitlabProjectPath(repo)}/merge_requests/${mergeRequest.number}`
    const diffRefs = mergeRequest.diffRefs || {}
    const submitted = []
    for (const comment of comments) {
      const left = comment.side === "LEFT"
      submitted.push(await providerFetch(server, "POST", `${root}/discussions`, { body: String(comment.body), position: { position_type: "text", base_sha: diffRefs.baseSha, start_sha: diffRefs.startSha, head_sha: diffRefs.headSha, old_path: String(comment.oldPath || comment.path), new_path: String(comment.path), ...(left ? { old_line: Number(comment.line) } : { new_line: Number(comment.line) }) } }))
    }
    if (body) submitted.push(await providerFetch(server, "POST", `${root}/notes`, { body }))
    if (input.action === "approve") submitted.push(await providerFetch(server, "POST", `${root}/approve`, {}))
    return { submitted }
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function submitProviderMergeRequestComment(server, repo, mergeRequestNumber, body) {
  if (server.type === "github") {
    return providerFetch(server, "POST", `${githubRepoPath(repo)}/issues/${mergeRequestNumber}/comments`, { body })
  }
  if (server.type === "gitlab") {
    return providerFetch(server, "POST", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}/notes`, { body })
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function submitProviderMergeRequestReply(server, repo, mergeRequestNumber, target = {}, body) {
  if (server.type === "github") {
    if (target.type === "inline") {
      return providerFetch(server, "POST", `${githubRepoPath(repo)}/pulls/${mergeRequestNumber}/comments/${encodeURIComponent(target.commentId)}/replies`, { body })
    }
    return providerFetch(server, "POST", `${githubRepoPath(repo)}/issues/${mergeRequestNumber}/comments`, { body })
  }
  if (server.type === "gitlab") {
    if (!target.discussionId) throw providerApiError("discussion id is required", 400)
    return providerFetch(server, "POST", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}/discussions/${encodeURIComponent(target.discussionId)}/notes`, { body })
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

function splitGithubCommitMessage(commitMessage = "") {
  const [title, ...bodyLines] = String(commitMessage || "").split("\n")
  return { title: title.trim(), body: bodyLines.join("\n").trim() }
}

async function mergeProviderMergeRequest(server, repo, mergeRequestNumber, input = {}) {
  const method = input.method === "squash" ? "squash" : "merge"
  const commitMessage = String(input.commitMessage || "").trim()
  if (server.type === "github") {
    const message = splitGithubCommitMessage(commitMessage)
    const result = await providerFetch(server, "PUT", `${githubRepoPath(repo)}/pulls/${mergeRequestNumber}/merge`, { merge_method: method, ...(message.title ? { commit_title: message.title } : {}), ...(message.body ? { commit_message: message.body } : {}) })
    if (!result || result.merged !== true) throw providerApiError("pull request could not be merged", 409, result)
    return result
  }
  if (server.type === "gitlab") {
    const result = await providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}/merge`, { should_remove_source_branch: true, squash: method === "squash", ...(commitMessage ? method === "squash" ? { squash_commit_message: commitMessage } : { merge_commit_message: commitMessage } : {}) })
    if (!result || result.state !== "merged") throw providerApiError("merge request could not be merged", 409, result)
    return result
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function updateProviderMergeRequestState(server, repo, mergeRequestNumber, action) {
  if (action !== "close" && action !== "reopen") throw providerApiError("unsupported merge request state action", 400)
  if (server.type === "github") {
    return providerFetch(server, "PATCH", `${githubRepoPath(repo)}/pulls/${mergeRequestNumber}`, { state: action === "close" ? "closed" : "open" })
  }
  if (server.type === "gitlab") {
    return providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/merge_requests/${mergeRequestNumber}`, { state_event: action })
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

export { getProviderMergeRequest, getProviderMergeRequestFileDiff, listProviderMentionUsers, listProviderMergeRequests, mergeProviderMergeRequest, normalizeGithubMergeRequest, normalizeGitlabMergeRequest, submitProviderMergeRequestComment, submitProviderMergeRequestReply, submitProviderMergeRequestReview, updateProviderMergeRequestState }
