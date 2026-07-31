const assert = require('node:assert/strict')
const test = require('node:test')

process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test'
require('tsx/cjs')

const { approveOptimizationProposal, buildReviewComment, decisionRequirementsFromData, developerFeedbackDraft, getVisualArtifact, listReviewablePlanArtifacts, markdownDocument, mergeRequestArtifact, mergeRequestArtifacts, parseArtifactMarker, parseVisualArtifactJson, pendingDecisionApprovalRefs, planFilePathFromBody, structureMarkdownSections, submitVisualReview } = require('../src/core/visual-artifacts.ts')
const { previewDescriptorForPath } = require('../src/core/preview/registry.ts')
const { renderVisualArtifactDocument } = require('../src/core/visual-renderer.ts')
const { allOptimizationProposalsTerminal, deriveOptimizationProposalStates, parseProposalMarker, proposalMarker, validateOptimizationArtifact } = require('../src/core/optimization-artifact.ts')
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

test('visual artifact marker carries immutable artifact coordinates without a repository id', () => {
  assert.deepEqual(parseArtifactMarker({
    id: 99,
    number: 7,
    url: 'https://gitlab.test/acme/widget/-/merge_requests/7',
    state: 'opened',
    baseBranch: 'main',
    body: '<!-- issue-flow:plan-artifact artifact=plan format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan.json.isv -->',
    createdAt: '2026-07-14T00:00:00.000Z',
  }), {
    type: 'plan',
    format: 'json',
    issueNumber: 42,
    branch: '42-login/plan',
    commitSha: 'abc123',
    entryPath: '.issue-flow/issues/42-login/plan/data/plan.json.isv',
    mergeRequestId: '99',
    mergeRequestNumber: 7,
    mergeRequestUrl: 'https://gitlab.test/acme/widget/-/merge_requests/7',
    mergeRequestState: 'opened',
    merged: false,
    baseBranch: 'main',
    publishedAt: '2026-07-14T00:00:00.000Z',
  })
})

test('optimization artifact validates independent executable proposals', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'optimization',
    target: { summary: 'Plan required two corrections', cause: ['Project conventions were not discoverable'] },
    proposals: [{
      id: 'document-conventions', kind: 'project-change',
      title: 'Document routing conventions',
      solution: 'Add the stable routing contract to project instructions.',
      validation: ['A fresh Plan task follows the contract without correction'],
      issue: {
        title: 'Document routing conventions', body: 'Add the routing contract.',
        type: 'type::docs', priority: 'priority::p2', size: 'size::S', flow: 'flow::build', labels: ['documentation'],
      },
    }],
  }
  assert.equal(validateOptimizationArtifact(data), data)
  assert.throws(() => validateOptimizationArtifact({ ...data, currentContext: 'not allowed' }), /unsupported fields: currentContext/)
  assert.throws(() => validateOptimizationArtifact({ ...data, target: { ...data.target, cause: ['Task task-123 sequence 9 missed the requirement'] } }), /must not contain Task IDs/)
  assert.throws(() => validateOptimizationArtifact({ ...data, proposals: [{ ...data.proposals[0], issue: { ...data.proposals[0].issue, flow: 'flow::plan' } }] }), /type::docs must use flow::build/)
  assert.throws(() => validateOptimizationArtifact({ ...data, proposals: [{ ...data.proposals[0], issue: { ...data.proposals[0].issue, labels: ['status::done'] } }] }), /cannot contain managed label/)
  assert.throws(() => validateOptimizationArtifact({ ...data, proposals: [{ ...data.proposals[0], kind: 'issue-flow-feedback' }] }), /must use type::bug/)
  assert.equal(validateOptimizationArtifact({
    ...data,
    proposals: [{
      ...data.proposals[0], kind: 'issue-flow-feedback',
      issue: { ...data.proposals[0].issue, type: 'type::bug', flow: 'flow::triage' },
    }],
  }).proposals[0].kind, 'issue-flow-feedback')
  assert.equal(validateOptimizationArtifact({
    ...data,
    proposals: [{
      id: 'provide-toolchain', kind: 'project-developer-feedback', title: 'Provide a reproducible Java toolchain',
      solution: 'Project maintainers should expose a supported JDK and Maven execution entrypoint.',
      validation: ['A fresh Build task can execute the declared Maven test command'],
    }],
  }).proposals[0].kind, 'project-developer-feedback')
  assert.throws(() => validateOptimizationArtifact({
    ...data,
    proposals: [{ ...data.proposals[0], kind: 'project-developer-feedback' }],
  }), /project developer feedback must not contain issue/)
})

test('optimization proposal state is derived from provider markers and terminal labels', () => {
  const marker = proposalMarker({ optimizationIssueNumber: 81, sourceIssueNumber: 17, proposalId: 'docs' })
  assert.deepEqual(parseProposalMarker(marker), { optimizationIssueNumber: 81, sourceIssueNumber: 17, proposalId: 'docs', action: 'created' })
  const data = { proposals: [{ id: 'docs' }, { id: 'tests' }, { id: 'tooling' }] }
  const states = deriveOptimizationProposalStates(data, 81, [
    { body: proposalMarker({ optimizationIssueNumber: 81, sourceIssueNumber: 17, proposalId: 'tests', action: 'ignored' }) },
  ], [
    { number: 82, title: 'Docs', state: 'closed', body: marker, labels: [{ name: 'status::done' }] },
  ])
  assert.deepEqual(states.map((item) => item.state), ['completed', 'ignored', 'pending'])
  assert.equal(allOptimizationProposalsTerminal(states), false)
  assert.equal(allOptimizationProposalsTerminal([
    { kind: 'project-change', state: 'completed' },
    { kind: 'project-developer-feedback', state: 'pending' },
    { kind: 'issue-flow-feedback', state: 'pending' },
  ]), true)
  assert.equal(allOptimizationProposalsTerminal([{ kind: 'project-developer-feedback', state: 'pending' }]), true)
  assert.equal(allOptimizationProposalsTerminal([{ kind: 'issue-flow-feedback', state: 'pending' }]), true)
  assert.equal(allOptimizationProposalsTerminal(states.map((item) => item.id === 'tooling' ? { ...item, state: 'cancelled' } : item)), true)
})

test('Engine renders Optimization JSON with reusable review anchors and runtime states', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'optimization',
    target: { summary: 'Build needed a correction', cause: ['The project contract was missing'] },
    proposals: [{
      id: 'add-contract', kind: 'project-change', title: 'Add project contract', solution: 'Document the stable behavior.',
      validation: ['A new task completes in one turn'],
      issue: { title: 'Add contract', body: 'Update instructions.', type: 'type::docs', priority: 'priority::p2', size: 'size::S', flow: 'flow::build', labels: [] },
    }],
  }
  const html = renderVisualArtifactDocument(data, 'optimization', { optimizationStates: [{ id: 'add-contract', state: 'pending', childIssue: null }] })
  assert.match(html, /Automation Optimization/)
  assert.match(html, /data-ref="target\.cause"/)
  assert.match(html, /vp-optimization-causes/)
  assert.match(html, /data-ref="proposals\.add-contract\.solution"/)
  assert.match(html, /data-optimization-actions="add-contract"/)
  assert.match(html, />待处理</)
  const unresolved = renderedDataRefs(html).filter((ref) => resolveDataRef(data, ref) === undefined)
  assert.deepEqual(unresolved, [])
})

test('Engine renders Issue Flow feedback as public developer feedback instead of a pending proposal', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'optimization',
    target: { summary: 'Build context was incomplete', cause: ['A workflow defect dropped required context'] },
    proposals: [{
      id: 'report-context-defect', kind: 'issue-flow-feedback', title: 'Report context defect', solution: 'Preserve the approved Build Task association.',
      validation: ['A reproduced chain includes the Build Task'],
      issue: { title: 'Fix task-context Build Task association', body: 'Expected the Build Task to be present.', type: 'type::bug', priority: 'priority::p1', size: 'size::M', flow: 'flow::triage', labels: [] },
    }],
  }
  const html = renderVisualArtifactDocument(data, 'optimization', { optimizationStates: [{ id: 'report-context-defect', state: 'pending', childIssue: null }] })
  assert.match(html, /data-optimization-kind="issue-flow-feedback"/)
  assert.match(html, /data-optimization-state="issue-flow-feedback"/)
  assert.match(html, />Issue Flow 开发者反馈</)
  assert.match(html, /反馈仓库 · nil4u\/issue-flow/)
  assert.doesNotMatch(html, />待处理</)
})

test('Engine renders project developer feedback without copy or Issue actions', () => {
  const data = {
    schemaVersion: 1,
    artifact: 'optimization',
    target: { summary: 'Java tests could not run', cause: ['The project does not expose a reproducible Java toolchain'] },
    proposals: [{
      id: 'provide-toolchain', kind: 'project-developer-feedback', title: 'Provide a reproducible Java toolchain',
      solution: 'Project maintainers should expose a supported JDK and Maven execution entrypoint.',
      validation: ['A fresh Build task can execute the declared Maven test command'],
    }],
  }
  const html = renderVisualArtifactDocument(data, 'optimization', { optimizationStates: [{ id: 'provide-toolchain', state: 'pending', childIssue: null }] })
  assert.match(html, /data-optimization-state="project-developer-feedback"/)
  assert.match(html, />项目开发者建议</)
  assert.match(html, />建议内容</)
  assert.doesNotMatch(html, /data-optimization-actions=/)
  assert.doesNotMatch(html, /<div class="vp-optimization-issue"/)
  assert.doesNotMatch(html, />待处理</)
  const unresolved = renderedDataRefs(html).filter((ref) => resolveDataRef(data, ref) === undefined)
  assert.deepEqual(unresolved, [])
})

test('approving an optimization proposal creates one linked Issue with fixed workflow labels', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  const artifact = {
    schemaVersion: 1,
    artifact: 'optimization',
    target: { summary: 'Review needed correction', cause: ['Project knowledge was missing'] },
    proposals: [{
      id: 'project-docs', kind: 'project-change', title: 'Add project knowledge', solution: 'Document the missing contract.', validation: ['A new task completes in one turn'],
      issue: { title: 'Document project contract', body: 'Add the missing contract.', type: 'type::docs', priority: 'priority::p2', size: 'size::S', flow: 'flow::build', labels: ['documentation'] },
    }],
  }
  global.fetch = async (url, options = {}) => {
    const request = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined }
    requests.push(request)
    if (request.method === 'GET' && request.url.includes('/merge_requests?')) return new Response(JSON.stringify([{
      id: 91, iid: 19, description: '<!-- issue-flow:plan-artifact artifact=optimization format=json issue=81 branch=81-optimize/plan commit=abc123 path=.issue-flow/issues/81-optimize/plan/data/optimization-data.json -->',
      state: 'opened', source_branch: '81-optimize/plan', target_branch: 'main', sha: 'abc123',
    }]), { status: 200 })
    if (request.method === 'GET' && request.url.endsWith('/merge_requests/19')) return new Response(JSON.stringify({
      id: 91, iid: 19, description: '<!-- issue-flow:plan-artifact artifact=optimization format=json issue=81 branch=81-optimize/plan commit=abc123 path=.issue-flow/issues/81-optimize/plan/data/optimization-data.json -->',
      labels: ['mr-by::plan'], state: 'opened', source_branch: '81-optimize/plan', target_branch: 'main', sha: 'abc123',
    }), { status: 200 })
    if (request.method === 'GET' && request.url.endsWith('/merge_requests/19/changes')) return new Response(JSON.stringify({ changes: [{
      old_path: '.issue-flow/issues/81-optimize/plan/data/optimization-data.json',
      new_path: '.issue-flow/issues/81-optimize/plan/data/optimization-data.json',
      new_file: true,
    }] }), { status: 200 })
    if (request.method === 'GET' && request.url.includes('/repository/files/')) return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(artifact)).toString('base64'), encoding: 'base64' }), { status: 200 })
    if (request.method === 'GET' && request.url.includes('/merge_requests/19/notes?')) return new Response(JSON.stringify([]), { status: 200 })
    if (request.method === 'GET' && request.url.includes('/issues?')) return new Response(JSON.stringify([
      { id: 17, iid: 17, title: 'Source', description: '', state: 'closed', labels: ['optimization::analyzing'] },
      { id: 81, iid: 81, title: 'Optimize', description: '<!-- issue-flow:automation-optimization source-issue=17 -->', state: 'opened', labels: ['type::optimization', 'flow::approve'] },
    ]), { status: 200 })
    if (request.method === 'POST' && request.url.endsWith('/issues')) return new Response(JSON.stringify({ id: 82, iid: 82, title: request.body.title, description: request.body.description, state: 'opened', labels: request.body.labels.split(',') }), { status: 201 })
    if (request.method === 'POST' && request.url.endsWith('/merge_requests/19/notes')) return new Response(JSON.stringify({ id: 501 }), { status: 201 })
    throw new Error(`Unexpected request: ${request.method} ${request.url}`)
  }
  const repo = { id: 'repo_123', gitServerId: 'gitlab-main', serverRepoId: '43326', fullName: 'acme/widget', defaultBranch: 'main' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', tokenAuth: 'private-token' }),
  }
  const result = await approveOptimizationProposal({
    store, gitServerId: 'gitlab-main', projectId: '43326', issueNumber: 81, proposalId: 'project-docs', userId: 'user-1',
    session: { userId: 'user-1', gitServerId: 'gitlab-main', token: 'user-token' },
  })
  assert.equal(result.created, true)
  assert.equal(result.proposal.childIssue.number, 82)
  const create = requests.find((request) => request.method === 'POST' && request.url.endsWith('/issues'))
  assert.deepEqual(create.body.labels.split(','), ['type::docs', 'status::active', 'flow::build', 'automation::build', 'priority::p2', 'size::S', 'documentation'])
  assert.match(create.body.description, /optimization-issue=81 source-issue=17 proposal=project-docs/)
  const comment = requests.find((request) => request.method === 'POST' && request.url.endsWith('/merge_requests/19/notes'))
  assert.match(comment.body.body, /source_agent=issue-flow/)
  assert.match(comment.body.body, /创建执行 Issue：#82/)
})

test('Issue Flow developer feedback produces a copyable GitHub Issue draft without creating it', () => {
  const draft = developerFeedbackDraft({
    kind: 'issue-flow-feedback', title: 'Report context defect', solution: 'Preserve the approved Build Task association.', validation: ['A reproduced chain includes the Build Task'],
    issue: { title: 'Fix task-context Build Task association', body: 'Expected the Build Task to be present, but it was omitted.', priority: 'priority::p1', size: 'size::M', labels: [] },
  }, { fullName: 'acme/widget' }, 17)
  assert.deepEqual(draft.labels, ['type::bug', 'status::active', 'flow::triage', 'automation::off', 'priority::p1', 'size::M'])
  assert.match(draft.text, /Fix task-context Build Task association/)
  assert.match(draft.text, /Repository: acme\/widget/)
  const url = new URL(draft.url)
  assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/nil4u/issue-flow/issues/new')
  assert.equal(url.searchParams.get('labels'), draft.labels.join(','))
  assert.equal(url.searchParams.has('body'), false)
})

test('Plan preview resolves a legacy Markdown Plan from its MR and follows the current head', () => {
  const body = [
    '<!-- issue-flow:source-issue=1030 -->',
    '<!-- issue-flow:plan-artifact artifact=plan format=markdown issue=1030 branch=1030-feat/plan commit=old-head path=.issue-flow/issues/1030-feat/plan/001-implementation.md -->',
    '## Plan file',
    '',
    '.issue-flow/issues/1030-feat/plan/001-implementation.md',
  ].join('\n')
  assert.equal(planFilePathFromBody(body), '.issue-flow/issues/1030-feat/plan/001-implementation.md')
  assert.deepEqual(mergeRequestArtifact({
    id: '71', number: 1196, body, state: 'open', headBranch: '1030-feat/plan', commitSha: 'current-head',
    labels: ['mr-by::plan'],
    updatedAt: '2026-07-29T00:00:00.000Z',
  }, 1030), {
    type: 'plan', format: 'markdown', previewer: 'markdown', workflow: 'plan', issueNumber: 1030, branch: '1030-feat/plan', commitSha: 'current-head',
    entryPath: '.issue-flow/issues/1030-feat/plan/001-implementation.md', mergeRequestId: '71', mergeRequestNumber: 1196,
    mergeRequestUrl: '', mergeRequestState: 'open', merged: false, baseBranch: '', publishedAt: '2026-07-29T00:00:00.000Z',
  })
})

test('Plan preview prefers current changed files over a stale marker', () => {
  const artifact = mergeRequestArtifact({
    id: '71', number: 1196,
    body: '<!-- issue-flow:source-issue=1030 -->\n<!-- issue-flow:plan-artifact artifact=plan format=markdown issue=1030 branch=1030-feat/plan commit=old-head path=.issue-flow/issues/1030-feat/plan/000-old.md -->',
    state: 'open',
    labels: ['mr-by::plan'],
    headBranch: '1030-feat/plan', commitSha: 'current-head',
    files: [
      { path: '.issue-flow/issues/1030-feat/plan/001-implementation.md', status: 'added' },
      { path: '.issue-flow/issues/1030-feat/decision/data/decision.json.isv', status: 'removed' },
    ],
  }, 1030)
  assert.equal(artifact.type, 'plan')
  assert.equal(artifact.format, 'markdown')
  assert.equal(artifact.entryPath, '.issue-flow/issues/1030-feat/plan/001-implementation.md')
  assert.equal(artifact.commitSha, 'current-head')
})

test('MR preview discovers .isv files by suffix in any directory', () => {
  const mergeRequest = {
    id: '81', number: 21,
    body: '<!-- issue-flow:source-issue=42 -->\n## Plan file\n\n`docs/guide.md`',
    labels: ['mr-by::build'],
    state: 'open', headBranch: '42-build', commitSha: 'head-42',
    files: [
      { path: 'specs/implementation-review.isv', status: 'modified' },
      { path: 'docs/guide.md', status: 'added' },
      { path: 'legacy/decision-data.json', status: 'modified' },
      { path: 'legacy/plan-data.json', status: 'modified' },
      { path: 'decisions/gate.isv', status: 'renamed' },
      { path: 'docs/removed.md', status: 'removed' },
      { path: 'src/main.ts', status: 'modified' },
    ],
  }
  const artifacts = mergeRequestArtifacts(mergeRequest, 42)

  assert.deepEqual(artifacts.map(({ entryPath, type, previewer, workflow }) => ({ entryPath, type, previewer, workflow })), [
    { entryPath: 'docs/guide.md', type: 'markdown', previewer: 'markdown', workflow: 'preview' },
    { entryPath: 'decisions/gate.isv', type: 'visual', previewer: 'issue-flow-visual', workflow: 'preview' },
    { entryPath: 'legacy/decision-data.json', type: 'decision', previewer: 'decision-json', workflow: 'preview' },
    { entryPath: 'legacy/plan-data.json', type: 'plan', previewer: 'plan-json', workflow: 'preview' },
    { entryPath: 'specs/implementation-review.isv', type: 'visual', previewer: 'issue-flow-visual', workflow: 'preview' },
  ])
  assert.equal(mergeRequestArtifact(mergeRequest, 42, undefined, 'specs/implementation-review.isv').entryPath, 'specs/implementation-review.isv')
  assert.equal(previewDescriptorForPath('nested/anything.JSON.ISV').previewer, 'issue-flow-visual')
  assert.equal(previewDescriptorForPath('nested/decision-data.json').kind, 'decision')
  assert.equal(previewDescriptorForPath('nested/plan-data.json').kind, 'plan')
  assert.equal(previewDescriptorForPath('docs/guide.md').kind, 'markdown')
  assert.equal(previewDescriptorForPath('nested/other.json'), undefined)
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
        description: '<!-- issue-flow:plan-artifact artifact=decision format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision.json.isv -->',
        state: 'opened',
        source_branch: '42-login/plan',
        target_branch: 'main',
        sha: 'abc123',
      }]), { status: 200 })
    }
    if (String(url).endsWith('/merge_requests/11')) {
      return new Response(JSON.stringify({
        id: 71, iid: 11,
        description: '<!-- issue-flow:plan-artifact artifact=decision format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision.json.isv -->',
        labels: ['mr-by::plan'], state: 'opened', source_branch: '42-login/plan', target_branch: 'main', sha: 'abc123',
      }), { status: 200 })
    }
    if (String(url).endsWith('/merge_requests/11/changes')) {
      return new Response(JSON.stringify({ changes: [{
        old_path: '.issue-flow/issues/42-login/decision/data/decision.json.isv',
        new_path: '.issue-flow/issues/42-login/decision/data/decision.json.isv',
        diff: '@@ -1 +1 @@',
      }] }), { status: 200 })
    }
    if (String(url).includes('/repository/files/')) {
      const content = Buffer.from(JSON.stringify({ schemaVersion: 1, artifact: 'decision', meta: { title: 'Storage decision' }, decisions: [
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

test('Build MR Markdown accepts Preview comments without changing the Plan workflow', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url)
    requests.push({ url: requestUrl, options })
    if (requestUrl.endsWith('/merge_requests/20')) {
      return new Response(JSON.stringify({
        id: 80, iid: 20,
        description: '<!-- issue-flow:source-issue=42 -->',
        labels: ['mr-by::build'], state: 'opened', source_branch: '42-build', target_branch: 'main', sha: 'build-head',
      }), { status: 200 })
    }
    if (requestUrl.endsWith('/merge_requests/20/changes')) {
      return new Response(JSON.stringify({ changes: [{ old_path: 'docs/notes.md', new_path: 'docs/notes.md', diff: '@@ -1 +1 @@' }] }), { status: 200 })
    }
    if (requestUrl.endsWith('/merge_requests/20/notes') && options.method === 'POST') {
      return new Response(JSON.stringify({ id: 801 }), { status: 201 })
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${requestUrl}`)
  }
  const repo = { id: 'repo_123', gitServerId: 'gitlab-main', serverRepoId: '43326', fullName: 'acme/widget', defaultBranch: 'main' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', tokenAuth: 'private-token' }),
  }

  const result = await submitVisualReview({
    store, gitServerId: 'gitlab-main', projectId: '43326', issueNumber: 42, mergeRequestNumber: 20,
    userId: 'user-1', session: { userId: 'user-1', gitServerId: 'gitlab-main', token: 'user-token' },
    input: { items: [{ comment: '这里需要补充失败路径', targetId: 'docs/notes.md', sourceRefs: [{ type: 'file', path: 'docs/notes.md' }] }] },
  })

  assert.equal(result.status, 'commented')
  assert.equal(result.flow, undefined)
  assert.equal(requests.some((request) => request.url.includes('/issues/42')), false)
  const comment = requests.find((request) => request.url.endsWith('/merge_requests/20/notes'))
  assert.match(JSON.parse(comment.options.body).body, /## Preview Review/)
  assert.doesNotMatch(JSON.parse(comment.options.body).body, /请根据以上审阅意见更新当前/)
})

test('reviewable artifacts only include open Plan MRs', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  global.fetch = async () => new Response(JSON.stringify([
    {
      id: 71,
      iid: 11,
      description: '<!-- issue-flow:plan-artifact artifact=decision format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision.json.isv -->',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'abc123',
      updated_at: '2026-07-15T02:00:00.000Z',
    },
    {
      id: 72,
      iid: 12,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json issue=43 branch=43-export/plan commit=def456 path=.issue-flow/issues/43-export/plan/data/plan.json.isv -->',
      state: 'merged',
      source_branch: '43-export/plan',
      target_branch: 'main',
      sha: 'def456',
      updated_at: '2026-07-15T03:00:00.000Z',
    },
    {
      id: 74,
      iid: 14,
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json issue=42 branch=42-login/plan commit=plan456 path=.issue-flow/issues/42-login/plan/data/plan.json.isv -->',
      state: 'opened',
      source_branch: '42-login/plan',
      target_branch: 'main',
      sha: 'plan456',
      updated_at: '2026-07-15T05:00:00.000Z',
    },
    {
      id: 75,
      iid: 15,
      description: '<!-- issue-flow:source-issue=44 -->\n## Plan file\n\n.issue-flow/issues/44-export/plan/001-implementation.md',
      state: 'opened',
      source_branch: '44-export/plan',
      target_branch: 'main',
      sha: 'legacy456',
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
  }), [
    { issueNumber: 42, type: 'plan', format: 'json', mergeRequestNumber: 14 },
    { issueNumber: 44, type: 'plan', format: 'markdown', mergeRequestNumber: 15 },
  ])
})

test('Engine loads a legacy Markdown Plan directly from the selected GitLab MR', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url)
    requests.push(requestUrl)
    if (requestUrl.endsWith('/projects/12/merge_requests/1196')) {
      return new Response(JSON.stringify({
        id: 71,
        iid: 1196,
        description: '<!-- issue-flow:source-issue=1030 -->\n## Plan file\n\n.issue-flow/issues/1030-feat/plan/001-implementation.md',
        labels: ['mr-by::plan'],
        state: 'opened',
        source_branch: '1030-feat/plan',
        target_branch: 'develop',
        sha: 'current-head',
        updated_at: '2026-07-29T00:00:00.000Z',
      }), { status: 200 })
    }
    if (requestUrl.endsWith('/projects/12/merge_requests/1196/changes')) {
      return new Response(JSON.stringify({ changes: [{
        old_path: '.issue-flow/issues/1030-feat/plan/001-implementation.md',
        new_path: '.issue-flow/issues/1030-feat/plan/001-implementation.md',
        new_file: true,
        diff: '@@ -0,0 +1 @@\n+# Request lifecycle metrics',
      }] }), { status: 200 })
    }
    if (decodeURIComponent(requestUrl).includes('/repository/files/.issue-flow/issues/1030-feat/plan/001-implementation.md?ref=current-head')) {
      return new Response(JSON.stringify({
        content: Buffer.from('# Request lifecycle metrics\n\n## Validation\n\n- Verify metrics.').toString('base64'),
        encoding: 'base64',
      }), { status: 200 })
    }
    if (requestUrl.endsWith('/markdown') && options.method === 'POST') {
      return new Response(JSON.stringify({ html: '<h1>Request lifecycle metrics</h1><h2>Validation</h2><ul><li>Verify metrics.</li></ul>' }), { status: 200 })
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${requestUrl}`)
  }
  const repo = { id: 'repo_12', gitServerId: 'git-ke-com', serverRepoId: '12', fullName: 'ai-arch/bella-openapi', defaultBranch: 'develop' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://git.ke.com/api/v4', tokenAuth: 'private-token' }),
    listPullRequestsByIssue: async () => [],
  }

  const result = await getVisualArtifact({
    store,
    gitServerId: 'git-ke-com',
    projectId: '12',
    issueNumber: 1030,
    mergeRequestNumber: 1196,
    userId: 'user-1',
    session: { userId: 'user-1', gitServerId: 'git-ke-com', token: 'user-token' },
  })

  assert.equal(result.format, 'markdown')
  assert.equal(result.artifact.commitSha, 'current-head')
  assert.equal(result.artifact.entryPath, '.issue-flow/issues/1030-feat/plan/001-implementation.md')
  assert.equal(result.mergeRequest.number, 1196)
  assert.match(result.html, /data-ref="markdown\.plan"/)
  assert.equal(requests.some((request) => request.includes('merge_requests?')), false)
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

test('Engine loads a same-directory custom HTML Demo through the provider and renders it in a sandbox', async (t) => {
  const originalFetch = global.fetch
  t.after(() => { global.fetch = originalFetch })
  const requests = []
  const planData = {
    schemaVersion: 1,
    artifact: 'plan',
    meta: { title: 'Frontend Plan' },
    core: { outcome: 'Review the interaction before implementation' },
    sections: [
      { id: 'summary', type: 'summary', title: 'Summary' },
      { id: 'frontend-demo', type: 'custom-html', title: 'Checkout Demo', file: 'checkout-demo.html' },
      { id: 'validation', type: 'validation', title: 'Validation', items: [{ id: 'demo-check', title: 'Exercise the Demo' }] },
    ],
  }
  global.fetch = async (url) => {
    const requestUrl = String(url)
    requests.push(requestUrl)
    if (requestUrl.endsWith('/merge_requests/17')) {
      return new Response(JSON.stringify({
        id: 91, iid: 17,
        description: '<!-- issue-flow:plan-artifact artifact=plan format=json issue=42 branch=42-checkout/plan commit=abc123 path=.issue-flow/issues/42-checkout/plan/data/plan.json.isv -->',
        labels: ['mr-by::plan'], state: 'opened', source_branch: '42-checkout/plan', target_branch: 'main', sha: 'abc123',
      }), { status: 200 })
    }
    if (requestUrl.endsWith('/merge_requests/17/changes')) {
      return new Response(JSON.stringify({ changes: [{
        old_path: '.issue-flow/issues/42-checkout/plan/data/plan.json.isv',
        new_path: '.issue-flow/issues/42-checkout/plan/data/plan.json.isv',
        diff: '@@ -1 +1 @@',
      }] }), { status: 200 })
    }
    if (decodeURIComponent(requestUrl).includes('plan.json.isv')) {
      return new Response(JSON.stringify({ content: Buffer.from(JSON.stringify(planData)).toString('base64'), encoding: 'base64' }), { status: 200 })
    }
    if (decodeURIComponent(requestUrl).includes('checkout-demo.html')) {
      return new Response(JSON.stringify({ content: Buffer.from('<!doctype html><button id="demo-action">Pay now</button><script>document.body.dataset.ready="yes"</script>').toString('base64'), encoding: 'base64' }), { status: 200 })
    }
    throw new Error(`Unexpected request: ${requestUrl}`)
  }
  const repo = { id: 'repo_123', gitServerId: 'gitlab-main', serverRepoId: '43326', fullName: 'acme/widget', defaultBranch: 'main' }
  const store = {
    findRepositoryByProject: async () => repo,
    userCanAccessRepo: async () => true,
    getGitServer: async () => ({ type: 'gitlab', apiUrl: 'https://gitlab.test/api/v4', tokenAuth: 'private-token' }),
    listPullRequestsByIssue: async (input) => {
      assert.deepEqual(input, { gitServerId: 'gitlab-main', repositoryId: '43326', issueNumber: 42 })
      return [
        { id: 'pr-91', pullRequestId: '91', prNumber: 17, issueNumber: 42, kind: 'plan', state: 'open' },
        { id: 'pr-92', pullRequestId: '92', prNumber: 18, issueNumber: 42, kind: 'build', state: 'merged' },
      ]
    },
  }

  const result = await getVisualArtifact({
    store,
    gitServerId: 'gitlab-main',
    projectId: '43326',
    issueNumber: 42,
    mergeRequestNumber: 17,
    artifactPath: '.issue-flow/issues/42-checkout/plan/data/plan.json.isv',
    userId: 'user-1',
    session: { userId: 'user-1', gitServerId: 'gitlab-main', token: 'user-token' },
  })

  assert.equal(result.artifact.type, 'plan')
  assert.equal(result.artifact.previewer, 'issue-flow-visual')
  assert.equal(requests.some((request) => request.includes('/merge_requests?')), false)
  assert.equal(requests.some((request) => decodeURIComponent(request).includes('/plan/data/checkout-demo.html?ref=abc123')), true)
  assert.match(result.html, /class="vp-demo-frame"/)
  assert.match(result.html, /sandbox="allow-scripts allow-forms allow-modals"/)
  assert.match(result.html, /&lt;button id=&quot;demo-action&quot;&gt;Pay now&lt;\/button&gt;/)
  assert.match(result.html, /data-ref="sections\.frontend-demo"/)
  assert.doesNotMatch(result.html, /allow-same-origin/)
  assert.deepEqual(result.associatedMergeRequests, [
    { number: 17, title: 'Plan MR #17', state: 'open', labels: ['mr-by::plan'] },
    { number: 18, title: 'Build MR #18', state: 'merged', labels: ['mr-by::build'] },
  ])
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
    { type: 'plan', workflow: 'plan' },
    {
      id: 'visual_review_1',
      payload: {
        items: [{
          comment: '确认一下还会有其他状态吗？',
          targetId: '.issue-flow/issues/15-issue/plan/data/plan.json.isv',
          sourceRefs: [{ type: 'plan', path: '.issue-flow/issues/15-issue/plan/data/plan.json.isv' }],
          visualTarget: {
            path: '.issue-flow/issues/15-issue/plan/data/plan.json.isv',
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
  assert.match(comment, /产物：`.issue-flow\/issues\/15-issue\/plan\/data\/plan.json.isv`/)
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
    { type: 'decision', workflow: 'plan' },
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
      description: '<!-- issue-flow:plan-artifact artifact=plan format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan.json.isv -->',
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

test('Markdown plans expose stable review anchors for every heading section', () => {
  const structured = structureMarkdownSections([
    '<h1>Automation optimization</h1>',
    '<p>Summary</p>',
    '<h2>Task Facet</h2>',
    '<p>Evidence</p>',
    '<h2>Task Facet</h2>',
    '<p>More evidence</p>',
    '<h3>验证 &amp; 回归</h3>',
  ].join(''), { type: 'plan' })

  assert.equal(structured.sectionCount, 4)
  assert.match(structured.body, /data-comment-label="Automation optimization" data-section-level="1" data-ref="markdown\.plan\.sections\.automation-optimization"/)
  assert.match(structured.body, /data-comment-label="Task Facet" data-section-level="2" data-ref="markdown\.plan\.sections\.task-facet"/)
  assert.match(structured.body, /data-ref="markdown\.plan\.sections\.task-facet-2"/)
  assert.match(structured.body, /data-comment-label="验证 &amp; 回归" data-section-level="3" data-ref="markdown\.plan\.sections\.验证-回归"/)
  assert.equal((structured.body.match(/data-comment-scope="section"/g) || []).length, 4)
})

test('Markdown document falls back to one review scope when it has no headings', () => {
  const html = markdownDocument('<p>Plan without headings.</p>', { type: 'plan' })
  assert.match(html, /<article data-comment-scope="section" data-comment-label="Markdown Plan" data-ref="markdown\.plan">/)
  assert.doesNotMatch(html, /agentrix-overall-feedback/)
  assert.equal((html.match(/data-comment-scope="section"/g) || []).length, 1)
})

test('visual review comment preserves the selected Markdown quote', () => {
  const comment = buildReviewComment(
    { type: 'plan', data: { format: 'markdown' } },
    { payload: { items: [{
      comment: '这里需要补充验收标准',
      targetId: 'plan.md',
      sourceRefs: [{ type: 'plan', path: 'plan.md' }],
      visualTarget: {
        path: 'plan.md',
        anchorRef: 'markdown.plan.sections.validation',
        selectionText: '验证方案需要覆盖失败路径',
        element: { html: '<p>验证方案需要覆盖失败路径与重试。</p>' },
      },
    }] } },
    'changes-requested',
  )

  assert.match(comment, /引用：验证方案需要覆盖失败路径/)
  assert.doesNotMatch(comment, /页面内容：验证方案需要覆盖失败路径与重试/)
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
