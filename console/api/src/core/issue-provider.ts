// @ts-nocheck
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

function normalizeLabel(label) {
  if (typeof label === "string") return { name: label, color: "", description: "" }
  return {
    name: String(label && label.name || ""),
    color: String(label && label.color || "").replace(/^#/, ""),
    description: String(label && label.description || ""),
  }
}

function normalizeLabels(labels = []) {
  return (Array.isArray(labels) ? labels : []).map(normalizeLabel).filter((label) => label.name)
}

function normalizeMilestone(milestone) {
  if (!milestone) return null
  return {
    id: String(milestone.id || ""),
    title: String(milestone.title || ""),
    description: String(milestone.description || ""),
    state: milestone.state === "closed" ? "closed" : "open",
    dueAt: milestone.due_on || milestone.due_date || "",
    webUrl: milestone.html_url || milestone.web_url || "",
  }
}

function normalizeReactionCounts(entries = []) {
  const counts = new Map()
  for (const content of entries.map(String).filter(Boolean)) counts.set(content, (counts.get(content) || 0) + 1)
  return [...counts.entries()].map(([content, count]) => ({ content, count }))
}

function normalizeGithubReactions(reactions = {}) {
  return ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]
    .map((content) => ({ content, count: Number(reactions && reactions[content] || 0) }))
    .filter((reaction) => reaction.count > 0)
}

function normalizeGitlabReactions(awards = []) {
  return normalizeReactionCounts((Array.isArray(awards) ? awards : []).map((award) => award && award.name))
}

function normalizeGithubIssue(issue = {}) {
  return {
    id: String(issue.id || ""), number: Number(issue.number || 0), title: issue.title || "", body: issue.body || "",
    state: issue.state === "closed" ? "closed" : "open", author: normalizeUser(issue.user),
    assignees: (Array.isArray(issue.assignees) ? issue.assignees : []).map(normalizeUser), labels: normalizeLabels(issue.labels),
    commentsCount: Number(issue.comments || 0), milestone: normalizeMilestone(issue.milestone), webUrl: issue.html_url || "",
    createdAt: issue.created_at || "", updatedAt: issue.updated_at || "", closedAt: issue.closed_at || "",
  }
}

function normalizeGitlabIssue(issue = {}) {
  return {
    id: String(issue.id || ""), number: Number(issue.iid || 0), title: issue.title || "", body: issue.description || "",
    state: issue.state === "closed" ? "closed" : "open", author: normalizeUser(issue.author),
    assignees: (Array.isArray(issue.assignees) ? issue.assignees : issue.assignee ? [issue.assignee] : []).map(normalizeUser), labels: normalizeLabels(issue.labels),
    commentsCount: Number(issue.user_notes_count || 0), milestone: normalizeMilestone(issue.milestone), webUrl: issue.web_url || "",
    createdAt: issue.created_at || "", updatedAt: issue.updated_at || "", closedAt: issue.closed_at || "",
  }
}

function normalizeGithubComment(comment = {}) {
  return { id: String(comment.id || ""), body: comment.body || "", author: normalizeUser(comment.user), reactions: normalizeGithubReactions(comment.reactions), createdAt: comment.created_at || "", updatedAt: comment.updated_at || "" }
}

function normalizeGitlabComment(note = {}, awards = []) {
  return { id: String(note.id || ""), body: note.body || "", author: normalizeUser(note.author), reactions: normalizeGitlabReactions(awards), createdAt: note.created_at || "", updatedAt: note.updated_at || "" }
}

async function listGitlabNoteAwards(server, issueRoot, noteId) {
  const awards = []
  for (let page = 1; page <= 100; page += 1) {
    const result = await providerFetch(server, "GET", `${issueRoot}/notes/${encodeURIComponent(noteId)}/award_emoji?per_page=100${page > 1 ? `&page=${page}` : ""}`).catch(() => [])
    const entries = Array.isArray(result) ? result : []
    awards.push(...entries)
    if (entries.length < 100) break
  }
  return awards
}

function githubIssuePermissions(repository = {}, currentUser = {}, issue = {}) {
  const permissions = repository.permissions || {}
  const canManage = Boolean(permissions.admin || permissions.maintain || permissions.push || permissions.triage)
  const isAuthor = String(currentUser.login || "").toLowerCase() === String(issue.user && issue.user.login || "").toLowerCase()
  return { canCreate: Boolean(currentUser.login), canEdit: canManage || isAuthor, canClose: canManage || isAuthor, canLabel: canManage, canComment: Boolean(currentUser.login) }
}

function gitlabIssuePermissions(project = {}, currentUser = {}, issue = {}) {
  const accessLevel = Math.max(Number(project.permissions && project.permissions.project_access && project.permissions.project_access.access_level || 0), Number(project.permissions && project.permissions.group_access && project.permissions.group_access.access_level || 0))
  const isAuthor = String(currentUser.id || "") === String(issue.author && issue.author.id || "")
  return { canCreate: accessLevel >= 10, canEdit: accessLevel >= 20 || isAuthor, canClose: accessLevel >= 20 || isAuthor, canLabel: accessLevel >= 20, canComment: accessLevel >= 10 }
}

async function fetchProviderIssuePage(server, repo, input = {}) {
  const state = input.state === "closed" ? "closed" : input.state === "all" ? "all" : "open"
  const search = String(input.search || "").trim()
  const page = Math.max(1, Number.parseInt(String(input.page || "1"), 10) || 1)
  const perPage = Math.min(100, Math.max(1, Number.parseInt(String(input.perPage || "100"), 10) || 100))
  const labels = (Array.isArray(input.labels) ? input.labels : [input.labels]).map((label) => String(label || "").trim()).filter(Boolean)
  if (server.type === "github") {
    const params = new URLSearchParams({ state, per_page: String(perPage), sort: "updated", direction: "desc" })
    if (input.page !== undefined) params.set("page", String(page))
    if (search) params.set("q", search)
    if (labels.length) params.set("labels", labels.join(","))
    const result = await providerFetch(server, "GET", `${githubRepoPath(repo)}/issues?${params}`)
    const entries = Array.isArray(result) ? result : []
    return { entries, issues: entries.filter((issue) => !issue.pull_request).map(normalizeGithubIssue) }
  }
  if (server.type === "gitlab") {
    const params = new URLSearchParams({ scope: "all", state: state === "open" ? "opened" : state, per_page: String(perPage), order_by: "updated_at", sort: "desc" })
    if (input.page !== undefined) params.set("page", String(page))
    if (search) params.set("search", search)
    if (labels.length) params.set("labels", labels.join(","))
    const result = await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/issues?${params}`)
    const entries = Array.isArray(result) ? result : []
    return { entries, issues: entries.map(normalizeGitlabIssue) }
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function listProviderIssues(server, repo, input = {}) {
  return (await fetchProviderIssuePage(server, repo, input)).issues
}

async function listProviderIssuesPage(server, repo, input = {}) {
  const page = Math.max(1, Number.parseInt(String(input.page || "1"), 10) || 1)
  const perPage = Math.min(99, Math.max(1, Number.parseInt(String(input.perPage || "50"), 10) || 50))
  const result = await fetchProviderIssuePage(server, repo, { ...input, page, perPage: perPage + 1 })
  return {
    issues: result.issues.slice(0, perPage),
    page,
    perPage,
    hasMore: result.entries.length > perPage,
  }
}

async function listAllProviderIssues(server, repo, input = {}) {
  const issues = []
  for (let page = 1; page <= 100; page += 1) {
    const entries = await listProviderIssues(server, repo, { ...input, page, perPage: 100 })
    issues.push(...entries)
    if (entries.length < 100) break
  }
  return issues
}

async function getProviderIssueSnapshot(server, repo, issueNumber) {
  if (server.type === "github") return normalizeGithubIssue(await providerFetch(server, "GET", `${githubRepoPath(repo)}/issues/${issueNumber}`))
  if (server.type === "gitlab") return normalizeGitlabIssue(await providerFetch(server, "GET", `${gitlabProjectPath(repo)}/issues/${issueNumber}`))
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function listProviderIssueLabels(server, repo) {
  const root = server.type === "github" ? githubRepoPath(repo) : gitlabProjectPath(repo)
  const labels = []
  for (let page = 1; page <= 100; page += 1) {
    const result = await providerFetch(server, "GET", `${root}/labels?per_page=100${page > 1 ? `&page=${page}` : ""}`)
    const entries = Array.isArray(result) ? result : []
    labels.push(...entries)
    if (entries.length < 100) break
  }
  return normalizeLabels(labels).sort((left, right) => left.name.localeCompare(right.name))
}

async function getProviderIssue(server, repo, issueNumber) {
  if (server.type === "github") {
    const root = githubRepoPath(repo)
    const [issue, comments, labels, repository, currentUser] = await Promise.all([
      providerFetch(server, "GET", `${root}/issues/${issueNumber}`),
      providerFetch(server, "GET", `${root}/issues/${issueNumber}/comments?per_page=100`),
      listProviderIssueLabels(server, repo),
      providerFetch(server, "GET", root).catch(() => ({})),
      providerFetch(server, "GET", "/user").catch(() => ({})),
    ])
    return {
      issue: { ...normalizeGithubIssue(issue), permissions: githubIssuePermissions(repository, currentUser, issue) },
      comments: (Array.isArray(comments) ? comments : []).map(normalizeGithubComment),
      availableLabels: labels,
    }
  }
  if (server.type === "gitlab") {
    const projectRoot = gitlabProjectPath(repo)
    const root = `${projectRoot}/issues/${issueNumber}`
    const [issue, notes, labels, project, currentUser] = await Promise.all([
      providerFetch(server, "GET", root),
      providerFetch(server, "GET", `${root}/notes?per_page=100&sort=asc`),
      listProviderIssueLabels(server, repo),
      providerFetch(server, "GET", projectRoot).catch(() => ({})),
      providerFetch(server, "GET", "/user").catch(() => ({})),
    ])
    const comments = (Array.isArray(notes) ? notes : []).filter((note) => !note.system)
    const awards = await Promise.all(comments.map((note) => listGitlabNoteAwards(server, root, note.id)))
    return {
      issue: { ...normalizeGitlabIssue(issue), permissions: gitlabIssuePermissions(project, currentUser, issue) },
      comments: comments.map((note, index) => normalizeGitlabComment(note, awards[index])),
      availableLabels: labels,
    }
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function listProviderIssueMentionUsers(server, repo, issueNumber) {
  if (server.type === "gitlab") {
    const root = gitlabProjectPath(repo)
    const [members, participants] = await Promise.all([
      providerFetch(server, "GET", `${root}/members/all?per_page=100`).catch(() => []),
      providerFetch(server, "GET", `${root}/issues/${issueNumber}/participants`).catch(() => []),
    ])
    return uniqueMentionUsers([...(Array.isArray(members) ? members : []), ...(Array.isArray(participants) ? participants : [])])
  }
  if (server.type === "github") {
    const root = githubRepoPath(repo)
    const [members, issue, comments] = await Promise.all([
      providerFetch(server, "GET", `${root}/collaborators?affiliation=all&per_page=100`).catch(() => providerFetch(server, "GET", `${root}/contributors?per_page=100`).catch(() => [])),
      providerFetch(server, "GET", `${root}/issues/${issueNumber}`).catch(() => ({})),
      providerFetch(server, "GET", `${root}/issues/${issueNumber}/comments?per_page=100`).catch(() => []),
    ])
    return uniqueMentionUsers([
      ...(Array.isArray(members) ? members : []),
      issue.user,
      ...(Array.isArray(issue.assignees) ? issue.assignees : []),
      ...(Array.isArray(comments) ? comments.map((comment) => comment.user) : []),
    ].filter(Boolean))
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function createProviderIssue(server, repo, input = {}) {
  const title = String(input.title || "").trim()
  const body = String(input.body || "")
  const labels = (Array.isArray(input.labels) ? input.labels : []).map(String).filter(Boolean)
  if (!title) throw providerApiError("issue title is required", 400)
  if (server.type === "github") {
    return normalizeGithubIssue(await providerFetch(server, "POST", `${githubRepoPath(repo)}/issues`, { title, body, labels }))
  }
  if (server.type === "gitlab") {
    return normalizeGitlabIssue(await providerFetch(server, "POST", `${gitlabProjectPath(repo)}/issues`, { title, description: body, labels: labels.join(",") }))
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function updateProviderIssue(server, repo, issueNumber, input = {}) {
  const labels = Array.isArray(input.labels) ? input.labels.map(String).filter(Boolean) : undefined
  if (server.type === "github") {
    const payload = {
      ...(input.title !== undefined ? { title: String(input.title).trim() } : {}),
      ...(input.body !== undefined ? { body: String(input.body) } : {}),
      ...(labels ? { labels } : {}),
    }
    return normalizeGithubIssue(await providerFetch(server, "PATCH", `${githubRepoPath(repo)}/issues/${issueNumber}`, payload))
  }
  if (server.type === "gitlab") {
    const payload = {
      ...(input.title !== undefined ? { title: String(input.title).trim() } : {}),
      ...(input.body !== undefined ? { description: String(input.body) } : {}),
      ...(labels ? { labels: labels.join(",") } : {}),
    }
    return normalizeGitlabIssue(await providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/issues/${issueNumber}`, payload))
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function createProviderIssueComment(server, repo, issueNumber, body) {
  if (server.type === "github") return normalizeGithubComment(await providerFetch(server, "POST", `${githubRepoPath(repo)}/issues/${issueNumber}/comments`, { body }))
  if (server.type === "gitlab") return normalizeGitlabComment(await providerFetch(server, "POST", `${gitlabProjectPath(repo)}/issues/${issueNumber}/notes`, { body }))
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

async function updateProviderIssueState(server, repo, issueNumber, action) {
  if (action !== "close" && action !== "reopen") throw providerApiError("unsupported issue state action", 400)
  if (server.type === "github") {
    return normalizeGithubIssue(await providerFetch(server, "PATCH", `${githubRepoPath(repo)}/issues/${issueNumber}`, { state: action === "close" ? "closed" : "open" }))
  }
  if (server.type === "gitlab") {
    return normalizeGitlabIssue(await providerFetch(server, "PUT", `${gitlabProjectPath(repo)}/issues/${issueNumber}`, { state_event: action }))
  }
  throw providerApiError(`unsupported git provider: ${server.type}`, 400)
}

export { createProviderIssue, createProviderIssueComment, getProviderIssue, getProviderIssueSnapshot, listAllProviderIssues, listProviderIssueLabels, listProviderIssueMentionUsers, listProviderIssues, listProviderIssuesPage, updateProviderIssue, updateProviderIssueState }
