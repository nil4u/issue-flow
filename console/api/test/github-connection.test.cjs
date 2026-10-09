const assert = require('node:assert/strict');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.ISSUE_FLOW_BASE_URL ||= 'https://flow.example';
require('tsx/cjs');
const { server, remote, installation } = require('./helpers/github.cjs');
const { discoverGithubRepositories } = require('../src/core/github/api.ts');
const { syncGithubConnection } = require('../src/core/github/projects.ts');
const { githubAuthRoutes } = require('../src/routes/auth/github.ts');
const { parseCookies } = require('../src/utils/http.ts');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

function mockGithub(state) {
  global.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/access_token')) return Response.json({ access_token: 'user-token', refresh_token: 'refresh', expires_in: 28800 });
    if (path === '/user') return Response.json({ id: 1, login: 'alex' });
    if (path === '/user/installations') {
      if (state.failed) return new Response('{}', { status: 503 });
      return Response.json({ installations: state.installations });
    }
    if (path === '/user/installations/7/repositories') return Response.json({ repositories: state.repositories });
    assert.fail(`Unexpected request ${path}`);
  };
}

async function callbackFixture(t, state) {
  mockGithub(state);
  let credential;
  const synced = [];
  const app = require('fastify')();
  app.decorate('issueFlowStore', {
    getGitServer: async () => server,
    resolveCryptoKey: () => Buffer.alloc(32, 4),
    getConsoleSessionByToken: async () => ({ userId: 'user' }),
    resolveUserForGitAccount: async ({ account }) => ({ user: { id: 'user' }, account }),
    createSession: async (input) => { credential = { id: 'credential', ...input }; return credential; },
    getGitCredential: async () => credential,
    publicGitServer: () => ({ id: server.id, type: 'github' }),
    syncRepositories: async (input) => { synced.push(input.projects); return []; },
    createConsoleSession: async () => ({ token: 'console-token' }),
  });
  app.addHook('onRequest', async (request) => { request.cookies = parseCookies(request.headers.cookie || ''); });
  await app.register(githubAuthRoutes);
  t.after(() => app.close());
  const start = await app.inject({ method: 'POST', url: '/api/auth/github/authorize', payload: { gitServerId: server.id, returnTo: '/settings/account' } });
  const firstUrl = new URL(start.json().authorizeUrl);
  const response = await app.inject({ url: `/api/auth/github/callback?state=${firstUrl.searchParams.get('state')}&code=login-code`, headers: { cookie: start.headers['set-cookie'].split(';')[0] } });
  return { app, response, synced };
}

function returnedCookies(response) {
  return [response.headers['set-cookie']].flat().map((cookie) => cookie.split(';')[0]).join('; ');
}

test('discovery distinguishes missing installation, no visible repositories, suspended access and connected', async () => {
  for (const [installations, repositories, status] of [
    [[], [], 'needs_authorization'],
    [[installation], [], 'no_repositories'],
    [[{ ...installation, suspended_at: '2026-01-01' }], [], 'suspended'],
    [[installation], [remote], 'connected'],
  ]) {
    mockGithub({ installations, repositories });
    const result = await discoverGithubRepositories(server, 'user-token');
    assert.equal(result.connection.status, status);
    assert.equal(result.connection.repositoryCount, repositories.length);
  }
});

test('failed GitHub lookup preserves local grants instead of reporting zero authorized repositories', async () => {
  mockGithub({ failed: true });
  await assert.rejects(syncGithubConnection({ syncRepositories: () => assert.fail('do not clear grants after a failed lookup') }, server, 'token', 'user'), (error) => error.status === 503);
});

test('first login continues to App authorization, then syncs repositories and returns to the initiating page', async (t) => {
  const state = { installations: [], repositories: [] };
  const { app, response, synced } = await callbackFixture(t, state);
  assert.equal(response.statusCode, 302);
  const authorize = new URL(response.headers.location);
  assert.equal(authorize.pathname, '/apps/issue-flow-test/installations/new');
  assert.ok(returnedCookies(response).includes('console-token'));
  state.installations = [installation];
  state.repositories = [remote];
  const completed = await app.inject({ url: `/api/auth/github/callback?state=${authorize.searchParams.get('state')}&installation_id=7&code=install-code`, headers: { cookie: returnedCookies(response) } });
  const target = new URL(completed.headers.location);
  assert.equal(target.pathname, '/settings/account');
  assert.equal(target.searchParams.get('githubConnection'), 'connected');
  assert.equal(synced.at(-1)[0].fullName, 'owner/repo');
});

test('existing installations skip authorization and sync failures return to Console with retry state', async (t) => {
  for (const [state, expected] of [
    [{ installations: [installation], repositories: [remote] }, 'connected'],
    [{ installations: [], repositories: [], failed: true }, 'sync_failed'],
  ]) {
    const { response } = await callbackFixture(t, state);
    const target = new URL(response.headers.location);
    assert.equal(target.pathname, '/settings/account');
    assert.equal(target.searchParams.get('githubConnection'), expected);
  }
});

test('installation return without a new OAuth code uses the current session and never loops back to installation', async (t) => {
  const state = { installations: [], repositories: [] };
  const { app, response } = await callbackFixture(t, state);
  const authorize = new URL(response.headers.location);
  const completed = await app.inject({ url: `/api/auth/github/callback?state=${authorize.searchParams.get('state')}&installation_id=7`, headers: { cookie: returnedCookies(response) } });
  assert.equal(completed.statusCode, 302);
  const target = new URL(completed.headers.location);
  assert.equal(target.pathname, '/settings/account');
  assert.equal(target.searchParams.get('githubConnection'), 'needs_authorization');
});
