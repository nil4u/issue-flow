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
  listProviderIssuesPage,
  updateProviderIssue,
  updateProviderIssueState,
} = require("../src/core/issue-provider.ts")
const {
  automationOptimizationIssueBody,
  automationOptimizationPhases,
  createAutomationOptimizationIssue,
  getIssue,
  getIssueComments,
  listAutomationOptimizations,
  updateIssueWorkflow,
} = require("../src/core/issues.ts")
const {
  applyWorkflowChanges,
  normalizeWorkflowChanges,
} = require("../src/core/managed-issue-labels.ts")
const {
  applyOptimizationIssueLifecycle,
  optimizationIssueLifecycleFromGitlabPayload,
} = require("../src/core/optimization-lifecycle.ts")

test("workflow changes replace only the requested managed prefix", () => {
  const labels = applyWorkflowChanges([
    "type::bug",
    "status::active",
    "flow::triage",
    "priority::p1",
    "backend",
  ], { status: "status::suspend" })

  assert.deepEqual(labels, ["type::bug", "flow::triage", "priority::p1", "backend", "status::suspend"])
})

test("workflow changes repair duplicate values in a changed group", () => {
  const labels = applyWorkflowChanges([
    "status::active",
    "status::suspend",
    "type::feature",
  ], { status: "status::done" })

  assert.deepEqual(labels, ["type::feature", "status::done"])
})

test("workflow changes can clear the automation optimization state", () => {
  const changes = normalizeWorkflowChanges({ changes: { optimization: null } })
  assert.deepEqual(
    applyWorkflowChanges(["type::feature", "optimization::analyzing", "backend"], changes),
    ["type::feature", "backend"],
  )
})

test("plan and build workflow changes require exactly one size", () => {
  assert.throws(
    () => applyWorkflowChanges(["status::active"], { flow: "flow::build" }),
    (error) => error.code === "workflow_size_required",
  )
  assert.deepEqual(
    applyWorkflowChanges(["status::active"], { flow: "flow::build", size: "size::M" }),
    ["status::active", "flow::build", "size::M"],
  )
})

test("workflow changes reject unknown groups and invalid values", () => {
  assert.throws(() => normalizeWorkflowChanges({ changes: { review: "review::off" } }), /unsupported workflow group/)
  assert.throws(() => normalizeWorkflowChanges({ changes: { status: "status::paused" } }), /invalid status label/)
})

test("workflow status changes only labels and preserve the provider issue state", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const updates = []
  const issue = { id: 17, iid: 17, title: "Ship it", description: "", state: "opened", labels: ["status::active", "flow::build", "size::M", "backend"], author: { id: 1, username: "alice" } }
  global.fetch = async (url, options = {}) => {
    const path = String(url)
    const method = options.method || "GET"
    if (method === "GET" && path.endsWith("/projects/43326/issues/17")) return new Response(JSON.stringify(issue), { status: 200 })
    if (method === "GET" && path.includes("/issues/17/notes?")) return new Response("[]", { status: 200 })
    if (method === "GET" && path.includes("/labels?")) return new Response("[]", { status: 200 })
    if (method === "GET" && path.endsWith("/projects/43326")) return new Response(JSON.stringify({ permissions: { project_access: { access_level: 40 } } }), { status: 200 })
    if (method === "GET" && path.endsWith("/user")) return new Response(JSON.stringify({ id: 1, username: "alice" }), { status: 200 })
    if (method === "PUT" && path.endsWith("/projects/43326/issues/17")) {
      const body = JSON.parse(options.body)
      updates.push(body)
      if (body.labels) issue.labels = body.labels.split(",")
      return new Response(JSON.stringify(issue), { status: 200 })
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }
  const store = {
    findRepositoryByProject: async () => ({ id: "repo-1", gitServerId: "gitlab-1", serverRepoId: "43326", fullName: "acme/widget" }),
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ id: "gitlab-1", type: "gitlab", apiUrl: "https://gitlab.test/api/v4" }),
  }

  const doneResult = await updateIssueWorkflow({
    store, gitServerId: "gitlab-1", projectId: "43326", issueNumber: 17, userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-1", token: "user-token" },
    input: { changes: { status: "status::done" } },
  })
  issue.state = "closed"
  const activeResult = await updateIssueWorkflow({
    store, gitServerId: "gitlab-1", projectId: "43326", issueNumber: 17, userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-1", token: "user-token" },
    input: { changes: { status: "status::active" } },
  })

  assert.deepEqual(updates, [
    { labels: "flow::build,size::M,backend,status::done" },
    { labels: "flow::build,size::M,backend,status::active" },
  ])
  assert.equal(doneResult.issue.state, "open")
  assert.equal(activeResult.issue.state, "closed")
})

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

test("optimization lifecycle derives source state from the optimization issue", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const sourceIssue = { id: 17, iid: 17, title: "Source", description: "", state: "closed", labels: ["type::feature"] }
  global.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/projects/43326/issues/17") && (!options.method || options.method === "GET")) {
      return new Response(JSON.stringify(sourceIssue), { status: 200 })
    }
    if (String(url).endsWith("/projects/43326/issues/17") && options.method === "PUT") {
      sourceIssue.labels = JSON.parse(options.body).labels.split(",")
      return new Response(JSON.stringify(sourceIssue), { status: 200 })
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`)
  }
  const context = {
    server: { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "token" },
    repo: { serverRepoId: "43326" },
  }
  const body = "<!-- issue-flow:automation-optimization source-issue=17 -->"

  await applyOptimizationIssueLifecycle({ ...context, issue: { number: 81, body, state: "open", labels: ["type::optimization", "status::active"] } })
  assert.deepEqual(sourceIssue.labels, ["type::feature", "optimization::analyzing"])

  await applyOptimizationIssueLifecycle({ ...context, issue: { number: 81, body, state: "closed", labels: ["type::optimization", "status::active"] } })
  assert.deepEqual(sourceIssue.labels, ["type::feature"])

  await applyOptimizationIssueLifecycle({ ...context, issue: { number: 81, body, state: "closed", labels: ["type::optimization", "status::done"] } })
  assert.deepEqual(sourceIssue.labels, ["type::feature", "optimization::analyzed"])

  const lifecycle = optimizationIssueLifecycleFromGitlabPayload({
    object_kind: "issue",
    object_attributes: { iid: 81, action: "reopen", state: "opened", description: body },
    labels: [{ title: "type::optimization" }, { title: "status::active" }],
  })
  assert.deepEqual(lifecycle, { issueNumber: 81, sourceIssueNumber: 17, state: "open", completed: false })
})

test("automation insights use only synchronized issue projections", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => { throw new Error(`Unexpected Provider request: ${url}`) }
  const sourceIssues = [
    { id: "issue-17", issueId: "17", issueNumber: 17, title: "Source", author: "Alice", state: "closed", type: "feature", optimizationState: "analyzing", optimizationSourceIssueNumber: 0 },
    { id: "issue-82", issueId: "82", issueNumber: 82, title: "Generated", author: "Alice", state: "opened", type: "docs", optimizationState: "", optimizationSourceIssueNumber: 17 },
    { id: "issue-83", issueId: "83", issueNumber: 83, title: "Legacy", author: "", state: "opened", type: "feature", optimizationState: "", optimizationSourceIssueNumber: 0 },
  ]
  const optimizationIssues = [
    { id: "issue-81", issueId: "81", issueNumber: 81, title: "Optimize", author: "Alice", state: "opened", type: "optimization", optimizationState: "", optimizationSourceIssueNumber: 17 },
  ]
  const store = {
    findRepositoryByProject: async () => ({ id: "repo-1", gitServerId: "gitlab-1", serverRepoId: "43326", fullName: "acme/widget" }),
    userCanAccessRepo: async () => true,
    getGitServer: async () => { throw new Error("Insights must not resolve Provider config") },
    db: {
      issue: { findMany: async ({ where }) => where.type === "optimization" ? optimizationIssues : sourceIssues },
      issueStat: { findMany: async () => sourceIssues.map((issue) => ({ id: issue.id, buildTaskTurns: 2 })) },
    },
  }
  const result = await listAutomationOptimizations({
    store, gitServerId: "gitlab-1", projectId: "43326", userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-1", token: "user-token" },
    input: { issueNumbers: [17, 81, 82] },
  })
  assert.deepEqual(result.items.map((item) => item.sourceIssueNumber), [17, 83])
  assert.equal(result.items[0].issue.title, "Source")
  assert.equal(result.items[0].issue.author.name, "Alice")
  assert.equal(result.items[0].status, "analyzing")
  assert.equal(result.items[0].optimizationIssueNumber, 81)
  assert.equal(result.items[1].issue.title, "Legacy")
  assert.equal(result.items[1].issue.author.name, "")
})

test("automation optimization creation is blocked only while analysis is active or complete", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  let createdIssue
  let nextIssueNumber = 81
  const sourceRow = { id: "issue-row-17", issueId: "17", issueNumber: 17, title: "Add checkout", author: "alice", state: "closed", type: "feature", optimizationState: "", optimizationSourceIssueNumber: 0 }
  let optimizationRows = []
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
    if (request.method === "GET" && request.url.endsWith("/issues/17")) {
      return new Response(JSON.stringify(sourceIssue), { status: 200 })
    }
    if (request.method === "GET" && request.url.includes("/issues?") && request.url.includes("labels=type%3A%3Aoptimization")) {
      return new Response(JSON.stringify(createdIssue?.state === "opened" ? [createdIssue] : []), { status: 200 })
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
        findUnique: async () => sourceRow,
        findMany: async ({ where }) => where.type === "optimization" ? optimizationRows : [sourceRow],
      },
      issueStat: {
        findMany: async () => [{ id: "issue-row-17", planTaskTurns: 3, buildTaskTurns: 2 }],
      },
    },
    upsertIssueSnapshot: async (snapshot) => {
      const issue = {
        id: `issue-row-${snapshot.issueNumber}`,
        issueId: snapshot.issueId,
        issueNumber: snapshot.issueNumber,
        title: snapshot.title,
        author: snapshot.author,
        state: snapshot.state,
        type: snapshot.type,
        optimizationState: snapshot.optimizationState,
        optimizationSourceIssueNumber: snapshot.optimizationSourceIssueNumber,
      }
      optimizationRows.push(issue)
      return { issue, applied: false }
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
  assert.equal(requests.some((request) => request.method === "GET" && request.url.includes("/issues?")), false)
  assert.deepEqual(sourceIssue.labels, ["type::feature", "status::done"])
  assert.equal(optimizationRows[0].optimizationSourceIssueNumber, 17)
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

  sourceRow.optimizationState = "analyzing"
  optimizationRows = [{ id: "issue-row-81", issueId: "81", issueNumber: 81, title: "Optimize", author: "alice", state: "opened", type: "optimization", optimizationState: "", optimizationSourceIssueNumber: 17 }]
  const providerRequestCount = requests.length
  let status = await listAutomationOptimizations({ ...input, input: { issueNumbers: [17] } })
  assert.deepEqual({
    sourceIssueNumber: status.items[0].sourceIssueNumber,
    phases: status.items[0].phases,
    status: status.items[0].status,
    optimizationIssueNumber: status.items[0].optimizationIssueNumber,
    optimizationIssueUrl: status.items[0].optimizationIssueUrl,
  }, {
    sourceIssueNumber: 17,
    phases: [{ phase: "plan", turns: 3 }, { phase: "build", turns: 2 }],
    status: "analyzing",
    optimizationIssueNumber: 81,
    optimizationIssueUrl: "",
  })
  assert.equal(status.items[0].issue.title, "Add checkout")
  assert.equal(requests.length, providerRequestCount)

  optimizationRows[0].state = "closed"
  status = await listAutomationOptimizations({ ...input, input: { issueNumbers: [17] } })
  assert.equal(status.items[0].status, "available")
  assert.equal(status.items[0].optimizationIssueNumber, 0)
  const restarted = await createAutomationOptimizationIssue(input)
  assert.equal(restarted.issue.number, 82)
  assert.equal(requests.filter((request) => request.method === "POST").length, 2)

  sourceRow.optimizationState = "analyzed"
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

test("GitLab issue pages request one lookahead item", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify(Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      iid: index + 1,
      title: `Issue ${index + 1}`,
      state: "opened",
      labels: [],
    }))), { status: 200 })
  }

  const first = await listProviderIssuesPage(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" },
    { serverRepoId: "43326" },
    { state: "open", page: 1, perPage: 50 },
  )
  const second = await listProviderIssuesPage(
    { type: "gitlab", apiUrl: "https://gitlab.test/api/v4", userToken: "user-token" },
    { serverRepoId: "43326" },
    { state: "open", page: 2, perPage: 50 },
  )

  assert.equal(first.issues.length, 50)
  assert.equal(first.hasMore, true)
  assert.equal(second.page, 2)
  assert.match(requests[0], /per_page=51/)
  assert.match(requests[0], /page=1/)
  assert.match(requests[1], /page=2/)
})

test("GitHub issue detail normalizes milestone and non-zero comment reactions", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/repos/acme/widget/issues/7")) return new Response(JSON.stringify({ id: 7, number: 7, title: "Issue", state: "open", user: { id: 1, login: "author" }, milestone: { id: 3, title: "v1.0", description: "Release", state: "open", due_on: "2026-08-01T00:00:00Z", html_url: "https://github.test/acme/widget/milestone/3" } }), { status: 200 })
    if (path.includes("/repos/acme/widget/issues/7/comments?")) return new Response(JSON.stringify([{ id: 11, body: "Comment", user: { id: 2, login: "alice" }, reactions: { total_count: 3, "+1": 2, "-1": 0, laugh: 1, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 } }]), { status: 200 })
    if (path.endsWith("/repos/acme/widget/labels?per_page=100")) return new Response(JSON.stringify([]), { status: 200 })
    if (path.endsWith("/repos/acme/widget")) return new Response(JSON.stringify({ permissions: { push: true } }), { status: 200 })
    if (path.endsWith("/user")) return new Response(JSON.stringify({ id: 2, login: "alice" }), { status: 200 })
    throw new Error(`Unexpected request: ${path}`)
  }

  const detail = await getProviderIssue(
    { type: "github", apiUrl: "https://api.github.test", userToken: "user-token" },
    { fullName: "acme/widget" },
    7,
  )

  assert.deepEqual(detail.issue.milestone, { id: "3", title: "v1.0", description: "Release", state: "open", dueAt: "2026-08-01T00:00:00Z", webUrl: "https://github.test/acme/widget/milestone/3" })
  assert.deepEqual(detail.comments[0].reactions, [{ content: "+1", count: 2 }, { content: "laugh", count: 1 }])
})

test("GitLab issue detail includes comments, labels, and current user permissions", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async (url) => {
    const path = String(url)
    if (path.endsWith("/projects/43326/issues/15")) return new Response(JSON.stringify({ id: 15, iid: 15, title: "Plan", state: "opened", description: "Body", author: { id: 8, username: "author" }, labels: ["feature"], milestone: { id: 4, title: "Sprint 8", description: "Iteration", state: "active", due_date: "2026-08-08", web_url: "https://gitlab.test/acme/widget/-/milestones/4" } }), { status: 200 })
    if (path.includes("/issues/15/notes?")) return new Response(JSON.stringify([{ id: 1, body: "Comment", author: { id: 9, username: "alice" } }, { id: 2, body: "changed title", system: true }]), { status: 200 })
    if (path.endsWith("/issues/15/notes/1/award_emoji?per_page=100")) return new Response(JSON.stringify([{ id: 1, name: "thumbsup" }, { id: 2, name: "thumbsup" }, { id: 3, name: "tada" }]), { status: 200 })
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
  assert.deepEqual(detail.issue.milestone, { id: "4", title: "Sprint 8", description: "Iteration", state: "open", dueAt: "2026-08-08", webUrl: "https://gitlab.test/acme/widget/-/milestones/4" })
  assert.deepEqual(detail.issue.permissions, { canCreate: true, canEdit: true, canClose: true, canLabel: true, canComment: true })
  assert.deepEqual(detail.comments.map((comment) => comment.body), ["Comment"])
  assert.deepEqual(detail.comments[0].reactions, [{ content: "thumbsup", count: 2 }, { content: "tada", count: 1 }])
  assert.deepEqual(detail.availableLabels[0], { name: "feature", color: "428BCA", description: "Feature" })
})

test("Issue detail reads associated merge requests from synchronized pull request facts", async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    const path = String(url)
    requests.push(path)
    if (path.endsWith("/projects/43326/issues/15")) return new Response(JSON.stringify({ id: 15, iid: 15, title: "Plan", state: "opened", description: "Body", author: { id: 8, username: "author" }, labels: [] }), { status: 200 })
    if (path.includes("/issues/15/notes?")) return new Response(JSON.stringify([]), { status: 200 })
    if (path.endsWith("/projects/43326/labels?per_page=100")) return new Response(JSON.stringify([]), { status: 200 })
    if (path.endsWith("/projects/43326")) return new Response(JSON.stringify({ permissions: { project_access: { access_level: 30 } } }), { status: 200 })
    if (path.endsWith("/user")) return new Response(JSON.stringify({ id: 9, username: "alice" }), { status: 200 })
    if (path.endsWith("/markdown") && options.method === "POST") return new Response(JSON.stringify({ html: "<p>Body</p>" }), { status: 200 })
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`)
  }
  const repo = { id: "repo_123", gitServerId: "gitlab-main", serverRepoId: "43326", fullName: "acme/widget" }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: "gitlab", apiUrl: "https://gitlab.test/api/v4", tokenAuth: "private-token" }),
    listPullRequestsByIssue: async (input) => {
      assert.deepEqual(input, { gitServerId: "gitlab-main", repositoryId: "43326", issueNumber: 15 })
      return [
        { id: "pr-41", pullRequestId: "41", prNumber: 21, issueNumber: 15, kind: "plan", state: "merged", htmlUrl: "https://gitlab.test/acme/widget/-/merge_requests/21" },
        { id: "pr-42", pullRequestId: "42", prNumber: 22, issueNumber: 15, kind: "build", state: "open", htmlUrl: "https://gitlab.test/acme/widget/-/merge_requests/22" },
      ]
    },
  }
  const detail = await getIssue({
    store, gitServerId: "gitlab-main", projectId: "43326", issueNumber: 15, userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-main", token: "user-token" },
  })
  assert.deepEqual(detail.mergeRequests.map((mergeRequest) => mergeRequest.number), [21, 22])
  assert.deepEqual(detail.mergeRequests.map((mergeRequest) => mergeRequest.labels), [["mr-by::plan"], ["mr-by::build"]])
  assert.deepEqual(detail.comments, [])
  assert.deepEqual(detail.availableLabels, [])
  assert.equal(requests.some((path) => path.includes("/issues/15/notes?")), false)
  assert.equal(requests.some((path) => path.includes("/labels?")), false)

  const comments = await getIssueComments({
    store, gitServerId: "gitlab-main", projectId: "43326", issueNumber: 15, userId: "user-1",
    session: { userId: "user-1", gitServerId: "gitlab-main", token: "user-token" },
  })
  assert.deepEqual(comments.comments, [])
  assert.equal(requests.some((path) => path.includes("/issues/15/notes?")), true)
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
