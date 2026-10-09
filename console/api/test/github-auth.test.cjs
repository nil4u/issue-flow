const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.ISSUE_FLOW_BASE_URL ||= 'https://flow.example';
require('tsx/cjs');
const { server, remote, installation, pem, publicKey } = require('./helpers/github.cjs');
const { appJwt, listGithubProjects, githubOAuthToken } = require('../src/core/github/api.ts');
const { createGithubOAuthAuthorize, finishGithubOAuth } = require('../src/core/github/auth.ts');
const { resolveFreshSession } = require('../src/core/session.ts');
const { StoreBase } = require('../src/core/store/base.ts');
const { withIdentityStore } = require('../src/core/store/identity.ts');
const { gitServerInputFromSetup, gitServerMissingFields } = require('../src/core/setup.ts');
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

test('App JWT is signed by the private key and has a bounded lifetime', () => {
  const jwt = appJwt(server, 1800000000000);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.iss, '42');
  assert.equal(claims.exp - claims.iat, 600);
});

test('GitHub App configuration uses provider URLs, encrypts the PEM, and preserves it on update', async () => {
  let row;
  const Store = withIdentityStore(StoreBase);
  const store = new Store({ key: 'test-key', db: { gitServer: {
    findUnique: async () => row,
    upsert: async ({ create, update }) => { row = row ? { ...row, ...update } : create; },
  } } });
  const input = gitServerInputFromSetup({ type: 'github', oauth: server.oauth, githubApp: server.githubApp, webhook: server.webhook });
  assert.equal(input.apiUrl, 'https://api.github.com');
  assert.deepEqual(gitServerMissingFields(input), []);
  const result = await store.ensureGitServer(input);
  assert.equal(result.githubApp.privateKey, pem);
  assert.ok(row.githubPrivateKey.startsWith('v1:'));
  assert.ok(!JSON.stringify(row).includes('BEGIN PRIVATE KEY'));
  assert.ok(!JSON.stringify(store.publicGitServer(result)).includes('BEGIN PRIVATE KEY'));
  await store.ensureGitServer({ ...input, githubApp: { appId: '42', slug: 'renamed-app' } });
  assert.equal((await store.getGitServer(input.id, { includeSecret: true })).githubApp.privateKey, pem);
  assert.equal(gitServerInputFromSetup({ type: 'github', baseUrl: 'https://git.example.com' }).apiUrl, 'https://git.example.com/api/v3');
});

test('repository discovery uses only user-visible App installations and handles pagination', async () => {
  let requests = 0;
  global.fetch = async (url, init) => {
    assert.equal(init.headers.Authorization, 'Bearer user-token');
    requests++;
    if (String(url).includes('/user/installations?')) return Response.json({ installations: [installation, { ...installation, id: 8, app_id: 99 }] });
    const page = new URL(url).searchParams.get('page');
    return Response.json({ repositories: page === '1' ? Array.from({ length: 100 }, (_, i) => ({ ...remote, id: i + 1 })) : [{ ...remote, id: 101 }] });
  };
  const projects = await listGithubProjects(server, 'user-token');
  assert.equal(projects.length, 101);
  assert.equal(requests, 3);
  assert.equal(projects[0].installationId, '7');
});

test('OAuth rejects tampered state and stores the GitHub identity and expiring credentials', async () => {
  let saved;
  const store = {
    getGitServer: async () => server, resolveCryptoKey: () => Buffer.alloc(32, 2),
    resolveUserForGitAccount: async ({ account }) => ({ user: { id: 'user' }, account }),
    createSession: async (input) => { saved = input; return input; },
    publicGitServer: (input) => ({ id: input.id, type: input.type }),
    syncRepositories: async () => [],
  };
  global.fetch = async (url) => {
    if (String(url).endsWith('/login/oauth/access_token')) return Response.json({ access_token: 'user-token', refresh_token: 'refresh', expires_in: 28800 });
    if (String(url).endsWith('/user')) return Response.json({ id: 3, login: 'alex' });
    return Response.json({ installations: [] });
  };
  const authorize = await createGithubOAuthAuthorize({ store, basePublicUrl: 'https://flow.example', input: { gitServerId: server.id } });
  assert.equal(new URL(authorize.authorizeUrl).searchParams.get('redirect_uri'), 'https://flow.example/api/auth/github/callback');
  await assert.rejects(finishGithubOAuth({ store, query: { state: `${authorize.state}x`, code: 'code' } }), /state_invalid/);
  const result = await finishGithubOAuth({ store, basePublicUrl: 'https://flow.example', query: { state: authorize.state, code: 'code' } });
  assert.equal(result.status, 302);
  assert.equal(saved.provider, 'github');
  assert.equal(saved.account.providerUserId, '3');
  assert.equal(saved.refreshToken, 'refresh');
  assert.ok(Date.parse(saved.expiresAt) > Date.now());
});

test('GitHub OAuth refresh rotates the stored access and refresh tokens', async () => {
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://github.com/login/oauth/access_token');
    assert.equal(init.body.get('grant_type'), 'refresh_token');
    return Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 28800 });
  };
  const session = await resolveFreshSession({ userId: 'user', gitServerId: server.id, store: {
    getGitCredential: async () => ({ id: 'session', gitServerId: server.id, provider: 'github', refreshToken: 'old-refresh', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    getGitServer: async () => server,
    updateSessionTokens: async (id, input) => input,
  } });
  assert.equal(session.token, 'new-token');
  assert.equal(session.refreshToken, 'new-refresh');
  global.fetch = async () => Response.json({ error: 'bad_verification_code', error_description: 'secret should not leak' });
  await assert.rejects(githubOAuthToken(server, { code: 'bad' }), (error) => error.status === 401 && !error.message.includes('secret'));
});

test('OAuth callback requires the state bound to the initiating browser', async (t) => {
  const app = require('fastify')();
  const { githubAuthRoutes } = require('../src/routes/auth/github.ts');
  app.decorate('issueFlowStore', { getGitServer: async () => server, resolveCryptoKey: () => Buffer.alloc(32, 2) });
  app.addHook('onRequest', async (request) => { request.cookies = {}; });
  await app.register(githubAuthRoutes);
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/auth/github/authorize', payload: { gitServerId: server.id } });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['set-cookie'], /issue_flow_github_oauth=/);
  const state = new URL(response.json().authorizeUrl).searchParams.get('state');
  const denied = await app.inject({ url: `/api/auth/github/callback?state=${encodeURIComponent(state)}&code=code` });
  assert.equal(denied.statusCode, 401);
});

test('concurrent dashboard requests share one refresh-token rotation', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 28800 }); };
  const store = {
    getGitCredential: async () => ({ id: 'session', gitServerId: server.id, refreshToken: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    getGitServer: async () => server,
    updateSessionTokens: async (id, input) => input,
  };
  const results = await Promise.all(Array.from({ length: 4 }, () => resolveFreshSession({ store, userId: 'user', gitServerId: server.id })));
  assert.equal(calls, 1);
  assert.ok(results.every((session) => session.refreshToken === 'rotated'));
});

test('App installation uses browser-bound state and callback establishes the Console session', async (t) => {
  const app = require('fastify')();
  const { githubAuthRoutes } = require('../src/routes/auth/github.ts');
  const { parseCookies, consoleSessionCookieName } = require('../src/utils/http.ts');
  const store = {
    getGitServer: async () => server, resolveCryptoKey: () => Buffer.alloc(32, 3),
    getConsoleSessionByToken: async () => undefined,
    resolveUserForGitAccount: async ({ account }) => ({ user: { id: 'user' }, account }),
    createSession: async (input) => ({ id: 'credential', ...input }),
    publicGitServer: (input) => ({ id: input.id, type: input.type }),
    syncRepositories: async () => [], createConsoleSession: async () => ({ token: 'console-token' }),
  };
  app.decorate('issueFlowStore', store);
  app.addHook('onRequest', async (request) => { request.cookies = parseCookies(request.headers.cookie || ''); });
  await app.register(githubAuthRoutes);
  t.after(() => app.close());
  global.fetch = async (url) => {
    if (String(url).includes('/access_token')) return Response.json({ access_token: 'user-token', refresh_token: 'refresh', expires_in: 28800 });
    if (String(url).endsWith('/user')) return Response.json({ id: 1, login: 'alex' });
    return Response.json({ installations: [] });
  };
  const start = await app.inject({ url: `/api/auth/github/install?gitServerId=${server.id}` });
  assert.equal(start.statusCode, 302);
  const url = new URL(start.headers.location);
  assert.equal(url.pathname, '/apps/issue-flow-test/installations/new');
  const response = await app.inject({ url: `/api/auth/github/callback?state=${url.searchParams.get('state')}&code=code`, headers: { cookie: start.headers['set-cookie'].split(';')[0] } });
  assert.equal(response.statusCode, 302);
  assert.ok(response.headers['set-cookie'].some((value) => value.startsWith(`${consoleSessionCookieName()}=console-token`)));
});
