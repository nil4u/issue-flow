const assert = require("node:assert/strict")
const test = require("node:test")

process.env.DATABASE_URL ||= "postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test"
require("tsx/cjs")

const { getProviderMergeRequest, getProviderMergeRequestFileDiff, listProviderMentionUsers, listProviderMergeRequests, mergeProviderMergeRequest, normalizeGithubMergeRequest, normalizeGitlabMergeRequest, submitProviderMergeRequestComment, submitProviderMergeRequestReply, submitProviderMergeRequestReview, updateProviderMergeRequestState } = require("../src/core/merge-request-provider.ts")
const { getMergeRequest } = require("../src/core/merge-requests.ts")

test("only Plan MR with a source issue can open the Plan preview", () => {
  const planBody = "<!-- issue-flow:source-issue=42 -->\nSource issue: #42"
  assert.deepEqual(
    { sourceIssueNumber: normalizeGitlabMergeRequest({ description: planBody, labels: ["mr-by::plan"] }).sourceIssueNumber, previewable: normalizeGitlabMergeRequest({ description: planBody, labels: ["mr-by::plan"] }).previewable },
    { sourceIssueNumber: 42, previewable: true },
  )
  assert.equal(normalizeGitlabMergeRequest({ description: planBody, labels: ["mr-by::build"] }).previewable, false)
  assert.equal(normalizeGitlabMergeRequest({ description: "No source issue", labels: ["mr-by::plan"] }).previewable, false)
  assert.equal(normalizeGithubMergeRequest({ body: planBody, labels: [{ name: "mr-by::plan" }] }).previewable, true)
})

test("GitLab merge request list uses the current user credential", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let request
  global.fetch = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify([{
      id: 101, iid: 17, title: "Plan", state: "opened",
      description: "<!-- issue-flow:source-issue=42 -->",
      labels: ["mr-by::plan"], source_branch: "42-plan/plan", target_branch: "main",
    }]), { status: 200 })
  }

  const result = await listProviderMergeRequests(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", tokenAuth: "private-token", userToken: "user-token" },
    { serverRepoId: "43326", fullName: "acme/widget" },
    "open",
  )

  assert.match(request.url, /\/projects\/43326\/merge_requests\?scope=all&state=opened/)
  assert.equal(request.options.headers["PRIVATE-TOKEN"], "user-token")
  assert.equal(result[0].sourceIssueNumber, 42)
  assert.equal(result[0].previewable, true)
})

test("GitLab mention candidates combine repository members, participants, and bots", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.includes("/members/all?")) return new Response(JSON.stringify([{ id: 1, username: "alice", name: "Alice" }, { id: 2, username: "issue-flow-bot", name: "Issue Flow", user_type: "project_bot" }]), { status: 200 })
    if (path.endsWith("/merge_requests/17/participants")) return new Response(JSON.stringify([{ id: 1, username: "alice", name: "Alice Updated" }, { id: 3, username: "bob", name: "Bob" }]), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const users = await listProviderMentionUsers({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" }, { serverRepoId: "43326" }, 17)
  assert.deepEqual(users.map((user) => user.username), ["issue-flow-bot", "alice", "bob"])
  assert.equal(users[0].bot, true)
  assert.equal(users.find((user) => user.username === "alice").name, "Alice Updated")
})

test("GitHub mention candidates include collaborators and commenting bots", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.includes("/collaborators?")) return new Response(JSON.stringify([{ id: 1, login: "alice", type: "User" }]), { status: 200 })
    if (path.endsWith("/pulls/7")) return new Response(JSON.stringify({ user: { id: 2, login: "author" }, requested_reviewers: [] }), { status: 200 })
    if (path.includes("/issues/7/comments?")) return new Response(JSON.stringify([{ user: { id: 3, login: "review-bot", type: "Bot" } }]), { status: 200 })
    if (path.includes("/pulls/7/comments?")) return new Response(JSON.stringify([]), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const users = await listProviderMentionUsers({ type: "github", apiUrl: "https://api.github.test", userToken: "token" }, { fullName: "acme/widget" }, 7)
  assert.deepEqual(users.map((user) => user.username), ["review-bot", "alice", "author"])
  assert.equal(users[0].bot, true)
})

test("GitHub detail loads diff and discussions for the independent review page", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/pulls/7")) return new Response(JSON.stringify({ id: 70, number: 7, title: "Build", state: "open", user: { login: "bob" }, head: { ref: "build", sha: "abc" }, base: { ref: "main" } }), { status: 200 })
    if (path.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
    if (path.endsWith("/user")) return new Response(JSON.stringify({ login: "alice" }), { status: 200 })
    if (path.includes("/files?")) return new Response(JSON.stringify([{ filename: "src/api.ts", patch: "@@ -1 +1 @@\n-old\n+new" }]), { status: 200 })
    if (path.includes("/issues/7/comments")) return new Response(JSON.stringify([{ id: 1, body: "General", user: { login: "bob" } }]), { status: 200 })
    if (path.includes("/reviews?")) return new Response(JSON.stringify([]), { status: 200 })
    if (path.includes("/comments?")) return new Response(JSON.stringify([{ id: 2, body: "Inline", path: "src/api.ts", line: 1, side: "RIGHT", user: { login: "alice" } }]), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }
  const detail = await getProviderMergeRequest({ type: "github", apiUrl: "https://api.github.test", userToken: "token" }, { fullName: "acme/widget" }, 7)
  assert.equal(detail.files[0].path, "src/api.ts")
  assert.deepEqual(detail.comments.map((comment) => comment.type), ["comment", "inline"])
  assert.deepEqual(detail.mergeRequest.permissions, { canMerge: true, canClose: true, canApprove: true, hasApproved: false })
})

test("GitLab detail uses the compatible merge request changes API", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url) => {
    const path = String(url); requests.push(path)
    if (path.endsWith("/merge_requests/54")) return new Response(JSON.stringify({ id: 54, iid: 54, title: "Plan", state: "opened", source_branch: "plan", target_branch: "main", author: { id: 8 }, user: { can_merge: true } }), { status: 200 })
    if (path.endsWith("/projects/43326")) return new Response(JSON.stringify({ permissions: { project_access: { access_level: 30 } } }), { status: 200 })
    if (path.endsWith("/user")) return new Response(JSON.stringify({ id: 9 }), { status: 200 })
    if (path.endsWith("/merge_requests/54/changes")) return new Response(JSON.stringify({ diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" }, changes: [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }, { old_path: "demo.html", new_path: "demo.html", new_file: true, diff: "" }] }), { status: 200 })
    if (path.includes("/discussions?")) return new Response(JSON.stringify([]), { status: 200 })
    if (path.endsWith("/approvals")) return new Response(JSON.stringify({ approved_by: [] }), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }
  const detail = await getProviderMergeRequest({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" }, { serverRepoId: "43326" }, 54)
  assert.equal(detail.files[0].path, "a.ts")
  assert.equal(detail.files[0].additions, 1)
  assert.equal(detail.files[0].deletions, 1)
  assert.equal(detail.files[1].collapsed, true)
  assert.equal(detail.files[1].truncated, false)
  assert.deepEqual(detail.mergeRequest.diffRefs, { baseSha: "base", startSha: "start", headSha: "head" })
  assert.deepEqual(detail.mergeRequest.permissions, { canMerge: true, canClose: true, canApprove: true, hasApproved: false })
  assert.equal(requests.some((request) => request.includes("/diffs")), false)
})

test("GitLab collapsed diff loads raw content on demand", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let request
  global.fetch = async (url) => {
    request = String(url)
    return new Response(JSON.stringify({ changes: [{ old_path: "demo.html", new_path: "demo.html", new_file: true, diff: "@@ -0,0 +1 @@\n+<main>Demo</main>" }] }), { status: 200 })
  }

  const file = await getProviderMergeRequestFileDiff(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" },
    { serverRepoId: "43326" },
    54,
    "demo.html",
  )

  assert.match(request, /\/merge_requests\/54\/changes\?access_raw_diffs=true$/)
  assert.equal(file.path, "demo.html")
  assert.equal(file.patch, "@@ -0,0 +1 @@\n+<main>Demo</main>")
  assert.equal(file.collapsed, false)
  assert.equal(file.truncated, false)
})

test("GitLab detail hydrates missing conversation avatars from user profiles", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/merge_requests/54")) return new Response(JSON.stringify({ id: 54, iid: 54, title: "Plan", state: "opened", source_branch: "plan", target_branch: "main", author: { id: 8, username: "agentrix" } }), { status: 200 })
    if (path.endsWith("/merge_requests/54/changes")) return new Response(JSON.stringify({ changes: [] }), { status: 200 })
    if (path.includes("/discussions?")) return new Response(JSON.stringify([{ id: "discussion-1", notes: [{ id: 7, body: "Looks good", author: { id: 9, username: "alice" }, position: { new_path: "src/api.ts", old_path: "src/api.ts", new_line: 12 } }, { id: 8, body: "Thanks", author: { id: 9, username: "alice" } }] }]), { status: 200 })
    if (path.endsWith("/approvals")) return new Response(JSON.stringify({ approved_by: [] }), { status: 200 })
    if (path.endsWith("/users/8")) return new Response(JSON.stringify({ id: 8, username: "agentrix", avatar_url: "https://gitlab.test/avatar-agentrix.png" }), { status: 200 })
    if (path.endsWith("/users/9")) return new Response(JSON.stringify({ id: 9, username: "alice", avatar_url: "https://gitlab.test/avatar-alice.png" }), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const detail = await getProviderMergeRequest({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" }, { serverRepoId: "43326" }, 54)
  assert.equal(detail.mergeRequest.author.avatarUrl, "https://gitlab.test/avatar-agentrix.png")
  assert.equal(detail.comments[0].author.avatarUrl, "https://gitlab.test/avatar-alice.png")
  assert.equal(detail.comments[0].discussionId, "discussion-1")
  assert.equal(detail.comments[0].discussionRoot, true)
  assert.equal(detail.comments[1].discussionRoot, false)
  assert.equal(detail.comments[1].path, "src/api.ts")
  assert.equal(detail.comments[1].line, 12)
})

test("merge request detail renders summary and comments as provider Markdown", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url, options = {}) => {
    const path = String(url)
    if (path.endsWith("/merge_requests/54")) return new Response(JSON.stringify({ id: 54, iid: 54, title: "Plan", state: "opened", description: "## Summary\n\n**Done**", source_branch: "plan", target_branch: "main" }), { status: 200 })
    if (path.endsWith("/merge_requests/54/changes")) return new Response(JSON.stringify({ changes: [] }), { status: 200 })
    if (path.includes("/discussions?")) return new Response(JSON.stringify([{ notes: [{ id: 8, body: "[Open task](https://example.test/task)", author: { username: "agentrix" } }] }]), { status: 200 })
    if (path.endsWith("/approvals")) return new Response(JSON.stringify({ approved_by: [] }), { status: 200 })
    if (path.endsWith("/markdown") && options.method === "POST") {
      const body = JSON.parse(options.body)
      return new Response(JSON.stringify({ html: `<p>${body.text}</p>` }), { status: 200 })
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`)
  }
  const repo = { id: "repo_1", gitServerId: "gitlab-main", serverRepoId: "43326", fullName: "acme/widget" }
  const detail = await getMergeRequest({
    store: { findRepositoryByProject: async () => repo, userCanAccessRepo: async () => true, getGitServer: async () => ({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4" }) },
    gitServerId: "gitlab-main", projectId: "43326", mergeRequestNumber: 54, userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-main", token: "user-token" },
  })
  assert.match(detail.mergeRequest.bodyHtml, /## Summary/)
  assert.match(detail.comments[0].bodyHtml, /Open task/)
})

test("GitLab diff review submits inline comments, summary, and approval", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => { requests.push({ url: String(url), options }); return new Response(JSON.stringify({ id: requests.length }), { status: 201 }) }
  await submitProviderMergeRequestReview(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" },
    { serverRepoId: "43326" },
    { number: 17, diffRefs: { baseSha: "base", startSha: "start", headSha: "head" } },
    { action: "approve", body: "Approved", comments: [{ body: "Rename", path: "src/api.ts", oldPath: "src/api.ts", line: 12, side: "RIGHT" }] },
  )
  assert.match(requests[0].url, /\/discussions$/)
  assert.match(requests[1].url, /\/notes$/)
  assert.match(requests[2].url, /\/approve$/)
})

test("conversation comments use the provider comment API", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ id: requests.length }), { status: 201 })
  }

  await submitProviderMergeRequestComment({ type: "github", apiUrl: "https://api.github.test", userToken: "github-user" }, { fullName: "acme/widget" }, 7, "GitHub comment")
  await submitProviderMergeRequestComment({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", tokenAuth: "private-token", userToken: "gitlab-user" }, { serverRepoId: "43326" }, 17, "GitLab comment")

  assert.match(requests[0].url, /\/issues\/7\/comments$/)
  assert.deepEqual(JSON.parse(requests[0].options.body), { body: "GitHub comment" })
  assert.equal(requests[0].options.headers.Authorization, "Bearer github-user")
  assert.match(requests[1].url, /\/merge_requests\/17\/notes$/)
  assert.deepEqual(JSON.parse(requests[1].options.body), { body: "GitLab comment" })
  assert.equal(requests[1].options.headers["PRIVATE-TOKEN"], "gitlab-user")
})

test("conversation replies stay in the provider discussion", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ id: requests.length }), { status: 201 })
  }

  await submitProviderMergeRequestReply({ type: "github", apiUrl: "https://api.github.test", userToken: "github-user" }, { fullName: "acme/widget" }, 7, { commentId: "91", type: "inline" }, "GitHub reply")
  await submitProviderMergeRequestReply({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", tokenAuth: "private-token", userToken: "gitlab-user" }, { serverRepoId: "43326" }, 17, { commentId: "92", discussionId: "discussion-1", type: "inline" }, "GitLab reply")

  assert.match(requests[0].url, /\/pulls\/7\/comments\/91\/replies$/)
  assert.deepEqual(JSON.parse(requests[0].options.body), { body: "GitHub reply" })
  assert.match(requests[1].url, /\/merge_requests\/17\/discussions\/discussion-1\/notes$/)
  assert.deepEqual(JSON.parse(requests[1].options.body), { body: "GitLab reply" })
})

test("GitHub merge supports squash and editable commit messages", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let request
  global.fetch = async (url, options = {}) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify({ merged: true }), { status: 200 })
  }

  await mergeProviderMergeRequest({ type: "github", apiUrl: "https://api.github.test", userToken: "token" }, { fullName: "acme/widget" }, 7, { method: "squash", commitMessage: "Squashed title\n\nDetailed body" })
  assert.equal(request.options.method, "PUT")
  assert.deepEqual(JSON.parse(request.options.body), { merge_method: "squash", commit_title: "Squashed title", commit_message: "Detailed body" })
})

test("GitLab merge supports merge commits, squash, and editable messages", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ state: "merged" }), { status: 200 })
  }

  const server = { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" }
  const repo = { serverRepoId: "43326" }
  await mergeProviderMergeRequest(server, repo, 17, { method: "merge", commitMessage: "Merge message" })
  await mergeProviderMergeRequest(server, repo, 18, { method: "squash", commitMessage: "Squash message" })

  assert.deepEqual(JSON.parse(requests[0].options.body), { should_remove_source_branch: true, squash: false, merge_commit_message: "Merge message" })
  assert.deepEqual(JSON.parse(requests[1].options.body), { should_remove_source_branch: true, squash: true, squash_commit_message: "Squash message" })
})

test("GitHub merge request can be closed and reopened with the current user credential", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ number: 7, state: JSON.parse(options.body).state }), { status: 200 })
  }

  const server = { type: "github", apiUrl: "https://api.github.test", userToken: "user-token" }
  const repo = { fullName: "acme/widget" }
  await updateProviderMergeRequestState(server, repo, 7, "close")
  await updateProviderMergeRequestState(server, repo, 7, "reopen")

  assert.equal(requests[0].options.method, "PATCH")
  assert.deepEqual(JSON.parse(requests[0].options.body), { state: "closed" })
  assert.deepEqual(JSON.parse(requests[1].options.body), { state: "open" })
  assert.equal(requests[0].options.headers.Authorization, "Bearer user-token")
})

test("GitLab merge request can be closed and reopened with state events", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ iid: 17 }), { status: 200 })
  }

  const server = { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", tokenAuth: "private-token", userToken: "user-token" }
  const repo = { serverRepoId: "43326" }
  await updateProviderMergeRequestState(server, repo, 17, "close")
  await updateProviderMergeRequestState(server, repo, 17, "reopen")

  assert.equal(requests[0].options.method, "PUT")
  assert.deepEqual(JSON.parse(requests[0].options.body), { state_event: "close" })
  assert.deepEqual(JSON.parse(requests[1].options.body), { state_event: "reopen" })
  assert.equal(requests[0].options.headers["PRIVATE-TOKEN"], "user-token")
})
