const assert = require('node:assert/strict')
const test = require('node:test')

process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test'
require('tsx/cjs')

const { buildReviewComment, decisionRequirementsFromData, listReviewablePlanArtifacts, parseArtifactMarker, parseVisualArtifactJson, pendingDecisionApprovalRefs, submitVisualReview } = require('../src/core/visual-artifacts.ts')
const { renderVisualArtifactDocument } = require('../src/core/visual-renderer.ts')
const {
  applyVisualIssueLabels,
  createPlanMergeRequestComment,
  listPlanMergeRequests,
  mergePlanMergeRequest,
  renderPlanMarkdown,
} = require('../src/core/visual-provider.ts')

function resolveDataRef(data, ref) {
  return ref.split('.').reduce((value, segment) => {
    if (Array.isArray(value)) return /^\d+$/.test(segment)
      ? value[Number(segment)]
      : value.find((entry) => entry && typeof entry === 'object' && entry.id === segment)
    return value && typeof value === 'object' ? value[segment] : undefined
  }, data)
}

function renderedDataRefs(html) {
  return [...html.matchAll(/data-ref="([^"]+)"/g)].map((match) => match[1])
}

test('visual artifact marker carries immutable provider coordinates', () => {
  assert.deepEqual(parseArtifactMarker({
    id: 99,
    number: 7,
    url: 'https://gitlab.test/acme/widget/-/merge_requests/7',
    state: 'opened',
    baseBranch: 'main',
    body: '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan-data.json -->',
    createdAt: '2026-07-14T00:00:00.000Z',
  }), {
    type: 'plan',
    format: 'json',
    repositoryId: 'repo_123',
    issueNumber: 42,
    branch: '42-login/plan',
    commitSha: 'abc123',
    entryPath: '.issue-flow/issues/42-login/plan/data/plan-data.json',
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
        description: '<!-- issue-flow:plan-artifact artifact=decision format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision-data.json -->',
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
  assert.match(JSON.parse(comment.options.body).body, /## Decision Review/)
  assert.match(JSON.parse(comment.options.body).body, /Status: \*\*approved\*\*/)
  assert.match(JSON.parse(comment.options.body).body, /选择方案.*Database/)
})

test('reviewable artifacts only include open Plan MRs for the current repository', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async () => new Response(JSON.stringify([
    {
      id: 71,
      iid: 11,
      description: '<!-- issue-flow:plan-artifact artifact=decision format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision-data.json -->',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'abc123',
      updated_at: '2026-07-15T02:00:00.000Z',
    },
    {
      id: 72,
      iid: 12,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=43 branch=43-export/plan commit=def456 path=.issue-flow/issues/43-export/plan/data/plan-data.json -->',
      state: 'merged',
      source_branch: '43-export/plan',
      target_branch: 'main',
      sha: 'def456',
      updated_at: '2026-07-15T03:00:00.000Z',
    },
    {
      id: 74,
      iid: 14,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=42 branch=42-login/plan commit=plan456 path=.issue-flow/issues/42-login/plan/data/plan-data.json -->',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'plan456',
      updated_at: '2026-07-15T05:00:00.000Z',
    },
    {
      id: 73,
      iid: 13,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_other issue=44 branch=44-other/plan commit=ghi789 path=.issue-flow/issues/44-other/plan/data/plan-data.json -->',
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
  }), [{ issueNumber: 42, type: 'plan', format: 'json', mergeRequestNumber: 14 }])
})

test('Engine renders Plan JSON with fixed layout and stable review anchors', () => {
  const html = renderVisualArtifactDocument({
    schemaVersion: 1,
    artifact: 'plan',
    meta: { title: 'JSON Plan' },
    core: { outcome: 'Render consistently' },
    sections: [
      { id: 'summary', type: 'summary', title: '核心方案' },
      {
        id: 'architecture', type: 'architecture', title: '架构',
        nodes: [{ id: 'engine', name: 'Issue Flow Engine', type: 'service' }, { id: 'provider', name: 'Provider', type: 'external' }],
        edges: [{ id: 'read', sourceId: 'engine', destinationId: 'provider', label: '读取 JSON' }],
      },
      { id: 'validation', type: 'validation', title: '验证', items: [{ id: 'render', title: '固定渲染' }] },
    ],
  }, 'plan')
  assert.match(html, /<style>:root\{color-scheme:light/)
  assert.match(html, /data-ref="sections\.architecture\.nodes\.engine"/)
  assert.match(html, /data-comment-scope="node"/)
  assert.match(html, /读取 JSON/)
  assert.doesNotMatch(html, /<link[^>]+stylesheet/)
})

test('Engine renders boundaries, state refs, path filters, sequence fragments, and matrix cells', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'plan',
    meta: { title: 'Complete Engine Plan' },
    core: {
      outcome: 'Render every review model consistently',
      contradiction: 'Rich semantics with fixed presentation',
      boundary: 'Agent provides facts only',
      recommendation: 'Compile JSON in the Engine',
    },
    sections: [
      { id: 'summary', type: 'summary', title: 'Summary' },
      {
        id: 'lifecycle', type: 'state-machine', title: 'Lifecycle',
        paths: [{ id: 'happy', label: 'Happy path' }, { id: 'retry', label: 'Retry path' }],
        groups: [{ id: 'engine-boundary', label: 'Engine boundary' }],
        states: [
          { id: 'draft', name: 'Draft', groupId: 'engine-boundary', paths: ['happy'] },
          { id: 'approved', name: 'Approved', groupId: 'engine-boundary', paths: ['happy', 'retry'] },
        ],
        transitions: [{ id: 'approve', sourceId: 'draft', destinationId: 'approved', label: 'Approve', paths: ['happy'] }],
      },
      {
        id: 'review-sequence', type: 'sequence', title: 'Review sequence',
        participants: [{ id: 'reviewer', name: 'Reviewer' }, { id: 'engine', name: 'Engine' }],
        messages: [{ id: 'submit', sourceId: 'reviewer', destinationId: 'engine', label: 'Submit', paths: ['happy'] }],
        fragments: [{ id: 'validation-loop', type: 'loop', label: 'Until valid', startId: 'submit', endId: 'submit' }],
      },
      {
        id: 'coverage', type: 'validation-matrix', title: 'Coverage',
        columns: [{ id: 'unit', label: 'Unit' }, { id: 'build', label: 'Build' }],
        rows: [{ id: 'renderer', label: 'Renderer', cells: [{ value: 'pass', tone: 'ok' }, { value: 'pass', tone: 'ok' }] }],
      },
    ],
  }
  const html = renderVisualArtifactDocument(data, 'plan')
  assert.match(html, /data-ref="sections\.lifecycle\.groups\.engine-boundary"/)
  assert.match(html, /data-ref="sections\.lifecycle\.states\.draft"/)
  assert.match(html, /data-vp-filter="happy"/)
  assert.match(html, /data-ref="sections\.review-sequence\.fragments\.validation-loop"/)
  assert.match(html, /data-ref="sections\.coverage\.rows\.renderer\.cells\.0"/)
  assert.match(html, /button\.closest\("\.vp-section"\)/)
  assert.match(html, /section\.querySelectorAll\("\[data-vp-paths\]"\)/)
  assert.doesNotMatch(html, /document\.querySelectorAll\("\[data-vp-paths\]"\)/)
  const unresolved = renderedDataRefs(html).filter((ref) => resolveDataRef(data, ref) === undefined)
  assert.deepEqual(unresolved, [])
})

test('Engine selects graph layouts by semantic type and renders all chart variants', () => {
  const graphNodes = [{ id: 'start', name: 'Start' }, { id: 'finish', name: 'Finish' }]
  const graphEdges = [{ id: 'next', sourceId: 'start', destinationId: 'finish', label: 'Next' }]
  const chartItems = [{ id: 'alpha', label: 'Alpha', value: 30 }, { id: 'beta', label: 'Beta', value: 70 }]
  const data = {
    schemaVersion: 1,
    artifact: 'plan',
    meta: { title: 'Layout and chart strategies' },
    core: { outcome: 'Render by semantic type' },
    sections: [
      { id: 'summary', type: 'summary', title: 'Summary' },
      { id: 'architecture', type: 'architecture', title: 'Architecture', nodes: graphNodes, edges: graphEdges },
      {
        id: 'deployment', type: 'deployment', title: 'Deployment',
        groups: [{ id: 'app', label: 'Application' }, { id: 'provider', label: 'Provider' }],
        nodes: [{ ...graphNodes[0], groupId: 'app' }, { ...graphNodes[1], groupId: 'provider' }],
        edges: graphEdges,
      },
      { id: 'states', type: 'state-machine', title: 'States', nodes: graphNodes, edges: graphEdges },
      { id: 'components', type: 'component-tree', title: 'Components', nodes: graphNodes, edges: graphEdges },
      { id: 'rollout', type: 'rollout', title: 'Rollout', nodes: graphNodes, edges: graphEdges },
      { id: 'bar', type: 'chart', variant: 'bar', title: 'Bar', items: chartItems },
      { id: 'column', type: 'chart', variant: 'column', title: 'Column', items: chartItems },
      { id: 'line', type: 'chart', variant: 'line', title: 'Line', items: chartItems },
      { id: 'area', type: 'chart', variant: 'area', title: 'Area', items: chartItems },
      { id: 'donut', type: 'chart', variant: 'donut', title: 'Donut', items: chartItems },
      { id: 'pie', type: 'chart', variant: 'pie', title: 'Pie', items: chartItems },
      { id: 'validation', type: 'validation', title: 'Validation', items: [{ id: 'render', title: 'Render all variants' }] },
    ],
  }
  const html = renderVisualArtifactDocument(data, 'plan')
  assert.match(html, /data-layout="layered"/)
  assert.match(html, /data-layout="boundary"/)
  assert.match(html, /data-layout="state"/)
  assert.match(html, /data-layout="tree"/)
  assert.match(html, /data-layout="rollout"/)
  assert.match(html, /class="vp-bars"/)
  assert.match(html, /class="vp-columns"/)
  assert.match(html, /data-chart="line"/)
  assert.match(html, /data-chart="area"/)
  assert.match(html, /class="vp-pie-total"/)
  assert.match(html, /class="vp-pie-layout"/)
  const unresolved = renderedDataRefs(html).filter((ref) => resolveDataRef(data, ref) === undefined)
  assert.deepEqual(unresolved, [])
})

test('Engine renders Decision choices with resolvable review anchors', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'decision',
    meta: { title: 'Choose storage' },
    context: { summary: 'Storage changes review history behavior.' },
    decisions: [{
      id: 'storage', type: 'choice', question: 'Where is history stored?', recommendedOptionId: 'local',
      criteria: ['No migration'],
      options: [
        { id: 'local', label: 'LocalStorage', description: 'Browser-local history' },
        { id: 'database', label: 'Database', description: 'Shared history' },
      ],
    }],
  }
  const html = renderVisualArtifactDocument(data, 'decision')
  assert.match(html, /data-ref="decisions\.storage"/)
  assert.match(html, /data-ref="decisions\.storage\.options\.local"/)
  assert.match(html, /<span>推荐<\/span>/)
  const unresolved = renderedDataRefs(html).filter((ref) => resolveDataRef(data, ref) === undefined)
  assert.deepEqual(unresolved, [])
})

test('invalid visual JSON is reported as a controlled artifact error', () => {
  assert.throws(
    () => parseVisualArtifactJson('{"schemaVersion":'),
    (error) => error.code === 'visual_artifact_error' && error.status === 422 && /invalid visual artifact JSON/.test(error.message),
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
          targetId: '.issue-flow/issues/15-issue/plan/data/plan-data.json',
          sourceRefs: [{ type: 'plan', path: '.issue-flow/issues/15-issue/plan/data/plan-data.json' }],
          visualTarget: {
            path: '.issue-flow/issues/15-issue/plan/data/plan-data.json',
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
  assert.match(comment, /产物：`.issue-flow\/issues\/15-issue\/plan\/data\/plan-data.json`/)
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
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan-data.json -->',
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
      return new Response(JSON.stringify({ labels: [{ name: 'type::bug' }, { name: 'flow::plan' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }
  await applyVisualIssueLabels(
    { type: 'github', apiUrl: 'https://api.github.test', userToken: 'user-token' },
    { fullName: 'acme/widget' },
    42,
    { 'flow::': 'flow::approve' },
  )
  assert.deepEqual(JSON.parse(requests[1].options.body).labels, ['type::bug', 'flow::approve'])
})
