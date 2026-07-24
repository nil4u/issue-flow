const assert = require("node:assert/strict")
const test = require("node:test")

process.env.DATABASE_URL ||= "postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test"
require("tsx/cjs")

const {
  createProviderIssue,
  createProviderIssueComment,
  getProviderIssue,
  listProviderIssueLabels,
  listProviderIssueMentionUsers,
  listProviderIssues,
  updateProviderIssue,
  updateProviderIssueState,
} = require("../src/core/issue-provider.ts")
const {
  automationOptimizationIssueBody,
  automationOptimizationPhases,
  createAutomationOptimizationIssue,
  listAutomationOptimizations,
} = require("../src/core/issues.ts")

test("issue label picker receives every provider label page", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url) => {
    const requestUrl = String(url)
    requests.push(requestUrl)
    if (requestUrl.endsWith("/projects/43326/labels?per_page=100")) {
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ name: `label-${String(index).padStart(3, "0")}` }))), { status: 200 })
    }
    if (requestUrl.endsWith("/projects/43326/labels?per_page=100&page=2")) {
      return new Response(JSON.stringify([{ name: "target-label", description: "Only available on page two" }]), { status: 200 })
    }
    throw new Error(`Unexpected request: ${requestUrl}`)
  }

  const labels = await listProviderIssueLabels(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" },
    { serverRepoId: "43326" },
  )

  assert.equal(labels.length, 101)
  assert.equal(labels.some((label) => label.name === "target-label"), true)
  assert.deepEqual(requests, [
    "https://gitlab.test/api/v4/projects/43326/labels?per_page=100",
    "https://gitlab.test/api/v4/projects/43326/labels?per_page=100&page=2",
  ])
})

test("automation optimization phases only include repeated supported stages", () => {
  const phases = automationOptimizationPhases(
    { type: "feature" },
    { triageTaskTurns: 1, planTaskTurns: 3, buildTaskTurns: 2, reviewTaskTurns: 0, generalTaskTurns: 9 },
  )

  assert.deepEqual(phases, [
    { phase: "plan", turns: 3 },
    { phase: "build", turns: 2 },
  ])
  assert.deepEqual(automationOptimizationPhases({ type: "optimization" }, { planTaskTurns: 3 }), [])
})

test("automation optimization issue template includes the source stage contract", () => {
  const body = automationOptimizationIssueBody({
    sourceIssue: { issueNumber: 17, title: "Add checkout" },
    phases: [{ phase: "plan", turns: 3 }, { phase: "build", turns: 2 }],
  })

  assert.match(body, /source-issue=17/)
  assert.match(body, /来源 Issue：#17 Add checkout/)
  assert.match(body, /`plan`：3 Turns/)
  assert.match(body, /`build`：2 Turns/)
})

test("automation optimization creation is blocked while the source has an optimization state", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  let createdIssue
  let nextIssueNumber = 81
  const sourceIssue = {
    id: 17,
    iid: 17,
    title: "Add checkout",
    description: "",
    state: "closed",
    labels: ["type::feature", "status::done"],
    author: { username: "alice" },
  }
  global.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined }
    requests.push(request)
    if (request.method === "GET" && request.url.includes("/issues?")) {
      return new Response(JSON.stringify(createdIssue ? [sourceIssue, createdIssue] : [sourceIssue]), { status: 200 })
    }
    if (request.method === "POST" && request.url.endsWith("/issues")) {
      createdIssue = {
        id: nextIssueNumber,
        iid: nextIssueNumber,
        title: request.body.title,
        description: request.body.description,
        state: "opened",
        labels: request.body.labels.split(","),
        author: { username: "alice" },
      }
      nextIssueNumber += 1
      return new Response(JSON.stringify(createdIssue), { status: 201 })
    }
    if (request.method === "PUT" && request.url.endsWith("/issues/17")) {
      sourceIssue.labels = request.body.labels.split(",")
      return new Response(JSON.stringify(sourceIssue), { status: 200 })
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  }
  const store = {
    findRepositoryByProject: async () => ({ id: "repo-1", gitServerId: "gitlab-1", serverRepoId: "43326", fullName: "acme/widget" }),
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ id: "gitlab-1", type: "gitlab", apiUrl: "https://gitlab.test/api/v4" }),
    db: {
      issue: {
        findUnique: async () => ({ id: "issue-row-17", issueNumber: 17, title: "Add checkout", type: "feature" }),
        findMany: async () => [{ id: "issue-row-17", issueNumber: 17, title: "Add checkout", type: "feature" }],
      },
      issueStat: {
        findMany: async () => [{ id: "issue-row-17", planTaskTurns: 3, buildTaskTurns: 2 }],
      },
    },
    getIssueStats: async () => ({ planTaskTurns: 3, buildTaskTurns: 2 }),
  }
  const input = {
    store,
    gitServerId: "gitlab-1",
    projectId: "43326",
    issueNumber: 17,
    userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-1", token: "user-token" },
    input: {},
  }

  const created = await createAutomationOptimizationIssue(input)
  await assert.rejects(createAutomationOptimizationIssue(input), (error) => error.code === "automation_optimization_already_started")

  assert.equal(created.created, true)
  assert.equal(requests.filter((request) => request.method === "POST").length, 1)
  assert.deepEqual(sourceIssue.labels, ["type::feature", "status::done", "optimization::analyzing"])
  assert.match(created.issue.body, /`plan`：3 Turns/)
  assert.match(created.issue.body, /`build`：2 Turns/)
  assert.deepEqual(created.issue.labels.map((label) => label.name), [
    "type::optimization",
    "status::active",
    "flow::plan",
    "automation::build",
    "priority::p2",
    "size::M",
  ])

  let status = await listAutomationOptimizations({ ...input, input: { issueNumbers: [17] } })
  assert.deepEqual(status.items[0], {
    sourceIssueNumber: 17,
    phases: [{ phase: "plan", turns: 3 }, { phase: "build", turns: 2 }],
    status: "analyzing",
    optimizationIssueNumber: 81,
    optimizationIssueUrl: "",
  })

  sourceIssue.labels = sourceIssue.labels.map((label) => label === "optimization::analyzing" ? "optimization::analyzed" : label)
  status = await listAutomationOptimizations({ ...input, input: { issueNumbers: [17] } })
  assert.equal(status.items[0].status, "analyzed")
})

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
