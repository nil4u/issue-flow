const assert = require('node:assert/strict');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost/test';
process.env.ISSUE_FLOW_BASE_URL ||= 'https://issue-flow.test';
require('tsx/cjs');
const { actionExecutionForProject } = require('../src/core/action-execution.ts');
const domain = require('issue-flow/domain');
const originalFetch = global.fetch;
test.after(() => { global.fetch = originalFetch; });

function fixture(options = {}) {
  const config = { extra: { untouched: true }, agentrix: { runnerId: 'runner', actions: { defaults: { agent: 'codex' }, build: { model: 'old' }, future: { model: 'future' } } } };
  let repository = { id: 'repo', settings: { actionExecution: options.cached } };
  const calls = [];
  global.fetch = async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    calls.push({ url: String(url), method: init.method, body });
    if (String(url).includes('/repository/files/')) {
      if (options.forbidden) return new Response('{}', { status: 403 });
      if (options.networkError) throw new Error('network unavailable');
      if (options.missing) return new Response('{}', { status: 404 });
      return Response.json({ content: Buffer.from(options.content ?? JSON.stringify(config)).toString('base64'), encoding: 'base64', last_commit_id: 'revision' });
    }
    if (String(url).endsWith('/repository/commits')) return options.race ? new Response('{}', { status: 400 }) : Response.json({ id: 'commit' });
    if (String(url).endsWith('/merge_requests')) return Response.json({ iid: 12, id: 99, web_url: 'https://gitlab.test/mr/12' });
    if (String(url).includes('/merge_requests/')) {
      if (options.mrFailure) throw new Error('network unavailable');
      return Response.json({ iid: 12, state: options.mrState || 'opened' });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const store = {
    getRepository: async () => repository,
    updateRepositorySettingsCache: async (id, patch) => { repository = { ...repository, settings: { ...repository.settings, ...patch } }; },
  };
  const context = { project: { id: 'project', defaultBranch: 'develop' }, existing: repository, apiInput: { apiUrl: 'https://gitlab.test/api/v4', token: 'token', projectIdOrPath: 'project' } };
  const actions = domain.actionExecutionSnapshot(config).explicit;
  return { store, context, config, calls, actions, input: { baseRevision: 'revision', actions } };
}

test('reads effective configuration and returns structured invalid states', async () => {
  for (const [options, state] of [[{}, 'ready'], [{ missing: true }, 'missing'], [{ content: '{' }, 'invalid_json'], [{ content: '{"agentrix":[]}' }, 'invalid_config']]) {
    const result = await actionExecutionForProject(fixture(options));
    assert.equal(result.status, 200);
    assert.equal(result.body.actionExecution.state, state);
  }
  const failed = await actionExecutionForProject(fixture({ networkError: true }));
  assert.equal(failed.status, 502);
  const forbidden = await actionExecutionForProject(fixture({ forbidden: true }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error, 'action_execution_permission_denied');
});

test('creates a configuration-only MR preserving effective values until merge', async () => {
  const setup = fixture();
  setup.actions.build = { model: ' new ', reasoningEffort: 'high' };
  const result = await actionExecutionForProject({ ...setup, save: true });
  assert.equal(result.status, 202);
  const commit = setup.calls.find((call) => call.url.endsWith('/repository/commits')).body;
  assert.equal(commit.start_branch, 'develop');
  assert.match(commit.branch, /^issue-flow\/action-execution-/);
  assert.equal(commit.actions.length, 1);
  assert.equal(commit.actions[0].file_path, '.issue-flow/config.json');
  assert.equal(commit.actions[0].last_commit_id, 'revision');
  const next = JSON.parse(commit.actions[0].content);
  assert.equal(next.agentrix.actions.build.model, 'new');
  assert.deepEqual(next.extra, setup.config.extra);
  assert.deepEqual(next.agentrix.actions.future, setup.config.agentrix.actions.future);
  assert.equal(result.body.actionExecution.explicit.build.model, 'old');
  assert.equal(result.body.pendingMergeRequest.iid, 12);
});

test('skips no-op and rejects stale revisions, invalid input and commit races', async () => {
  const noop = fixture();
  assert.equal((await actionExecutionForProject({ ...noop, save: true })).body.skipped, true);
  assert.equal(noop.calls.some((call) => call.method === 'POST'), false);
  const stale = fixture();
  stale.input.baseRevision = 'stale';
  assert.equal((await actionExecutionForProject({ ...stale, save: true })).status, 409);
  const invalid = fixture();
  invalid.actions.build.reasoningEffort = 'ultra';
  assert.equal((await actionExecutionForProject({ ...invalid, save: true })).status, 400);
  const race = fixture({ race: true });
  race.actions.build.model = 'new';
  assert.equal((await actionExecutionForProject({ ...race, save: true })).status, 409);
  assert.equal(race.calls.some((call) => call.url.endsWith('/merge_requests')), false);
});

test('pending MR blocks duplicates; merged and closed MR clear cache; failed refresh retains pending', async () => {
  const cached = { pendingMergeRequest: { iid: 12, webUrl: 'https://gitlab.test/mr/12', sourceBranch: 'issue-flow/action-execution-test' } };
  for (const state of ['merged', 'closed']) {
    const result = await actionExecutionForProject(fixture({ cached, mrState: state }));
    assert.equal(result.body.actionExecution.pendingMergeRequest, undefined);
    assert.equal(result.body.actionExecution.explicit.build.model, 'old');
  }
  for (const options of [{ cached }, { cached, mrFailure: true }]) {
    const setup = fixture(options);
    const result = await actionExecutionForProject({ ...setup, save: true });
    assert.equal(result.status, 409);
    assert.equal(result.body.actionExecution.pendingMergeRequest.iid, 12);
    assert.equal(setup.calls.some((call) => call.method === 'POST'), false);
    if (options.mrFailure) assert.equal(result.body.actionExecution.refreshError, 'pending_merge_request_refresh_failed');
  }
});

test('invalid source files never produce a commit or MR', async () => {
  for (const options of [{ missing: true }, { content: '{' }, { content: '{"agentrix":{"actions":[]}}' }]) {
    const setup = fixture(options);
    const result = await actionExecutionForProject({ ...setup, save: true });
    assert.equal(result.status, 422);
    assert.equal(setup.calls.some((call) => call.method === 'POST'), false);
  }
});

test('concurrent operations cannot overwrite a newly created pending MR', async () => {
  const setup = fixture();
  const realRead = setup.store.getRepository;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setup.store.getRepository = async (...args) => { await gate; return realRead(...args); };
  setup.actions.build.model = 'new';
  const submission = actionExecutionForProject({ ...setup, save: true });
  const concurrentRead = await actionExecutionForProject(setup);
  assert.equal(concurrentRead.status, 409);
  const concurrentSave = await actionExecutionForProject({ ...setup, save: true });
  assert.equal(concurrentSave.status, 409);
  release();
  assert.equal((await submission).status, 202);
  assert.equal((await setup.store.getRepository()).settings.actionExecution.pendingMergeRequest.iid, 12);
});

test('HTTP routes require authentication and management access only for submission', async () => {
  const fastify = require('fastify');
  const { gitlabRoutes } = require('../src/routes/gitlab.ts');
  const setup = fixture();
  const fileFetch = global.fetch;
  let accessLevel = 30;
  global.fetch = async (url, init) => {
    if (String(url).endsWith('/user')) return Response.json({ id: 1, username: 'developer' });
    if (String(url).endsWith('/projects/project')) return Response.json({ id: 'project', default_branch: 'develop', path_with_namespace: 'group/project', permissions: { project_access: { access_level: accessLevel } } });
    if (String(url).includes('/members/')) return Response.json({ access_level: accessLevel });
    return fileFetch(url, init);
  };
  setup.store.getGitServer = async () => ({ id: 'server', type: 'gitlab', baseUrl: 'https://gitlab.test', apiUrl: 'https://gitlab.test/api/v4' });
  setup.store.findRepositoryByProject = async () => setup.context.existing;
  const app = fastify({ logger: false });
  app.decorate('issueFlowStore', setup.store);
  app.addHook('onRequest', async (request) => { request.cookies = {}; });
  await app.register(gitlabRoutes);
  try {
    const request = (action, token = 'token') => app.inject({ method: 'POST', url: `/api/gitlab/action-execution/${action}`, payload: { gitServerId: 'server', projectId: 'project', token, ...setup.input } });
    assert.equal((await request('read', '')).statusCode, 401);
    const read = await request('read');
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().access.canManage, false);
    assert.equal((await request('submit')).statusCode, 403);
    assert.equal(setup.calls.some((call) => call.method === 'POST'), false);
    accessLevel = 40;
    setup.actions.build.model = 'new';
    const submitted = await request('submit');
    assert.equal(submitted.statusCode, 202);
    assert.equal(submitted.json().pendingMergeRequest.iid, 12);
  } finally {
    await app.close();
  }
});

test('settings storage isolates action execution preferences from plugins and features', () => {
  const { withRepositoryStore } = require('../src/core/store/repositories.ts');
  const Store = withRepositoryStore(class {});
  const store = new Store();
  const snapshot = { state: 'ready', pendingMergeRequest: { iid: 12 } };
  const settings = store.repoSettingsFromItems([
    { kind: 'preference', key: 'action-execution', data: snapshot, checkedAt: new Date('2026-10-08T00:00:00Z') },
    { kind: 'plugin', key: 'issue-flow', data: { key: 'issue-flow', installed: true } },
    { kind: 'feature', key: 'visual-plan', data: { enabled: true } },
  ]);
  assert.equal(settings.actionExecution.pendingMergeRequest.iid, 12);
  assert.equal(settings.plugins.items.length, 1);
  assert.equal(settings.issueDefaults.visualPlanEnabled, true);
});

test('configuration webhook invalidates only the precisely matching pending MR', async () => {
  const { createGitLabWebhookBridge } = require('../src/core/gitlab-webhook.ts');
  for (const [state, iid, sourceBranch, matches] of [
    ['merged', 12, 'issue-flow/action-execution-test', true],
    ['closed', 12, 'issue-flow/action-execution-test', true],
    ['merged', 13, 'issue-flow/action-execution-test', false],
    ['merged', 12, 'issue-flow/install-other', false],
  ]) {
    const setup = fixture({ cached: { state: 'ready', pendingMergeRequest: { iid: 12, sourceBranch: 'issue-flow/action-execution-test' } } });
    const bridge = createGitLabWebhookBridge({ store: setup.store, repo: { id: 'repo' }, secrets: {} });
    const target = bridge.targets.find((item) => item.name === 'issue-flow-business');
    await target.deliverDelivery({ deliveryId: 'delivery', events: [{ raw: { body: { object_kind: 'merge_request', object_attributes: { state, iid, source_branch: sourceBranch } } } }] });
    const cached = (await setup.store.getRepository('repo')).settings.actionExecution;
    assert.equal(cached.state, matches ? 'stale' : 'ready');
    assert.equal(!!cached.pendingMergeRequest, !matches);
  }
});
