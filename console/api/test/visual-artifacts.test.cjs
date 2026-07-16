const assert = require('node:assert/strict')
const test = require('node:test')

process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test'
require('tsx/cjs')

const { buildReviewComment, decisionRequirementsFromData, listReviewablePlanArtifacts, parseArtifactMarker, pendingDecisionApprovalRefs, rewriteHtmlResources, submitVisualReview } = require('../src/core/visual-artifacts.ts')
const {
  applyVisualIssueLabels,
  createPlanMergeRequestComment,
  listPlanMergeRequests,
  mergePlanMergeRequest,
  renderPlanMarkdown,
} = require('../src/core/visual-provider.ts')

test('visual artifact marker carries immutable provider coordinates', () => {
  assert.deepEqual(parseArtifactMarker({
    id: 99,
    number: 7,
    url: 'https://gitlab.test/acme/widget/-/merge_requests/7',
    state: 'opened',
    baseBranch: 'main',
    body: '<!-- issue-flow:plan-artifact artifact=plan format=html repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/index.html -->',
    createdAt: '2026-07-14T00:00:00.000Z',
  }), {
    type: 'plan',
    format: 'html',
    repositoryId: 'repo_123',
    issueNumber: 42,
    branch: '42-login/plan',
    commitSha: 'abc123',
    entryPath: '.issue-flow/issues/42-login/plan/index.html',
    mergeRequestId: '99',
    mergeRequestNumber: 7,
    mergeRequestUrl: 'https://gitlab.test/acme/widget/-/merge_requests/7',
    mergeRequestState: 'opened',
    merged: false,
    baseBranch: 'main',
    publishedAt: '2026-07-14T00:00:00.000Z',
  })
})

test('approve other decisions preserves discussed and already approved decisions', () => {
  assert.deepEqual(pendingDecisionApprovalRefs(
    ['decisions.storage', 'decisions.auth', 'decisions.rollout'],
    [
      { decision: { action: 'discuss', ref: 'decisions.storage' } },
      { decision: { action: 'approve', ref: 'decisions.auth' } },
    ],
  ), ['decisions.rollout'])
})

test('decision requirements distinguish approval and choice items', () => {
  assert.deepEqual(decisionRequirementsFromData({ decisions: [
    { id: 'scope', type: 'approval' },
    {
      id: 'runtime', type: 'choice', recommendedOptionId: 'react',
      options: [{ id: 'react', label: 'React + Vite' }, { id: 'static', label: '静态 HTML' }],
    },
  ] }), [
    { ref: 'decisions.scope', id: 'scope', type: 'approval', options: [], recommendedOptionId: '' },
    {
      ref: 'decisions.runtime', id: 'runtime', type: 'choice', recommendedOptionId: 'react',
      options: [
        { id: 'react', label: 'React + Vite', recommended: false },
        { id: 'static', label: '静态 HTML', recommended: false },
      ],
    },
  ])
})

test('approved Decision comments on the open MR and advances the issue without merging', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (String(url).includes('/merge_requests?')) {
      return new Response(JSON.stringify([{
        id: 71,
        iid: 11,
        description: '<!-- issue-flow:plan-artifact artifact=decision format=html repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision.html -->',
        state: 'opened',
        source_branch: '42-login/plan',
        target_branch: 'main',
        sha: 'abc123',
      }]), { status: 200 })
    }
    if (String(url).includes('/repository/files/')) {
      const content = Buffer.from(JSON.stringify({ decisions: [
        { id: 'storage', type: 'choice', recommendedOptionId: 'database', options: [{ id: 'database', label: 'Database' }, { id: 'file', label: 'File' }] },
        { id: 'auth', type: 'approval' },
      ] })).toString('base64')
      return new Response(JSON.stringify({ content, encoding: 'base64' }), { status: 200 })
    }
    if ((options.method || 'GET') === 'GET' && String(url).endsWith('/issues/42')) {
      return new Response(JSON.stringify({ labels: ['type::feature', 'flow::clarify'] }), { status: 200 })
    }
    if ((options.method || 'GET') === 'PUT' && String(url).endsWith('/issues/42')) {
      return new Response(JSON.stringify({}), { status: 200 })
    }
    if ((options.method || 'GET') === 'POST' && String(url).endsWith('/merge_requests/11/notes')) {
      return new Response(JSON.stringify({ id: 501 }), { status: 201 })
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`)
  }
  const repo = { id: 'repo_123', gitServerId: 'gitlab-main', serverRepoId: '43326', fullName: 'acme/widget', defaultBranch: 'main' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', tokenAuth: 'private-token' }),
  }

  const result = await submitVisualReview({
    store,
    gitServerId: 'gitlab-main',
    projectId: '43326',
    issueNumber: 42,
    type: 'decision',
    userId: 'user-1',
    session: { userId: 'user-1', gitServerId: 'gitlab-main', token: 'user-token' },
    input: { approveAll: true, items: [] },
  })

  assert.equal(result.status, 'approved')
  assert.equal(result.flow, 'flow::plan')
  assert.equal(requests.some((request) => request.url.endsWith('/merge_requests/11/merge')), false)
  const labelUpdate = requests.find((request) => request.url.endsWith('/issues/42') && request.options.method === 'PUT')
  assert.deepEqual(JSON.parse(labelUpdate.options.body), { labels: 'type::feature,flow::plan' })
  const comment = requests.find((request) => request.url.endsWith('/merge_requests/11/notes'))
  assert.match(JSON.parse(comment.options.body).body, /artifact=decision[^>]*status=approved/)
  assert.match(JSON.parse(comment.options.body).body, /选择方案.*Database/)
})

test('reviewable artifacts only include open Plan MRs for the current repository', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async () => new Response(JSON.stringify([
    {
      id: 71,
      iid: 11,
      description: '<!-- issue-flow:plan-artifact artifact=decision format=html repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision.html -->',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'abc123',
      updated_at: '2026-07-15T02:00:00.000Z',
    },
    {
      id: 72,
      iid: 12,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=html repo=repo_123 issue=43 branch=43-export/plan commit=def456 path=.issue-flow/issues/43-export/plan/index.html -->',
      state: 'merged',
      source_branch: '43-export/plan',
      target_branch: 'main',
      sha: 'def456',
      updated_at: '2026-07-15T03:00:00.000Z',
    },
    {
      id: 73,
      iid: 13,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=html repo=repo_other issue=44 branch=44-other/plan commit=ghi789 path=.issue-flow/issues/44-other/plan/index.html -->',
      state: 'opened',
      source_branch: '44-other/plan',
      target_branch: 'main',
      sha: 'ghi789',
      updated_at: '2026-07-15T04:00:00.000Z',
    },
  ]), { status: 200 })
  const repo = { id: 'repo_123', gitServerId: 'gitlab-main', serverRepoId: '43326', fullName: 'acme/widget' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', tokenAuth: 'private-token' }),
  }

  assert.deepEqual(await listReviewablePlanArtifacts({
    store,
    gitServerId: 'gitlab-main',
    projectId: '43326',
    userId: 'user-1',
    session: { userId: 'user-1', gitServerId: 'gitlab-main', token: 'user-token' },
  }), [{ issueNumber: 42, type: 'decision', format: 'html', mergeRequestNumber: 11 }])
})

test('visual artifact resources resolve from the full repository entry path', () => {
  const html = '<link rel="stylesheet" href="../../../../.agentrix/plugins/issue-flow/skills/vision-plan/plan-kit/kit.css">'
  const rewritten = rewriteHtmlResources(
    html,
    'gitlab-main',
    '43326',
    15,
    'plan',
    '.issue-flow/issues/15-issue/plan/index.html',
  )
  assert.equal(
    rewritten,
    '<link rel="stylesheet" href="/api/visual-artifacts/gitlab-main/43326/15/plan/file?path=.agentrix%2Fplugins%2Fissue-flow%2Fskills%2Fvision-plan%2Fplan-kit%2Fkit.css">',
  )
})

test('visual review comment includes the selected anchor and page content', () => {
  const comment = buildReviewComment(
    { type: 'plan' },
    {
      id: 'visual_review_1',
      payload: {
        items: [{
          comment: '确认一下还会有其他状态吗？',
          targetId: '.issue-flow/issues/15-issue/plan/index.html',
          sourceRefs: [{ type: 'plan', path: '.issue-flow/issues/15-issue/plan/index.html' }],
          visualTarget: {
            path: '.issue-flow/issues/15-issue/plan/index.html',
            anchorRef: 'requirements.status-change',
            anchorSelector: 'li[data-ref="requirements.status-change"]',
            element: {
              dataRef: 'requirements.status-change',
              selector: 'li[data-ref="requirements.status-change"]',
              html: '<li data-ref="requirements.status-change">任务支持新增、编辑、删除和状态变更。</li>',
            },
          },
        }],
      },
    },
    'changes-requested',
  )

  assert.match(comment, /\*\*确认一下还会有其他状态吗？\*\*/)
  assert.match(comment, /产物：`.issue-flow\/issues\/15-issue\/plan\/index.html`/)
  assert.match(comment, /锚点：`requirements.status-change`/)
  assert.match(comment, /页面内容：任务支持新增、编辑、删除和状态变更。/)
  assert.match(comment, /请根据以上审阅意见更新当前 Plan 产物/)
  assert.doesNotMatch(comment, /@agentrix/)
  assert.doesNotMatch(comment, /<li/)
})

test('approved visual plan comment does not ask Agentrix to resume plan', () => {
  const comment = buildReviewComment(
    { type: 'plan' },
    { id: 'visual_review_2', payload: { items: [] } },
    'approved',
  )

  assert.match(comment, /Status: \*\*approved\*\*/)
  assert.doesNotMatch(comment, /@agentrix/)
})

test('approved visual decision comment triggers the review comment pipeline', () => {
  const comment = buildReviewComment(
    { type: 'decision' },
    { id: 'visual_review_3', payload: { items: [] } },
    'approved',
  )

  assert.match(comment, /Status: \*\*approved\*\*/)
  assert.match(comment, /Decision 已批准，请基于已确认的选择生成并提交 Plan/)
  assert.doesNotMatch(comment, /@agentrix/)
})

test('GitLab artifact discovery lists plan MRs with the current user token', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  let request
  global.fetch = async (url, options) => {
    request = { url: String(url), options }
    return new Response(JSON.stringify([{
      id: 77,
      iid: 9,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=html repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/index.html -->',
      title: 'Plan #42',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'abc123',
      web_url: 'https://gitlab.test/acme/widget/-/merge_requests/9',
    }]), { status: 200 })
  }
  const result = await listPlanMergeRequests(
    { type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', userToken: 'user-token', tokenAuth: 'private-token' },
    { serverRepoId: '43326', fullName: 'acme/widget' },
  )
  assert.match(request.url, /projects\/43326\/merge_requests\?scope=all&state=all&labels=mr-by%3A%3Aplan/)
  assert.equal(request.options.headers['PRIVATE-TOKEN'], 'user-token')
  assert.equal(result[0].number, 9)
  assert.equal(result[0].commitSha, 'abc123')
})

test('GitHub and GitLab reviews comment on the Plan PR or MR', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    return new Response(JSON.stringify({ id: requests.length }), { status: 201 })
  }
  await createPlanMergeRequestComment(
    { type: 'github', apiUrl: 'https://api.github.test', userToken: 'github-user-token' },
    { fullName: 'acme/widget' },
    9,
    'review body',
  )
  await createPlanMergeRequestComment(
    { type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', userToken: 'gitlab-user-token', tokenAuth: 'private-token' },
    { serverRepoId: '43326' },
    10,
    'review body',
  )
  assert.equal(requests[0].url, 'https://api.github.test/repos/acme/widget/issues/9/comments')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer github-user-token')
  assert.equal(requests[1].url, 'https://gitlab.test/api/v4/projects/43326/merge_requests/10/notes')
  assert.equal(requests[1].options.headers['PRIVATE-TOKEN'], 'gitlab-user-token')
  assert.deepEqual(JSON.parse(requests[1].options.body), { body: 'review body' })
})

test('GitHub and GitLab plan approval merge the Plan PR or MR', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    const body = String(url).includes('github')
      ? { sha: 'merge-sha', merged: true }
      : { id: 77, iid: 10, state: 'merged' }
    return new Response(JSON.stringify(body), { status: 200 })
  }
  await mergePlanMergeRequest(
    { type: 'github', apiUrl: 'https://api.github.test', userToken: 'github-user-token' },
    { fullName: 'acme/widget' },
    9,
  )
  await mergePlanMergeRequest(
    { type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', userToken: 'gitlab-user-token', tokenAuth: 'private-token' },
    { serverRepoId: '43326' },
    10,
  )
  assert.equal(requests[0].url, 'https://api.github.test/repos/acme/widget/pulls/9/merge')
  assert.deepEqual(JSON.parse(requests[0].options.body), { merge_method: 'merge' })
  assert.equal(requests[1].url, 'https://gitlab.test/api/v4/projects/43326/merge_requests/10/merge')
  assert.deepEqual(JSON.parse(requests[1].options.body), { should_remove_source_branch: true, squash: false })
})

test('Markdown plans are rendered through the provider API', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if (String(url).includes('github')) return new Response('<h1>GitHub plan</h1>', { status: 200 })
    return new Response(JSON.stringify({ html: '<h1>GitLab plan</h1>' }), { status: 200 })
  }
  assert.equal(await renderPlanMarkdown(
    { type: 'github', apiUrl: 'https://api.github.test', userToken: 'github-user-token' },
    { fullName: 'acme/widget' },
    '# Plan',
  ), '<h1>GitHub plan</h1>')
  assert.equal(await renderPlanMarkdown(
    { type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', userToken: 'gitlab-user-token', tokenAuth: 'private-token' },
    { fullName: 'acme/widget' },
    '# Plan',
  ), '<h1>GitLab plan</h1>')
  assert.deepEqual(JSON.parse(requests[0].options.body), { text: '# Plan', mode: 'gfm', context: 'acme/widget' })
  assert.deepEqual(JSON.parse(requests[1].options.body), { text: '# Plan', gfm: true, project: 'acme/widget' })
})

test('visual label updates preserve unrelated labels', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options })
    if ((options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({ labels: [{ name: 'type::bug' }, { name: 'flow::plan' }, { name: 'plan::changes-requested' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }
  await applyVisualIssueLabels(
    { type: 'github', apiUrl: 'https://api.github.test', userToken: 'user-token' },
    { fullName: 'acme/widget' },
    42,
    { 'flow::': 'flow::approve', 'plan::': 'plan::pending' },
  )
  assert.deepEqual(JSON.parse(requests[1].options.body).labels, ['type::bug', 'flow::approve', 'plan::pending'])
})
