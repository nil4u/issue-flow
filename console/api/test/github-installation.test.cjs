const assert = require('node:assert/strict');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
require('tsx/cjs');
const sodium = require('libsodium-wrappers');
const domain = require('issue-flow/domain');
const { fixture, remote } = require('./helpers/github.cjs');
const { githubInstaller } = require('../src/core/installation/github/adapter.ts');
const { installPlan, checkProjectInstall, configureInstallStep } = require('../src/core/installation/workflow.ts');
const { configureGithubActionExecution } = require('../src/core/github/action-execution.ts');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

test('GitHub installation checks App access and Actions without a bridge or GitLab runner', async () => {
  const setup = fixture();
  setup.mockFetch(({ path }) => {
    if (path === '/app/hook/config') return Response.json({ url: 'https://flow.example/webhooks/github' });
    if (path.endsWith('/actions/workflows')) return Response.json({ workflows: [] });
  });
  assert.ok(!installPlan(githubInstaller).steps.some((step) => step.id === 'runners'));
  const result = await checkProjectInstall({ ...setup.options, input: { ...setup.options.input, checkTypes: ['permissions', 'webhook', 'actions'] } }, githubInstaller);
  assert.equal(result.body.installable, true);
  assert.deepEqual(result.body.steps.map((step) => step.status), ['passed', 'passed', 'passed']);
  assert.ok(!setup.calls.some((call) => /pipelines|triggers/.test(call.path)));
});

test('repository read permission cannot configure installations', async () => {
  const setup = fixture();
  setup.mockFetch(({ path }) => path === '/repositories/123' ? Response.json({ ...remote, permissions: { pull: true } }) : undefined);
  const result = await checkProjectInstall(setup.options, githubInstaller);
  assert.equal(result.status, 403);
  await assert.rejects(configureInstallStep({ ...setup.options, input: { ...setup.options.input, checkType: 'variables' } }, githubInstaller), (error) => error.status === 403);
  assert.ok(!setup.calls.some((call) => call.method !== 'GET'));
});

test('Actions secrets use GitHub sealed-box encryption and never enter the settings cache', async () => {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  const setup = fixture();
  let encrypted;
  setup.mockFetch(({ path, method, body }) => {
    if (path === '/v1/auth/me') return Response.json({ user: { id: 'user', username: 'alex', email: 'alex@example.com', role: 'user', createdAt: '2026-01-01T00:00:00Z', avatar: 'https://example.com/avatar.png', encryptedSecret: '', secretSalt: '', stripeCustomerId: '' } });
    if (path.endsWith('/actions/variables')) return Response.json({ variables: [] });
    if (path.endsWith('/actions/secrets')) return Response.json({ secrets: [] });
    if (path.endsWith('/secrets/public-key')) return Response.json({ key_id: 'key-id', key: sodium.to_base64(key.publicKey, sodium.base64_variants.ORIGINAL) });
    if (path.endsWith('/secrets/AGENTRIX_API_KEY') && method === 'PUT') { encrypted = body; return new Response(null, { status: 204 }); }
  });
  const result = await configureInstallStep({ ...setup.options, input: { ...setup.options.input, checkType: 'variables', key: 'AGENTRIX_API_KEY', value: 'agentrix-test-secret' } }, githubInstaller);
  assert.ok(encrypted, result.body.step.variables.find((row) => row.key === 'AGENTRIX_API_KEY').detail);
  const plain = sodium.crypto_box_seal_open(sodium.from_base64(encrypted.encrypted_value, sodium.base64_variants.ORIGINAL), key.publicKey, key.privateKey);
  assert.equal(sodium.to_string(plain), 'agentrix-test-secret');
  assert.equal(encrypted.key_id, 'key-id');
  assert.ok(!JSON.stringify(result).includes('agentrix-test-secret'));
  assert.ok(!JSON.stringify(setup.repository).includes('agentrix-test-secret'));
});

test('GitHub labels are synchronized using the shared Issue Flow domain', async () => {
  const setup = fixture();
  const labels = [];
  setup.mockFetch(({ path, method, body }) => {
    if (path.endsWith('/labels') && method === 'GET') return Response.json(labels);
    if (path.endsWith('/labels') && method === 'POST') { labels.push(body); return Response.json(body); }
  });
  const result = await configureInstallStep({ ...setup.options, input: { ...setup.options.input, checkType: 'labels' } }, githubInstaller);
  assert.equal(result.body.step.status, 'passed');
  assert.equal(labels.length, domain.labelsForScope('all').length);
  assert.ok(labels.every((label) => !label.color.startsWith('#')));
});

test('GitHub execution configuration creates a PR and preserves the effective configuration until merge', async () => {
  const setup = fixture();
  const config = { untouched: true, agentrix: { actions: { build: { model: 'old' } } } };
  setup.mockFetch(({ path, method }) => {
    if (path.includes('/contents/') && method === 'GET') return Response.json({ sha: 'blob', encoding: 'base64', content: Buffer.from(JSON.stringify(config)).toString('base64') });
    if (path.includes('/git/ref/heads/')) return Response.json({ object: { sha: 'head' } });
    if (path.endsWith('/git/refs')) return Response.json({ ref: 'refs/heads/new' });
    if (path.includes('/contents/') && method === 'PUT') return Response.json({ commit: { sha: 'commit' } });
    if (path.endsWith('/pulls')) return Response.json({ id: 12, number: 3, html_url: 'https://github.com/owner/repo/pull/3' });
  });
  const actions = domain.actionExecutionSnapshot(config).explicit;
  actions.build.model = 'new';
  const result = await configureGithubActionExecution({ ...setup.options, save: true, input: { ...setup.options.input, baseRevision: 'blob', actions } });
  assert.equal(result.status, 202);
  assert.equal(result.body.pendingMergeRequest.iid, 3);
  assert.equal(result.body.actionExecution.explicit.build.model, 'old');
  const changed = JSON.parse(Buffer.from(setup.calls.find((call) => call.method === 'PUT').body.content, 'base64'));
  assert.equal(changed.untouched, true);
  assert.equal(changed.agentrix.actions.build.model, 'new');
});

test('App permission checks recognize GitHub actions_variables and reject read-only variable access', async () => {
  const { installation } = require('./helpers/github.cjs');
  const setup = fixture();
  const permissions = { ...installation.permissions, actions_variables: 'write' };
  delete permissions.variables;
  setup.mockFetch(({ path }) => path === '/repos/owner/repo/installation' ? Response.json({ ...installation, permissions }) : undefined);
  const options = { ...setup.options, input: { ...setup.options.input, checkTypes: ['permissions'] } };
  const allowed = await checkProjectInstall(options, githubInstaller);
  assert.equal(allowed.body.steps[0].status, 'passed');
  assert.deepEqual(allowed.body.steps[0].missing, []);
  permissions.actions_variables = 'read';
  const denied = await checkProjectInstall(options, githubInstaller);
  assert.equal(denied.body.steps[0].status, 'blocked');
  assert.deepEqual(denied.body.steps[0].missing, ['actions_variables']);
  assert.match(denied.body.steps[0].detail, /Variables.*Read and write/);
});

test('webhook checks use a separately configured public address while OAuth stays local', async () => {
  const setup = fixture();
  setup.mockFetch(({ path }) => path === '/app/hook/config' ? Response.json({ url: 'https://tunnel.example/webhooks/github' }) : undefined);
  const options = { ...setup.options, basePublicUrl: 'http://127.0.0.1:8788', env: { ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://tunnel.example/' }, input: { ...setup.options.input, checkTypes: ['webhook'] } };
  const result = await checkProjectInstall(options, githubInstaller);
  assert.equal(result.body.steps[0].status, 'passed');
  assert.equal(setup.repository.settings.webhook.url, 'https://tunnel.example/webhooks/github');
  const { createGithubOAuthAuthorize } = require('../src/core/github/auth.ts');
  const auth = await createGithubOAuthAuthorize(options);
  assert.equal(new URL(auth.authorizeUrl).searchParams.get('redirect_uri'), 'http://127.0.0.1:8788/api/auth/github/callback');
});

test('loopback webhook defaults ask for a public service address rather than registering localhost at GitHub', async () => {
  const setup = fixture();
  setup.mockFetch(({ path }) => path === '/app/hook/config' ? Response.json({ url: 'https://tunnel.example/webhooks/github' }) : undefined);
  const result = await checkProjectInstall({ ...setup.options, basePublicUrl: 'http://127.0.0.1:8788', env: {}, input: { ...setup.options.input, checkTypes: ['webhook'] } }, githubInstaller);
  assert.equal(result.body.steps[0].status, 'needs_action');
  assert.match(result.body.steps[0].detail, /ISSUE_FLOW_WEBHOOK_BASE_URL/);
  assert.doesNotMatch(result.body.steps[0].detail, /设置 URL 为 http:\/\/127/);
});
