const assert = require('node:assert/strict');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost/test';
require('tsx/cjs');
const { repoWithWebhook } = require('../src/core/common.ts');
const { checkWebhook, setGitlabProjectInstallWebhook } = require('../src/core/installation/gitlab/webhook.ts');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

function fixture() {
  const calls = [];
  const repo = { id: 'repo-test', provider: 'gitlab', gitServerId: 'gitlab-main', projectId: '42', webhook: { hookId: '9' }, settings: {} };
  const store = {
    getGitServer: async () => ({ id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example', apiUrl: 'https://gitlab.example/api/v4', webhook: { secret: 'test-secret' } }),
    findRepositoryByProject: async () => repo,
    getRepository: async () => repo,
    updateRepositorySettingsCache: async (id, patch) => { Object.assign(repo.settings, patch); repo.webhook = patch.webhook || repo.webhook; return repo; },
    updateRepositoryWebhookCache: async (id, patch) => { Object.assign(repo.webhook, patch); return repo; },
  };
  let hook = { id: 9, url: 'http://127.0.0.1:8788/webhooks/gitlab/repo-test', push_events: true };
  global.fetch = async (url, input) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: input.method, body: input.body ? JSON.parse(input.body) : undefined });
    if (path === '/api/v4/user') return Response.json({ id: 1, username: 'owner' });
    if (path === '/api/v4/projects/42') return Response.json({ id: 42, path_with_namespace: 'owner/repo', default_branch: 'main', permissions: { project_access: { access_level: 40 } } });
    if (path === '/api/v4/projects/42/hooks') return Response.json([hook]);
    if (path === '/api/v4/projects/42/hooks/9' && input.method === 'PUT') { hook = { ...hook, ...JSON.parse(input.body) }; return Response.json(hook); }
    assert.fail(`Unexpected request ${input.method} ${path}`);
  };
  const options = { store, basePublicUrl: 'http://127.0.0.1:8788', env: { ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://public.example/' }, input: { gitServerId: 'gitlab-main', token: 'test-token', projectId: '42' } };
  const check = { ...options, existing: repo, apiInput: { apiUrl: 'https://gitlab.example/api/v4', token: 'test-token', projectIdOrPath: '42' } };
  return { repo, calls, options, check };
}

test('GitLab and GitHub repository URLs share the explicit webhook origin', () => {
  const env = { ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://public.example/prefix/' };
  assert.equal(repoWithWebhook('http://localhost:8788', { id: 'repo/test', provider: 'gitlab' }, env).webhookUrl, 'https://public.example/prefix/webhooks/gitlab/repo%2Ftest');
  assert.equal(repoWithWebhook('http://localhost:8788', { id: 'repo/test', provider: 'github' }, env).webhookUrl, 'https://public.example/prefix/webhooks/github');
});

test('changing the webhook origin updates the existing GitLab hook instead of creating a duplicate', async () => {
  const { options, check, repo, calls } = fixture();
  const stale = await checkWebhook(check);
  assert.equal(stale.status, 'needs_action');
  assert.match(stale.detail, /https:\/\/public.example\/webhooks\/gitlab\/repo-test/);
  assert.equal(repo.webhook.hookId, '9');
  const configured = await setGitlabProjectInstallWebhook(options);
  assert.equal(configured.status, 200);
  assert.equal(configured.body.repository.webhookUrl, 'https://public.example/webhooks/gitlab/repo-test');
  const write = calls.find((call) => call.method === 'PUT');
  assert.equal(write.body.url, 'https://public.example/webhooks/gitlab/repo-test');
  assert.equal(write.body.push_events, true);
  assert.equal(calls.some((call) => call.method === 'POST'), false);
  assert.equal((await checkWebhook(check)).status, 'passed');
});

test('GitLab refuses to configure a loopback webhook and reports the public URL setting', async () => {
  const { options, check, calls } = fixture();
  const result = await checkWebhook({ ...check, env: {} });
  assert.equal(result.status, 'needs_action');
  assert.match(result.detail, /ISSUE_FLOW_WEBHOOK_BASE_URL/);
  const configured = await setGitlabProjectInstallWebhook({ ...options, env: {} });
  assert.equal(configured.status, 400);
  assert.equal(configured.body.error, 'webhook_public_url_required');
  assert.equal(calls.some((call) => call.method === 'PUT' || call.method === 'POST'), false);
});
