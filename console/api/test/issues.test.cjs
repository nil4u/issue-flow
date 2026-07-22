const assert = require("node:assert/strict")
const test = require("node:test")

process.env.DATABASE_URL ||= "postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test"
require("tsx/cjs")

const {
  createProviderIssue,
  createProviderIssueComment,
  getProviderIssue,
  listProviderIssueMentionUsers,
  listProviderIssues,
  updateProviderIssue,
  updateProviderIssueState,
} = require("../src/core/issue-provider.ts")

test("GitLab issue mentions combine repository members and issue participants", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/projects/43326/members/all?per_page=100")) return new Response(JSON.stringify([{ id: 1, username: "alice", name: "Alice" }, { id: 2, username: "issue-flow-bot", name: "Issue Flow" }]), { status: 200 })
    if (path.endsWith("/projects/43326/issues/15/participants")) return new Response(JSON.stringify([{ id: 1, username: "alice", name: "Alice Updated" }, { id: 3, username: "bob", name: "Bob" }]), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const users = await listProviderIssueMentionUsers(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" },
    { serverRepoId: "43326" },
    15,
  )

  assert.deepEqual(users.map((user) => user.username), ["issue-flow-bot", "alice", "bob"])
  assert.equal(users.find((user) => user.username === "alice").name, "Alice Updated")
})

test("GitHub issue mentions include collaborators and discussion users", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.includes("/collaborators?")) return new Response(JSON.stringify([{ id: 1, login: "alice" }]), { status: 200 })
    if (path.endsWith("/issues/7")) return new Response(JSON.stringify({ user: { id: 2, login: "author" }, assignees: [{ id: 3, login: "owner" }] }), { status: 200 })
    if (path.includes("/issues/7/comments?")) return new Response(JSON.stringify([{ user: { id: 4, login: "review-bot", type: "Bot" } }]), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const users = await listProviderIssueMentionUsers(
    { type: "github", apiUrl: "https://api.github.test", userToken: "user-token" },
    { fullName: "acme/widget" },
    7,
  )

  assert.deepEqual(users.map((user) => user.username), ["review-bot", "alice", "author", "owner"])
})

test("GitHub issue list excludes pull requests and uses the current user credential", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let request
  global.fetch = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify([
      { id: 1, number: 7, title: "Issue", state: "open", user: { login: "alice" }, labels: [{ name: "bug", color: "d73a4a" }] },
      { id: 2, number: 8, title: "PR", state: "open", pull_request: {}, user: { login: "bob" } },
    ]), { status: 200 })
  }

  const issues = await listProviderIssues(
    { type: "github", apiUrl: "https://api.github.test", userToken: "user-token" },
    { fullName: "acme/widget" },
    { state: "open" },
  )

  assert.match(request.url, /\/repos\/acme\/widget\/issues\?state=open/)
  assert.equal(request.options.headers.Authorization, "Bearer user-token")
  assert.deepEqual(issues.map((issue) => issue.number), [7])
  assert.deepEqual(issues[0].labels[0], { name: "bug", color: "d73a4a", description: "" })
})

test("GitLab issue detail includes comments, labels, and current user permissions", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/projects/43326/issues/15")) return new Response(JSON.stringify({ id: 15, iid: 15, title: "Plan", state: "opened", description: "Body", author: { id: 8, username: "author" }, labels: ["feature"] }), { status: 200 })
    if (path.includes("/issues/15/notes?")) return new Response(JSON.stringify([{ id: 1, body: "Comment", author: { id: 9, username: "alice" } }, { id: 2, body: "changed title", system: true }]), { status: 200 })
    if (path.endsWith("/projects/43326/labels?per_page=100")) return new Response(JSON.stringify([{ name: "feature", color: "#428BCA", description: "Feature" }]), { status: 200 })
    if (path.endsWith("/projects/43326")) return new Response(JSON.stringify({ permissions: { project_access: { access_level: 30 } } }), { status: 200 })
    if (path.endsWith("/user")) return new Response(JSON.stringify({ id: 9, username: "alice" }), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const detail = await getProviderIssue(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" },
    { serverRepoId: "43326" },
    15,
  )

  assert.equal(detail.issue.number, 15)
  assert.deepEqual(detail.issue.permissions, { canCreate: true, canEdit: true, canClose: true, canLabel: true, canComment: true })
  assert.deepEqual(detail.comments.map((comment) => comment.body), ["Comment"])
  assert.deepEqual(detail.availableLabels[0], { name: "feature", color: "428BCA", description: "Feature" })
})

test("GitHub issue create, edit, comment, close, and reopen use provider APIs", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined })
    const body = requests.at(-1).body || {}
    if (String(url).endsWith("/comments")) return new Response(JSON.stringify({ id: 9, body: body.body, user: { login: "alice" } }), { status: 201 })
    return new Response(JSON.stringify({ id: 7, number: 7, title: body.title || "Issue", body: body.body || "Body", state: body.state || "open", user: { login: "alice" }, labels: (body.labels || []).map((name) => ({ name })) }), { status: 200 })
  }
  const server = { type: "github", apiUrl: "https://api.github.test", userToken: "user-token" }
  const repo = { fullName: "acme/widget" }

  await createProviderIssue(server, repo, { title: "Issue", body: "Body", labels: ["feature"] })
  await updateProviderIssue(server, repo, 7, { title: "Updated", body: "Next", labels: ["bug"] })
  await createProviderIssueComment(server, repo, 7, "Comment")
  await updateProviderIssueState(server, repo, 7, "close")
  await updateProviderIssueState(server, repo, 7, "reopen")

  assert.deepEqual(requests.map((request) => [request.options.method, request.url.replace("https://api.github.test", "")]), [
    ["POST", "/repos/acme/widget/issues"],
    ["PATCH", "/repos/acme/widget/issues/7"],
    ["POST", "/repos/acme/widget/issues/7/comments"],
    ["PATCH", "/repos/acme/widget/issues/7"],
    ["PATCH", "/repos/acme/widget/issues/7"],
  ])
  assert.deepEqual(requests[3].body, { state: "closed" })
  assert.deepEqual(requests[4].body, { state: "open" })
})

test("GitLab issue create, edit, comment, close, and reopen use provider APIs", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined })
    const body = requests.at(-1).body || {}
    if (String(url).endsWith("/notes")) return new Response(JSON.stringify({ id: 9, body: body.body, author: { username: "alice" } }), { status: 201 })
    return new Response(JSON.stringify({ id: 7, iid: 7, title: body.title || "Issue", description: body.description || "Body", state: body.state_event === "close" ? "closed" : "opened", author: { username: "alice" }, labels: String(body.labels || "").split(",").filter(Boolean) }), { status: 200 })
  }
  const server = { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" }
  const repo = { serverRepoId: "43326" }

  await createProviderIssue(server, repo, { title: "Issue", body: "Body", labels: ["feature"] })
  await updateProviderIssue(server, repo, 7, { title: "Updated", body: "Next", labels: ["bug"] })
  await createProviderIssueComment(server, repo, 7, "Comment")
  await updateProviderIssueState(server, repo, 7, "close")
  await updateProviderIssueState(server, repo, 7, "reopen")

  assert.deepEqual(requests.map((request) => [request.options.method, request.url.replace("https://gitlab.test/api/v4", "")]), [
    ["POST", "/projects/43326/issues"],
    ["PUT", "/projects/43326/issues/7"],
    ["POST", "/projects/43326/issues/7/notes"],
    ["PUT", "/projects/43326/issues/7"],
    ["PUT", "/projects/43326/issues/7"],
  ])
  assert.deepEqual(requests[3].body, { state_event: "close" })
  assert.deepEqual(requests[4].body, { state_event: "reopen" })
})
