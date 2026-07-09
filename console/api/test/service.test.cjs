const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const packageVersion = require('../../../plugin/package.json').version;

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const envPath = path.join(__dirname, '..', '..', '..', '.env.dev');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.startsWith('DATABASE_URL='));
    if (line) {
      process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim();
      return process.env.DATABASE_URL;
    }
  }
  throw new Error('DATABASE_URL is required for service tests');
}

loadDatabaseUrl();
process.env.ISSUE_FLOW_BASE_URL ||= 'https://issue-flow.internal';
process.env.ISSUE_FLOW_SETUP_CODE ||= 'test-setup-code';
require('tsx/cjs');

const { createApp } = require('../src/app.ts');
const { IssueFlowStore } = require('../src/core/store.ts');
const { normalizeGitLabWebhook } = require('@xmz-ai/gitlab-webhook-bridge');
const { upsertGitlabWebhook, validateGitlabToken } = require('../src/core/gitlab.ts');
const { getUserAgentrixConfig } = require('../src/core/user-agentrix-config.ts');
const { handleGitlabWebhook } = require('../src/core/gitlab-webhook.ts');
const { applyGitEventToIssueFacts } = require('../src/core/issue-projection.ts');
const { connectGitlabSession } = require('../src/core/gitlab-auth.ts');
const {
  checkGitlabProjectInstall,
  getGitlabProjectRole,
  listGitlabProjectsWithInstallStatus,
  setGitlabProjectInstallPermission,
  setGitlabProjectInstallRunner,
  setGitlabProjectInstallVariable,
  setGitlabProjectInstallWebhook,
} = require('../src/core/gitlab-projects.ts');
const { syncIssuesSnapshot } = require('../src/core/repositories.ts');

let testSchemaCounter = 0;
const migrationSql = fs.readdirSync(path.join(__dirname, '..', 'prisma', 'migrations'))
  .filter((name) => /^\d+_/.test(name))
  .sort()
  .map((name) => fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql'),
    'utf8'
  ))
  .join('\n');

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrlWithoutSchema(value) {
  const url = new URL(value);
  url.searchParams.delete('schema');
  return url.toString();
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-service-test-'));
  const schema = `issue_flow_test_${process.pid}_${Date.now()}_${++testSchemaCounter}`;
  const connectionString = databaseUrlWithoutSchema(loadDatabaseUrl());
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema }),
  });
  const store = new IssueFlowStore({
    db: prisma,
    keyPath: path.join(dir, 'key'),
  });
  store.ready = (async () => {
    await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await pool.query(`SET search_path TO ${quoteIdent(schema)};\n${migrationSql}`);
  })();
  store.close = async () => {
    await store.ready;
    await prisma.$disconnect();
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await pool.end();
  };
  return { dir, store };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(callback, options = {}) {
  const timeoutMs = options.timeoutMs || 1000;
  const intervalMs = options.intervalMs || 20;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error('condition not met before timeout');
}

function setCookieToCookieHeader(value = '') {
  return String(value || '')
    .split(/,\s*(?=[^;,]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function listenApp(store) {
  const app = await createApp({ store });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function seedGitlabServer(store, baseUrl, options = {}) {
  return store.ensureGitServer({
    id: options.id || 'gitlab-main',
    type: 'gitlab',
    name: options.name || 'GitLab Test',
    baseUrl,
    apiUrl: `${baseUrl}/api/v4`,
    tokenAuth: options.tokenAuth || 'bearer',
    oauth: {
      clientId: options.oauthClientId || 'oauth-client',
      clientSecret: options.oauthClientSecret || 'oauth-secret',
      scopes: options.oauthScopes || 'api read_repository write_repository openid profile email',
    },
    webhook: {
      secret: options.webhookSecret || 'backend-webhook-secret',
    },
    agentrixGitServerId: options.agentrixGitServerId || 'agentrix-gitlab-main',
    adminPat: options.adminPat || 'gl-admin-pat',
    botPat: options.botPat || 'gl-bot-pat',
  });
}

test('API service requires ISSUE_FLOW_BASE_URL at startup', async () => {
  const previousBaseUrl = process.env.ISSUE_FLOW_BASE_URL;
  delete process.env.ISSUE_FLOW_BASE_URL;
  try {
    await assert.rejects(
      () => createApp({ store: { ready: Promise.resolve() } }),
      /ISSUE_FLOW_BASE_URL is required/
    );
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.ISSUE_FLOW_BASE_URL;
    } else {
      process.env.ISSUE_FLOW_BASE_URL = previousBaseUrl;
    }
  }
});

test('service store creates repositories without repo credential storage', async () => {
  const { dir, store } = tempStore();
  try {
    await seedGitlabServer(store, 'https://gitlab.example.com');
    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'team/app',
      token: 'glpat-service-token-123',
      webhookSecret: 'webhook-secret-123',
      agentrix: {
        baseUrl: 'https://agentrix.example.com',
        apiKey: 'agentrix-secret-key',
      },
    }, {
      status: 'valid',
      username: 'alice',
      projectId: '42',
      defaultBranch: 'main',
    });

    const stateText = JSON.stringify(created);
    assert.doesNotMatch(stateText, /glpat-service-token-123/);
    assert.doesNotMatch(stateText, /webhook-secret-123/);
    assert.doesNotMatch(stateText, /agentrix-secret-key/);
    assert.equal(created.repo.install, undefined);
    assert.equal(created.repo.webhook.secretFingerprint, '');
    assert.equal(created.repo.automation.autoDefault, 'triage');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service store keeps Git server config in columns and public reads hide secrets', async () => {
  const { dir, store } = tempStore();
  try {
    const server = await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      name: 'Internal GitLab',
      baseUrl: 'https://gitlab.example.com',
      apiUrl: 'https://gitlab.example.com/api/v4',
      tokenAuth: 'bearer',
      oauth: {
        clientId: 'oauth-client',
        clientSecret: 'oauth-secret',
        scopes: 'api read_repository write_repository openid profile email',
      },
      webhook: {
        secret: 'webhook-secret',
      },
      agentrixGitServerId: 'agentrix-main',
      adminPat: 'admin-pat-secret',
      botPat: 'bot-pat-secret',
      commitAuthor: {
        name: 'Issue Flow',
        email: 'issue-flow@company.test',
      },
    });
    assert.equal(server.id, 'gitlab-main');
    assert.equal(server.type, 'gitlab');
    assert.equal(server.oauth.clientSecret, 'oauth-secret');
    assert.equal(server.webhook.secret, 'webhook-secret');
    assert.equal(server.agentrixGitServerId, 'agentrix-main');
    assert.equal(server.adminPat, 'admin-pat-secret');
    assert.equal(server.botPat, 'bot-pat-secret');

    const row = await store.db.gitServer.findUnique({ where: { id: 'gitlab-main' } });
    const raw = JSON.stringify(row);
    assert.equal(row.oauthClientId, 'oauth-client');
    assert.equal(row.baseUrl, 'https://gitlab.example.com');
    assert.equal(row.apiUrl, 'https://gitlab.example.com/api/v4');
    assert.equal(row.oauthScopes, 'api read_repository write_repository openid profile email');
    assert.equal(row.agentrixGitServerId, 'agentrix-main');
    assert.equal(row.adminPat, 'admin-pat-secret');
    assert.equal(row.botPat, 'bot-pat-secret');
    assert.equal(row.commitAuthorName, 'Issue Flow');
    assert.equal(row.commitAuthorEmail, 'issue-flow@company.test');
    assert.match(raw, /oauth-secret/);
    assert.match(raw, /webhook-secret/);
    assert.match(raw, /admin-pat-secret/);
    assert.match(raw, /bot-pat-secret/);

    const publicServer = await store.getGitServer('gitlab-main');
    assert.equal(publicServer.oauth.clientSecret, undefined);
    assert.equal(publicServer.webhook.secret, undefined);
    assert.equal(publicServer.adminPat, undefined);
    assert.equal(publicServer.botPat, undefined);
    assert.deepEqual(publicServer.commitAuthor, {
      name: 'Issue Flow',
      email: 'issue-flow@company.test',
    });
    assert.equal(publicServer.oauth.clientSecretFingerprint.length, 12);
    assert.equal(publicServer.webhook.secretFingerprint.length, 12);
    assert.equal(publicServer.adminPatFingerprint.length, 12);
    assert.equal(publicServer.botPatFingerprint.length, 12);

    await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      name: 'Internal GitLab',
      baseUrl: 'https://gitlab.example.com',
      apiUrl: 'https://gitlab.example.com/api/v4',
      tokenAuth: 'bearer',
      oauth: {
        clientId: 'oauth-client-2',
        clientSecret: 'oauth-secret-2',
        scopes: 'api read_repository write_repository openid profile email',
      },
      webhook: {
        secret: 'webhook-secret-2',
      },
      adminPat: 'admin-pat-secret-2',
      botPat: 'bot-pat-secret-2',
      commitAuthor: {
        name: 'Issue Flow Bot',
        email: 'issue-flow-bot@company.test',
      },
    });
    const updated = await store.getGitServer('gitlab-main', { includeSecret: true });
    assert.equal(updated.oauth.clientSecret, 'oauth-secret-2');
    assert.equal(updated.webhook.secret, 'webhook-secret-2');
    assert.equal(updated.agentrixGitServerId, 'agentrix-main');
    assert.equal(updated.adminPat, 'admin-pat-secret-2');
    assert.equal(updated.botPat, 'bot-pat-secret-2');
    assert.deepEqual(updated.commitAuthor, {
      name: 'Issue Flow Bot',
      email: 'issue-flow-bot@company.test',
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('service store can read manually inserted Git server columns', async () => {
  const { dir, store } = tempStore();
  try {
    await store.ready;
    await store.db.gitServer.create({
      data: {
        id: 'gitlab-manual',
        type: 'gitlab',
        name: 'Manual GitLab',
        baseUrl: 'https://gitlab.example.com',
        apiUrl: 'https://gitlab.example.com/api/v4',
        tokenAuth: 'bearer',
        oauthClientId: 'manual-client',
        oauthClientSecret: 'manual-oauth-secret',
        oauthScopes: 'api read_repository write_repository openid profile email',
        webhookSecret: 'manual-webhook-secret',
        agentrixGitServerId: 'agentrix-manual',
        adminPat: 'manual-admin-pat',
      },
    });

    const server = await store.getGitServer('gitlab-manual', { includeSecret: true });
    assert.equal(server.id, 'gitlab-manual');
    assert.equal(server.oauth.clientId, 'manual-client');
    assert.equal(server.oauth.clientSecret, 'manual-oauth-secret');
    assert.equal(server.webhook.secret, 'manual-webhook-secret');
    assert.equal(server.agentrixGitServerId, 'agentrix-manual');
    assert.equal(server.adminPat, 'manual-admin-pat');

    const publicServer = await store.getGitServer('gitlab-manual');
    assert.equal(publicServer.oauth.clientSecret, undefined);
    assert.equal(publicServer.webhook.secret, undefined);
    assert.equal(publicServer.adminPat, undefined);
    assert.equal(publicServer.oauth.clientSecretFingerprint.length, 12);
    assert.equal(publicServer.adminPatFingerprint.length, 12);
    assert.equal(publicServer.webhook.secretFingerprint.length, 12);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('user Agentrix defaults return triage until saved', async () => {
  const { dir, store } = tempStore();
  try {
    const session = await store.createSession({
      token: 'gl-oauth-user-token',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example.com' },
      user: { username: 'alice', name: 'Alice' },
    });
    const result = await getUserAgentrixConfig({
      store,
      session: await store.getSession(session.id),
      env: { ISSUE_FLOW_AGENTRIX_BASE_URL: 'https://agentrix.xmz.ai' },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.config.automation.autoDefault, 'triage');
    assert.equal(result.body.config.automation.agent, 'codex');
    assert.equal(result.body.config.agentrix.baseUrl, 'https://agentrix.xmz.ai');
    assert.equal(result.body.config.agentrix.apiKeyFingerprint, '');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('user Agentrix config validates key and loads resources', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_AGENTRIX_BASE_URL: process.env.ISSUE_FLOW_AGENTRIX_BASE_URL,
  };
  const requests = [];
  const agentrix = http.createServer((req, res) => {
    requests.push(req.url);
    assert.equal(req.headers.authorization, 'Bearer agentrix-key');
    if (req.url === '/v1/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user: {
          id: 'agx-user-1',
          username: 'alice',
          email: 'alice@agentrix.test',
          avatar: null,
          role: 'user',
          encryptedSecret: null,
          secretSalt: null,
          stripeCustomerId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }));
      return;
    }
    if (req.url === '/v1/private-clouds') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        clouds: [{ id: 'cloud-main', name: 'Main cloud', type: 'private', status: 'active', role: 'owner', onlineMachineCount: 1, machineCount: 2, createdAt: '', updatedAt: '', owner: 'agx-user-1' }],
        entitlement: { enabled: true, maxPrivateClouds: 3, maxMachinesPerPrivateCloud: 5, maxPrivateCloudMembers: 8, currentPrivateCloudCount: 1 },
      }));
      return;
    }
    if (req.url === '/v1/machines') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        clouds: [],
        localMachines: [{ id: 'machine-main', owner: 'agx-user-1', status: 'online', metadata: null, approval: 'approved', dataEncryptionKey: '', controlPort: 17321, createdAt: '', updatedAt: '' }],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const agentrixBase = await listen(agentrix);
  process.env.ISSUE_FLOW_AGENTRIX_BASE_URL = agentrixBase;
  const { app, baseUrl } = await listenApp(store);
  try {
    await store.createUser({ id: 'user-alice', displayName: 'Alice', email: 'alice@example.com' });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example.com' },
      user: { id: '101', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    const cookie = `issue_flow_session_gitlab-main=${session.id}`;
    const saved = await fetch(`${baseUrl}/api/user/agentrix-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
        agentrix: { apiKey: 'agentrix-key' },
      }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.config.agentrix.user.username, 'alice');
    assert.equal(savedBody.config.agentrix.apiKey, undefined);
    assert.equal(savedBody.config.agentrix.apiKeyFingerprint.length, 12);

    const resources = await fetch(`${baseUrl}/api/user/agentrix-resources?gitServerId=gitlab-main`, {
      headers: { Cookie: cookie },
    });
    assert.equal(resources.status, 200);
    const resourceBody = await resources.json();
    assert.equal(resourceBody.configured, true);
    assert.equal(resourceBody.privateClouds[0].id, 'cloud-main');
    assert.equal(resourceBody.localMachines[0].id, 'machine-main');
    assert.equal(requests.filter((item) => item === '/v1/auth/me').length, 2);
    assert.equal(requests.includes('/v1/private-clouds'), true);
    assert.equal(requests.includes('/v1/machines'), true);
  } finally {
    await app.close();
    await close(agentrix);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('OAuth session upsert keeps one current session per user and Git server', async () => {
  const { dir, store } = tempStore();
  try {
    const user = await store.createUser({ displayName: 'Alice' });
    const first = await store.createSession({
      userId: user.id,
      token: 'old-token',
      refreshToken: 'old-refresh',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example.com' },
      user: { username: 'alice', name: 'Alice' },
    });
    const second = await store.createSession({
      userId: user.id,
      token: 'new-token',
      refreshToken: 'new-refresh',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example.com' },
      user: { username: 'alice', name: 'Alice Updated' },
    });

    assert.equal(second.id, first.id);
    assert.equal(await store.db.oAuthSession.count(), 1);
    const saved = await store.getSession(first.id);
    assert.equal(saved.token, 'new-token');
    assert.equal(saved.refreshToken, 'new-refresh');
    assert.equal(saved.user.name, 'Alice Updated');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git accounts resolve to one issue-flow user across git servers', async () => {
  const { dir, store } = tempStore();
  try {
    await seedGitlabServer(store, 'https://gitlab-one.example.com');
    await store.ensureGitServer({
      id: 'github-main',
      type: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.com',
      apiUrl: 'https://api.github.com',
    });

    const first = await store.resolveUserForGitAccount({
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
    });
    const second = await store.resolveUserForGitAccount({
      currentUserId: first.user.id,
      account: {
        provider: 'github',
        gitServerId: 'github-main',
        providerUserId: '202',
        username: 'alice-gh',
        displayName: 'Alice GH',
      },
    });
    const repeated = await store.resolveUserForGitAccount({
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice Updated',
      },
    });
    const user = await store.getUser(first.user.id, { includeAccounts: true });

    assert.equal(first.accountCreated, true);
    assert.equal(second.accountCreated, true);
    assert.equal(repeated.accountCreated, false);
    assert.equal(second.user.id, first.user.id);
    assert.equal(repeated.user.id, first.user.id);
    assert.equal(user.accounts.length, 2);
    assert.deepEqual(user.accounts.map((account) => account.gitServerId).sort(), ['github-main', 'gitlab-main']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup initialize configures first git server and returns OAuth authorize URL', async () => {
  const previousAppUrl = process.env.ISSUE_FLOW_APP_URL;
  process.env.ISSUE_FLOW_APP_URL = 'https://public.issue-flow.test';
  const { dir, store } = tempStore();
  const { app, baseUrl } = await listenApp(store);
  try {
    const status = await fetch(`${baseUrl}/api/setup/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      initialized: false,
      needsSetup: true,
      state: 'uninitialized',
      setupCodeConfigured: true,
      missing: [],
      gitServers: [],
    });

    const rejected = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCode: 'wrong-code' }),
    });
    assert.equal(rejected.status, 401);

    const incomplete = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupCode: 'test-setup-code',
        type: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        oauth: {
          clientId: 'oauth-client',
          clientSecret: 'oauth-secret',
        },
        agentrixGitServerId: 'agentrix-main',
        adminPat: 'admin-pat',
      }),
    });
    assert.equal(incomplete.status, 400);
    const incompleteBody = await incomplete.json();
    assert.equal(incompleteBody.error, 'git_server_incomplete');
    assert.deepEqual(incompleteBody.missing, ['botPat']);
    assert.equal(await store.getGitServer('gitlab-gitlab-example-com'), undefined);

    const initialized = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupCode: 'test-setup-code',
        type: 'gitlab',
        baseUrl: 'https://gitlab.example.com',
        oauth: {
          clientId: 'oauth-client',
          clientSecret: 'oauth-secret',
        },
        agentrixGitServerId: 'agentrix-main',
        adminPat: 'admin-pat',
        botPat: 'bot-pat',
      }),
    });
    assert.equal(initialized.status, 201);
    assert.equal(initialized.headers.get('set-cookie'), null);
    const body = await initialized.json();
    assert.equal(body.gitServer.id, 'gitlab-gitlab-example-com');
    assert.equal(body.gitServer.name, 'gitlab.example.com');
    assert.equal(body.gitServer.baseUrl, 'https://gitlab.example.com');
    assert.equal(body.gitServer.apiUrl, 'https://gitlab.example.com/api/v4');
    assert.deepEqual(body.gitServer.commitAuthor, {
      name: 'issue-flow',
      email: 'issue-flow@example.com',
    });
    assert.doesNotMatch(JSON.stringify(body), /oauth-secret|admin-pat|bot-pat/);

    const savedServer = await store.getGitServer('gitlab-gitlab-example-com', { includeSecret: true });
    assert.equal(Object.hasOwn(savedServer.oauth, 'redirectUri'), false);
    assert.equal(savedServer.oauth.scopes, 'api read_repository write_repository openid profile email');
    assert.match(savedServer.webhook.secret, /^[a-f0-9]{64}$/);
    assert.equal(savedServer.botPat, 'bot-pat');
    assert.deepEqual(savedServer.commitAuthor, {
      name: 'issue-flow',
      email: 'issue-flow@example.com',
    });

    const nextStatus = await fetch(`${baseUrl}/api/setup/status`);
    const nextBody = await nextStatus.json();
    assert.equal(nextBody.initialized, true);
    assert.equal(nextBody.needsSetup, false);
    assert.equal(nextBody.state, 'configured');
    assert.equal(nextBody.gitServers[0].id, 'gitlab-gitlab-example-com');
    assert.doesNotMatch(JSON.stringify(nextBody), /oauth-secret|admin-pat/);

    const authorizeUrl = new URL(body.authorizeUrl || '');
    assert.equal(`${authorizeUrl.origin}${authorizeUrl.pathname}`, 'https://gitlab.example.com/oauth/authorize');
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://issue-flow.internal/api/auth/gitlab/callback');
    assert.match(authorizeUrl.searchParams.get('state') || '', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  } finally {
    if (previousAppUrl === undefined) {
      delete process.env.ISSUE_FLOW_APP_URL;
    } else {
      process.env.ISSUE_FLOW_APP_URL = previousAppUrl;
    }
    await app.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup status does not force setup when an existing Git server lacks Bot PAT', async () => {
  const { dir, store } = tempStore();
  const { app, baseUrl } = await listenApp(store);
  try {
    await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      name: 'GitLab Main',
      baseUrl: 'https://gitlab.example.com',
      apiUrl: 'https://gitlab.example.com/api/v4',
      oauth: {
        clientId: 'oauth-client',
        clientSecret: 'oauth-secret',
      },
      webhook: {
        secret: 'webhook-secret',
      },
      agentrixGitServerId: 'agentrix-main',
      adminPat: 'admin-pat',
      commitAuthor: {
        name: 'issue-flow',
        email: 'issue-flow@example.com',
      },
    });

    const status = await fetch(`${baseUrl}/api/setup/status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.initialized, true);
    assert.equal(body.needsSetup, false);
    assert.equal(body.state, 'configured');
    assert.deepEqual(body.missing, []);
  } finally {
    await app.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup code is generated when ISSUE_FLOW_SETUP_CODE is missing', async () => {
  const previousSetupCode = process.env.ISSUE_FLOW_SETUP_CODE;
  delete process.env.ISSUE_FLOW_SETUP_CODE;
  const { dir, store } = tempStore();
  const { app, baseUrl } = await listenApp(store);
  try {
    assert.match(process.env.ISSUE_FLOW_SETUP_CODE, /^issue-flow-[0-9a-f]{32}$/);

    const status = await fetch(`${baseUrl}/api/setup/status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    assert.equal(body.needsSetup, true);
    assert.equal(body.setupCodeConfigured, true);

    const rejected = await fetch(`${baseUrl}/api/setup/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupCode: 'wrong-code' }),
    });
    assert.equal(rejected.status, 401);
  } finally {
    if (previousSetupCode === undefined) {
      delete process.env.ISSUE_FLOW_SETUP_CODE;
    } else {
      process.env.ISSUE_FLOW_SETUP_CODE = previousSetupCode;
    }
    await app.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup OAuth creates exactly one default admin user', async () => {
  const { dir, store } = tempStore();
  try {
    await seedGitlabServer(store, 'https://gitlab.example.com');
    const first = await store.resolveUserForGitAccount({
      setupAdminEligible: true,
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
    });
    const second = await store.resolveUserForGitAccount({
      setupAdminEligible: true,
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '202',
        username: 'bob',
        displayName: 'Bob',
      },
    });

    assert.equal(first.user.role, 'admin');
    assert.equal(second.user.role, 'member');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab webhook bridge normalizes supported event classes', () => {
  const headers = {
    'x-gitlab-token': 'webhook-secret',
    'x-gitlab-event-uuid': 'delivery-bridge-normalize',
  };
  const issue = normalizeGitLabWebhook({
    headers,
    body: {
      object_kind: 'issue',
      project: { id: 42, path_with_namespace: 'team/app' },
      object_attributes: { id: 100, iid: 1, action: 'open', state: 'opened' },
    },
  }, 'webhook-secret');
  assert.equal(issue.events[0].eventName, 'issues');
  assert.equal(issue.events[0].eventAction, 'opened');

  const mrDiffNote = normalizeGitLabWebhook({
    headers,
    body: {
      object_kind: 'note',
      project: { id: 42, path_with_namespace: 'team/app' },
      merge_request: { iid: 7, source_branch: 'feature', target_branch: 'main' },
      object_attributes: {
        id: 200,
        noteable_type: 'MergeRequest',
        action: 'create',
        position: { new_path: 'src/app.js', new_line: 12 },
      },
    },
  }, 'webhook-secret');
  assert.equal(mrDiffNote.events[0].eventName, 'pull_request_review_comment');
  assert.equal(mrDiffNote.events[0].eventAction, 'created');

  const pipeline = normalizeGitLabWebhook({
    headers,
    body: {
      object_kind: 'pipeline',
      project: { id: 42, path_with_namespace: 'team/app' },
      object_attributes: { id: 300, status: 'failed', ref: 'main', sha: 'abc' },
    },
  }, 'webhook-secret');
  assert.equal(pipeline.events[0].eventName, 'workflow_run');
  assert.equal(pipeline.events[0].workflowRun.conclusion, 'failure');
});

test('git events project issue snapshots and flow spans', async () => {
  const { dir, store } = tempStore();
  try {
    await seedGitlabServer(store, 'https://gitlab.example.com');
    const createdRepo = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: 'https://gitlab.example.com',
      projectPath: 'team/app',
    }, { status: 'unchecked', projectId: '42' });
    const common = {
      repoId: createdRepo.repo.id,
      gitServerId: 'gitlab-main',
      repositoryId: '42',
      repositoryFullName: 'team/app',
      eventName: 'issue',
      objectType: 'issue',
      objectId: '100',
    };
    const opened = await store.createGitEvent({
      ...common,
      deliveryId: 'issue-delivery-open',
      action: 'opened',
      payload: {
        object_kind: 'issue',
        project: { id: 42, path_with_namespace: 'team/app' },
        labels: [{ title: 'flow::triage' }, { title: 'type::bug' }, { title: 'priority::p1' }, { title: 'size::M' }, { title: 'automation::build' }],
        object_attributes: {
          id: 100,
          iid: 7,
          title: 'Fix import crash',
          state: 'opened',
          created_at: '2026-07-01T01:00:00.000Z',
          updated_at: '2026-07-01T01:00:00.000Z',
        },
      },
      normalizedEvents: [{ eventName: 'issues', eventAction: 'opened' }],
    });
    await applyGitEventToIssueFacts(store, opened);

    let issues = await store.listIssues(createdRepo.repo.id);
    let spans = await store.listIssueSpans(createdRepo.repo.id, '100');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].issueId, '100');
    assert.equal(issues[0].issueNumber, 7);
    assert.equal(issues[0].title, 'Fix import crash');
    assert.equal(issues[0].state, 'opened');
    assert.equal(issues[0].type, 'bug');
    assert.equal(issues[0].priority, 'P1');
    assert.equal(issues[0].size, 'M');
    assert.equal(issues[0].automation, 'build');
    assert.equal(issues[0].status, 'active');
    assert.equal(issues[0].openedAt, '2026-07-01T01:00:00.000Z');
    assert.equal(issues[0].closedAt, '');
    assert.equal(spans.length, 1);
    assert.equal(spans[0].flow, 'triage');
    assert.equal(spans[0].enteredAt, '2026-07-01T01:00:00.000Z');
    assert.equal(spans[0].exitedAt, '');

    const planned = await store.createGitEvent({
      ...common,
      deliveryId: 'issue-delivery-plan',
      action: 'labeled',
      payload: {
        object_kind: 'issue',
        project: { id: 42, path_with_namespace: 'team/app' },
        labels: [{ title: 'flow::plan' }, { title: 'type::bug' }],
        object_attributes: {
          id: 100,
          iid: 7,
          title: 'Fix import crash',
          state: 'opened',
          created_at: '2026-07-01T01:00:00.000Z',
          updated_at: '2026-07-01T02:00:00.000Z',
        },
      },
      normalizedEvents: [{ eventName: 'issues', eventAction: 'labeled', label: { name: 'flow::plan' } }],
    });
    await applyGitEventToIssueFacts(store, planned);

    spans = await store.listIssueSpans(createdRepo.repo.id, '100');
    assert.equal(spans.length, 2);
    assert.equal(spans[0].flow, 'triage');
    assert.equal(spans[0].exitedAt, '2026-07-01T02:00:00.000Z');
    assert.equal(spans[1].flow, 'plan');
    assert.equal(spans[1].enteredAt, '2026-07-01T02:00:00.000Z');
    assert.equal(spans[1].exitedAt, '');

    const closed = await store.createGitEvent({
      ...common,
      deliveryId: 'issue-delivery-close',
      action: 'closed',
      payload: {
        object_kind: 'issue',
        project: { id: 42, path_with_namespace: 'team/app' },
        labels: [{ title: 'flow::plan' }, { title: 'type::bug' }],
        object_attributes: {
          id: 100,
          iid: 7,
          title: 'Fix import crash',
          state: 'closed',
          created_at: '2026-07-01T01:00:00.000Z',
          updated_at: '2026-07-01T03:00:00.000Z',
          closed_at: '2026-07-01T03:00:00.000Z',
        },
      },
      normalizedEvents: [{ eventName: 'issues', eventAction: 'closed' }],
    });
    await applyGitEventToIssueFacts(store, closed);

    issues = await store.listIssues(createdRepo.repo.id);
    spans = await store.listIssueSpans(createdRepo.repo.id, '100');
    assert.equal(issues[0].state, 'closed');
    assert.equal(issues[0].status, 'done');
    assert.equal(issues[0].closedAt, '2026-07-01T03:00:00.000Z');
    assert.equal(spans.length, 2);
    assert.equal(spans[1].exitedAt, '2026-07-01T03:00:00.000Z');

    const closedWithActiveLabel = await store.createGitEvent({
      ...common,
      deliveryId: 'issue-delivery-close-active-label',
      action: 'closed',
      payload: {
        object_kind: 'issue',
        project: { id: 42, path_with_namespace: 'team/app' },
        labels: [{ title: 'status::active' }, { title: 'flow::build' }],
        object_attributes: {
          id: 101,
          iid: 8,
          title: 'Closed issue with stale active label',
          state: 'closed',
          created_at: '2026-07-01T01:00:00.000Z',
          updated_at: '2026-07-01T04:00:00.000Z',
          closed_at: '2026-07-01T04:00:00.000Z',
        },
      },
      normalizedEvents: [{ eventName: 'issues', eventAction: 'closed' }],
    });
    await applyGitEventToIssueFacts(store, closedWithActiveLabel);

    issues = await store.listIssues(createdRepo.repo.id);
    const staleActive = issues.find((issue) => issue.issueId === '101');
    assert.equal(staleActive.state, 'closed');
    assert.equal(staleActive.status, 'done');
    assert.equal(staleActive.closedAt, '2026-07-01T04:00:00.000Z');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab issue snapshot sync imports current issues and open flow spans', async () => {
  const { dir, store } = tempStore();
  const gitlab = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v4/projects/42/issues') && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-admin-pat');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 101,
          iid: 9,
          title: 'Existing issue',
          state: 'opened',
          labels: ['flow::build', 'type::feature', 'priority::p2', 'size::L', 'automation::plan'],
          created_at: '2026-07-01T04:00:00.000Z',
          updated_at: '2026-07-01T05:00:00.000Z',
          closed_at: null,
        },
        {
          id: 102,
          iid: 10,
          title: 'Closed issue',
          state: 'closed',
          labels: ['type::bug'],
          created_at: '2026-07-01T01:00:00.000Z',
          updated_at: '2026-07-01T06:00:00.000Z',
          closed_at: '2026-07-01T06:00:00.000Z',
        },
        {
          id: 103,
          iid: 11,
          title: 'Opened issue with done label',
          state: 'opened',
          labels: ['flow::build', 'status::done'],
          created_at: '2026-07-01T07:00:00.000Z',
          updated_at: '2026-07-01T08:00:00.000Z',
          closed_at: null,
        },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  try {
    const user = await store.createUser({ displayName: 'Alice' });
    await seedGitlabServer(store, gitlabBase, { adminPat: 'gl-admin-pat' });
    const createdRepo = await store.createRepository({
      userId: user.id,
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      projectPath: 'team/app',
    }, { status: 'unchecked', projectId: '42' });

    const result = await syncIssuesSnapshot({
      store,
      repoId: createdRepo.repo.id,
      userId: user.id,
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.count, 3);
    assert.equal(result.body.issues.find((issue) => issue.issueId === '101').currentFlow, 'build');
    assert.equal(result.body.issues.find((issue) => issue.issueId === '103').currentFlow, 'build');
    const issues = await store.listIssues(createdRepo.repo.id);
    const spans = await store.listIssueSpans(createdRepo.repo.id);
    assert.deepEqual(issues.map((issue) => `${issue.issueNumber}:${issue.status}`), ['9:active', '10:done', '11:done']);
    assert.equal(issues[0].title, 'Existing issue');
    assert.equal(issues[0].state, 'opened');
    assert.equal(issues[0].type, 'feature');
    assert.equal(issues[0].priority, 'P2');
    assert.equal(issues[0].size, 'L');
    assert.equal(issues[0].automation, 'plan');
    assert.equal(issues[1].closedAt, '2026-07-01T06:00:00.000Z');
    assert.equal(issues[1].state, 'closed');
    assert.equal(issues[2].state, 'opened');
    assert.equal(issues[2].flow, 'build');
    assert.equal(issues[2].currentFlow, 'build');
    assert.equal(spans.length, 1);
    assert.equal(spans[0].issueId, '101');
    assert.equal(spans[0].flow, 'build');
    assert.equal(spans[0].enteredAt, '2026-07-01T05:00:00.000Z');
    assert.equal(spans[0].exitedAt, '');
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab webhook receiver authenticates with Git server secret and dispatches with admin PAT', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const pipelineVariables = {};
  const gitlab = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-admin-pat');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer gl-admin-pat');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 501, token: 'pipeline-trigger-token-1234567890', description: 'GitLab webhook bridge' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/trigger/pipeline' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer gl-admin-pat');
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        assert.equal(body.get('token'), 'pipeline-trigger-token-1234567890');
        assert.equal(body.get('ref'), 'main');
        for (const [key, value] of body.entries()) {
          const match = key.match(/^variables\[(.+)\]$/);
          if (match) {
            pipelineVariables[match[1]] = value;
          }
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 8001,
          iid: 81,
          project_id: 42,
          ref: 'main',
          sha: 'abc123',
          status: 'created',
          source: 'trigger',
          web_url: 'https://gitlab.example.com/team/app/-/pipelines/8001',
          created_at: '2026-06-29T00:00:00Z',
          updated_at: '2026-06-29T00:00:00Z',
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  try {
    await seedGitlabServer(store, gitlabBase, {
      adminPat: 'gl-admin-pat',
      agentrixGitServerId: 'agentrix-gitlab-main',
      webhookSecret: 'backend-webhook-secret',
    });
    const created = store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      projectPath: 'team/app',
      token: 'glpat-service-token-123',
      webhookSecret: 'webhook-secret-123',
      automation: { reviewEnabled: false },
    }, { status: 'unchecked', projectId: '42' });
    const payload = {
      object_kind: 'merge_request',
      project: { id: 42, path_with_namespace: 'team/app' },
      user: null,
      object_attributes: {
        id: 1001,
        iid: 7,
        action: 'open',
        state: 'opened',
        source_branch: 'feature',
        target_branch: 'main',
        description: null,
      },
    };

    const createdRepo = await created;
    const rejected = await handleGitlabWebhook({
      store,
      repoId: createdRepo.repo.id,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'wrong-secret',
        'X-Gitlab-Event': 'Merge Request Hook',
        'X-Gitlab-Event-UUID': 'delivery-1',
      },
      rawBody: JSON.stringify(payload),
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), []);

    const accepted = await handleGitlabWebhook({
      store,
      repoId: createdRepo.repo.id,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'backend-webhook-secret',
        'X-Gitlab-Event': 'Merge Request Hook',
        'X-Gitlab-Event-UUID': 'delivery-1',
      },
      rawBody: JSON.stringify(payload),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'delivered');
    assert.equal(accepted.body.deliveryId, 'delivery-1');
    assert.equal(accepted.body.providerEventName, 'merge_request');
    assert.equal(accepted.body.deliveries.some((delivery) => delivery.target === 'issue-flow-git-event-log' && delivery.reason === 'git_event_stored'), true);
    assert.equal(accepted.body.deliveries.some((delivery) => delivery.target === 'gitlab-pipeline' && delivery.status === 'delivered'), true);

    const gitEvents = await store.listGitEvents(createdRepo.repo.id);
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].gitServerId, 'gitlab-main');
    assert.equal(gitEvents[0].repositoryId, '42');
    assert.equal(gitEvents[0].repositoryFullName, 'team/app');
    assert.equal(gitEvents[0].deliveryId, 'delivery-1');
    assert.equal(gitEvents[0].eventName, 'merge_request');
    assert.equal(gitEvents[0].action, 'opened');
    assert.equal(gitEvents[0].objectType, 'pull_request');
    assert.equal(gitEvents[0].objectId, '1001');
    assert.equal(gitEvents[0].payload.headers, undefined);
    assert.equal(gitEvents[0].payload.object_kind, 'merge_request');
    assert.equal(gitEvents[0].payload.user, undefined);
    assert.equal(gitEvents[0].payload.object_attributes.description, undefined);
    assert.equal(gitEvents[0].normalizedEvents.length, 1);
    assert.equal(gitEvents[0].normalizedEvents[0].raw, undefined);
    assert.equal(pipelineVariables.AGENTRIX_GIT_SERVER_ID, 'agentrix-gitlab-main');
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
      'GET /api/v4/projects/42/triggers',
      'POST /api/v4/projects/42/triggers',
      'POST /api/v4/projects/42/trigger/pipeline',
    ]);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab webhook bridge ignores trigger-source pipeline fanout', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const gitlab = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  try {
    await seedGitlabServer(store, gitlabBase, {
      adminPat: 'gl-admin-pat',
      agentrixGitServerId: 'agentrix-gitlab-main',
      webhookSecret: 'backend-webhook-secret',
    });
    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      projectPath: 'team/app',
      automation: { reviewEnabled: false },
    }, { status: 'unchecked', projectId: '42' });

    const result = await handleGitlabWebhook({
      store,
      repoId: created.repo.id,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'backend-webhook-secret',
        'X-Gitlab-Event': 'Pipeline Hook',
        'X-Gitlab-Event-UUID': 'delivery-trigger-pipeline',
      },
      rawBody: JSON.stringify({
        object_kind: 'pipeline',
        project: { id: 42, path_with_namespace: 'team/app' },
        object_attributes: {
          id: 3001,
          iid: 91,
          status: 'failed',
          source: 'trigger',
          ref: 'main',
          sha: 'abc123',
          url: `${gitlabBase}/team/app/-/pipelines/3001`,
        },
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.deliveries.some((delivery) => {
      return delivery.target === 'gitlab-pipeline'
        && delivery.status === 'ignored'
        && delivery.reason === 'trigger_pipeline_webhook_ignored';
    }), true);
    assert.deepEqual(calls, []);

    const gitEvents = await store.listGitEvents(created.repo.id);
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].eventName, 'pipeline');
    assert.equal(gitEvents[0].action, 'completed');
    assert.equal(gitEvents[0].normalizedEvents[0].workflowRun.source, 'trigger');
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab merge request close webhook clears pending plugin MR', async () => {
  const { dir, store } = tempStore();
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 501, token: 'pipeline-trigger-token-1234567890' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/trigger/pipeline' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 8001, status: 'created' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  try {
    await seedGitlabServer(store, gitlabBase, {
      adminPat: 'gl-admin-pat',
      agentrixGitServerId: 'agentrix-gitlab-main',
      webhookSecret: 'backend-webhook-secret',
    });
    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      projectPath: 'team/app',
      automation: { reviewEnabled: false },
    }, { status: 'unchecked', projectId: '42' });
    await store.updateRepositorySettingsCache(created.repo.id, {
      plugins: {
        items: [{
          key: 'issue-flow',
          installed: true,
          installedVersion: '0.1.0',
          latestVersion: '0.2.0',
          needsUpgrade: true,
          pendingMergeRequest: {
            iid: '9',
            webUrl: `${gitlabBase}/team/app/-/merge_requests/9`,
            sourceBranch: 'issue-flow/upgrade-123',
          },
        }],
        checkedAt: new Date().toISOString(),
      },
    });

    const accepted = await handleGitlabWebhook({
      store,
      repoId: created.repo.id,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'backend-webhook-secret',
        'X-Gitlab-Event': 'Merge Request Hook',
        'X-Gitlab-Event-UUID': 'delivery-close-1',
      },
      rawBody: JSON.stringify({
        object_kind: 'merge_request',
        project: { id: 42, path_with_namespace: 'team/app' },
        object_attributes: {
          id: 1009,
          iid: 9,
          action: 'close',
          state: 'closed',
          source_branch: 'issue-flow/upgrade-123',
          target_branch: 'main',
        },
      }),
    });

    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.deliveries.some((delivery) => {
      return delivery.target === 'issue-flow-business'
        && delivery.status === 'delivered'
        && delivery.handled.includes('plugin_pending_merge_cleared');
    }), true);
    const repo = await store.getRepository(created.repo.id);
    const plugin = repo.settings.plugins.items.find((item) => item.key === 'issue-flow');
    assert.equal(plugin.pendingMergeRequest, undefined);
    assert.equal(plugin.needsUpgrade, true);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab merge request merge webhook marks pending plugin as installed without reading manifest', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const gitlab = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url });
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/triggers' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 501, token: 'pipeline-trigger-token-1234567890' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/trigger/pipeline' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 8001, status: 'created' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  try {
    await seedGitlabServer(store, gitlabBase, {
      adminPat: 'gl-admin-pat',
      agentrixGitServerId: 'agentrix-gitlab-main',
      webhookSecret: 'backend-webhook-secret',
    });
    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      projectPath: 'team/app',
      automation: { reviewEnabled: false },
    }, { status: 'unchecked', projectId: '42', defaultBranch: 'main' });
    await store.updateRepositorySettingsCache(created.repo.id, {
      plugins: {
        items: [{
          key: 'issue-flow',
          installed: false,
          latestVersion: packageVersion,
          targetVersion: packageVersion,
          needsUpgrade: true,
          pendingMergeRequest: {
            iid: '9',
            webUrl: `${gitlabBase}/team/app/-/merge_requests/9`,
            sourceBranch: 'issue-flow/install-123',
            targetBranch: 'main',
          },
        }],
        checkedAt: new Date().toISOString(),
      },
    });

    const accepted = await handleGitlabWebhook({
      store,
      repoId: created.repo.id,
      headers: {
        'Content-Type': 'application/json',
        'X-Gitlab-Token': 'backend-webhook-secret',
        'X-Gitlab-Event': 'Merge Request Hook',
        'X-Gitlab-Event-UUID': 'delivery-merge-1',
      },
      rawBody: JSON.stringify({
        object_kind: 'merge_request',
        project: { id: 42, path_with_namespace: 'team/app' },
        object_attributes: {
          id: 1009,
          iid: 9,
          action: 'merge',
          state: 'merged',
          source_branch: 'issue-flow/install-123',
          target_branch: 'main',
        },
      }),
    });

    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.deliveries.some((delivery) => {
      return delivery.target === 'issue-flow-business'
        && delivery.status === 'delivered'
        && delivery.handled.includes('plugin_merge_refreshed');
    }), true);
    assert.equal(calls.some((call) => call.url && call.url.includes('/repository/files/')), false);
    const repo = await store.getRepository(created.repo.id);
    const plugin = repo.settings.plugins.items.find((item) => item.key === 'issue-flow');
    assert.equal(plugin.pendingMergeRequest, undefined);
    assert.equal(plugin.installed, true);
    assert.equal(plugin.installedVersion, packageVersion);
    assert.equal(plugin.targetVersion, undefined);
    assert.equal(plugin.status, 'passed');
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API service exposes health and repository list over HTTP', async () => {
  const { dir, store } = tempStore();
  const { app, baseUrl } = await listenApp(store);
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const repositories = await fetch(`${baseUrl}/api/repositories`);
    assert.equal(repositories.status, 200);
    assert.deepEqual(await repositories.json(), {
      repositories: [],
      owners: [],
      page: 1,
      perPage: 50,
      total: 0,
      hasMore: false,
    });

    await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      apiUrl: 'https://gitlab.example.com/api/v4',
      oauth: { clientId: 'oauth-client', clientSecret: 'oauth-secret' },
      webhook: { secret: 'webhook-secret' },
    });
    const gitServers = await fetch(`${baseUrl}/api/git-servers`);
    assert.equal(gitServers.status, 200);
    const gitServersBody = await gitServers.json();
    assert.equal(gitServersBody.gitServers[0].id, 'gitlab-main');
    assert.doesNotMatch(JSON.stringify(gitServersBody), /oauth-secret|webhook-secret/);

    const createWithoutAdmin = await fetch(`${baseUrl}/api/git-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'gitlab-post', type: 'gitlab' }),
    });
    assert.equal(createWithoutAdmin.status, 403);

    await store.createUser({ id: 'admin-user', role: 'admin', displayName: 'Admin' });
    const adminSession = await store.createSession({
      userId: 'admin-user',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: 'https://gitlab.example.com' },
      user: { username: 'admin', name: 'Admin' },
      token: 'admin-oauth-token',
    });
    const adminCookie = `issue_flow_user=admin-user; issue_flow_session_gitlab-main=${adminSession.id}`;
    const createGitServer = await fetch(`${baseUrl}/api/git-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        id: 'gitlab-post',
        type: 'gitlab',
        name: 'GitLab Post',
        baseUrl: 'https://post.gitlab.example.com',
        oauth: { clientId: 'post-client', clientSecret: 'post-oauth-secret' },
        webhook: { secret: 'post-webhook-secret' },
        agentrixGitServerId: 'agentrix-post',
        adminPat: 'post-admin-pat',
        botPat: 'post-bot-pat',
      }),
    });
    assert.equal(createGitServer.status, 200);
    const createBody = await createGitServer.json();
    assert.equal(createBody.gitServer.id, 'gitlab-post');
    assert.doesNotMatch(JSON.stringify(createBody), /post-oauth-secret|post-webhook-secret|post-admin-pat|post-bot-pat/);

    const updateGitServer = await fetch(`${baseUrl}/api/git-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        id: 'gitlab-post',
        type: 'gitlab',
        name: 'GitLab Renamed',
        baseUrl: 'https://post.gitlab.example.com',
        oauth: { clientId: 'post-client-2', scopes: 'api' },
        webhook: {},
      }),
    });
    assert.equal(updateGitServer.status, 200);
    const saved = await store.getGitServer('gitlab-post', { includeSecret: true });
    assert.equal(saved.name, 'GitLab Renamed');
    assert.equal(saved.oauth.clientSecret, 'post-oauth-secret');
    assert.equal(saved.webhook.secret, 'post-webhook-secret');
    assert.equal(saved.adminPat, 'post-admin-pat');
    assert.equal(saved.botPat, 'post-bot-pat');

    const deleteGitServer = await fetch(`${baseUrl}/api/git-servers/gitlab-post`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    assert.equal(deleteGitServer.status, 200);
    assert.equal(await store.getGitServer('gitlab-post'), undefined);
  } finally {
    await app.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab project sync persists repo cache and install reuses repo id', async () => {
  const { dir, store } = tempStore();
  let visibleProjects = [{
    id: 42,
    name: 'App',
    path_with_namespace: 'team/app',
    web_url: 'https://gitlab.example.com/team/app',
    default_branch: 'main',
    permissions: { project_access: { access_level: 40 } },
  }];
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(visibleProjects));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({
      id: 'user-alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });
    const synced = await listGitlabProjectsWithInstallStatus({
      store,
      input: {
        gitServerId: 'gitlab-main',
        userId: user.id,
        token: 'gl-oauth-user-token',
      },
    });
    assert.equal(synced.status, 200);
    assert.equal(synced.body.projects[0].canInstall, true);

    const { repositories: repos } = await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id });
    assert.equal(repos.length, 1);
    assert.equal(repos[0].projectId, '42');
    assert.equal(repos[0].projectPath, 'team/app');
    assert.equal(repos[0].webUrl, 'https://gitlab.example.com/team/app');
    assert.equal(repos[0].installed, undefined);
    assert.equal(repos[0].canInstall, undefined);
    assert.equal(repos[0].permissionStatus, undefined);
    assert.equal(repos[0].data, undefined);

    visibleProjects = [];
    const refreshed = await listGitlabProjectsWithInstallStatus({
      store,
      input: {
        gitServerId: 'gitlab-main',
        userId: user.id,
        token: 'gl-oauth-user-token',
      },
    });
    assert.equal(refreshed.status, 200);
    assert.equal((await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id })).repositories.length, 0);
    assert.ok(await store.db.repo.findUnique({ where: { id: repos[0].id } }));

    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      userId: user.id,
      baseUrl: gitlabBase,
      apiUrl: `${gitlabBase}/api/v4`,
      projectPath: 'team/app',
    }, {
      status: 'valid',
      projectId: '42',
      defaultBranch: 'main',
    });
    assert.equal(created.repo.id, repos[0].id);
    assert.equal((await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id })).repositories.length, 1);
    assert.equal(await store.db.repoSettingItem.count({
      where: { repoId: repos[0].id, kind: 'webhook', key: 'issue-flow' },
    }), 0);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab project sync follows pagination before replacing repo access', async () => {
  const { dir, store } = tempStore();
  const requests = [];
  const gitlab = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-next-page': '2',
      });
      res.end(JSON.stringify([{
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        web_url: 'https://gitlab.example.com/team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }]));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&page=2&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 43,
        name: 'Api',
        path_with_namespace: 'team/api',
        web_url: 'https://gitlab.example.com/team/api',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({
      id: 'user-alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });
    const synced = await listGitlabProjectsWithInstallStatus({
      store,
      input: {
        gitServerId: 'gitlab-main',
        userId: user.id,
        token: 'gl-oauth-user-token',
      },
    });

    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body.projects.map((project) => project.id), ['42', '43']);
    assert.deepEqual(requests.slice(0, 3), [
      '/api/v4/user',
      '/api/v4/projects?membership=true&per_page=100',
      '/api/v4/projects?membership=true&page=2&per_page=100',
    ]);

    const { repositories: repos } = await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id });
    assert.deepEqual(repos.map((repo) => repo.projectPath), ['team/api', 'team/app']);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agentrix private cloud uses the Git server Bot PAT without target repo', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_AGENTRIX_BASE_URL: process.env.ISSUE_FLOW_AGENTRIX_BASE_URL,
    ISSUE_FLOW_AGENTRIX_CLI_IMAGE: process.env.ISSUE_FLOW_AGENTRIX_CLI_IMAGE,
    ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN: process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN,
    LLM_PROXY_BASE_URL: process.env.LLM_PROXY_BASE_URL,
  };
  const requests = [];
  const gitlab = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/v4/user' && req.method === 'GET') {
      assert.equal(req.headers['private-token'], 'gl-bot-pat');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 7,
        username: 'issue-flow-bot',
        name: 'Issue Flow Bot',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  const agentrix = http.createServer((req, res) => {
    requests.push(`agentrix:${req.url}`);
    if (req.url === '/v1/private-clouds/cloud-main/runner-secret' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer agentrix-key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: 'cloud-secret' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const agentrixBase = await listen(agentrix);
  await seedGitlabServer(store, gitlabBase);
  process.env.ISSUE_FLOW_AGENTRIX_BASE_URL = agentrixBase;
  process.env.ISSUE_FLOW_AGENTRIX_CLI_IMAGE = 'registry.internal/agentrix/agentrix-cli:2026.07';
  process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN = 'forward-token';
  process.env.LLM_PROXY_BASE_URL = 'https://llm.internal';

  const { app, baseUrl } = await listenApp(store);
  try {
    await store.createUser({ id: 'user-alice', displayName: 'Alice', email: 'alice@example.com' });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '101', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    await store.saveUserAgentrixConfig('user:user-alice', {
      agentrix: {
        apiKey: 'agentrix-key',
        user: { id: 'agentrix-user-1', username: 'alice' },
      },
    });
    const cookie = `issue_flow_session_gitlab-main=${session.id}`;
    const created = await fetch(`${baseUrl}/api/agentrix/private-cloud/gitlab-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
        runnerId: 'cloud-main',
        llmProxyApiKey: 'llm-proxy-key',
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.gitlabToken, 'gl-bot-pat');
    assert.equal(createdBody.runnerGitlabToken.runnerId, 'cloud-main');
    assert.equal(createdBody.runnerGitlabToken.token, undefined);
    assert.equal(createdBody.runnerGitlabToken.gitlabTokenId, '');
    assert.equal(createdBody.llmProxy.baseUrl, 'https://llm.internal');
    assert.equal(createdBody.llmProxy.apiKey, 'llm-proxy-key');
    assert.match(createdBody.dockerCommand, /AGENTRIX_API_KEY='llm-proxy-key'/);
    assert.match(createdBody.dockerCommand, /CLOUD_AUTH_TOKEN='cloud-secret'/);
    assert.match(createdBody.dockerCommand, /AGENTRIX_EVENT_FORWARD_WS_URL='wss:\/\/issue-flow\.internal\/webhooks\/agentrix\/forward'/);
    assert.match(createdBody.dockerCommand, /AGENTRIX_EVENT_FORWARD_TOKEN='forward-token'/);
    assert.match(createdBody.dockerCommand, /GITLAB_TOKEN='gl-bot-pat'/);
    assert.match(createdBody.dockerCommand, /-v agentrix-home:\/home\/agentrix\/\.agentrix/);
    assert.doesNotMatch(createdBody.dockerCommand, /agentrix-workspaces/);
    assert.doesNotMatch(createdBody.dockerCommand, /\/home\/agentrix\/\.agentrix\/workspaces/);
    assert.match(createdBody.dockerCommand, /registry\.internal\/agentrix\/agentrix-cli:2026\.07'$/);
    assert.equal(requests.includes('/api/v4/user'), true);
    assert.equal(requests.includes('/api/v4/users/7/personal_access_tokens'), false);
    assert.equal(requests.includes('/api/v4/users/7/impersonation_tokens'), false);
    assert.equal(requests.includes('/api/v4/users/101/impersonation_tokens'), false);
    assert.equal(requests.includes('agentrix:/v1/private-clouds/cloud-main/runner-secret'), true);

    assert.equal(createdBody.runnerGitlabToken.gitlabUserId, '7');
    assert.equal(createdBody.runnerGitlabToken.gitlabUsername, 'issue-flow-bot');
    const defaults = await store.getUserAgentrixConfig('user:user-alice', { includeSecret: true });
    assert.equal(defaults.agentrix.runnerId, 'cloud-main');
    assert.equal(defaults.agentrix.apiKey, 'agentrix-key');

    const config = await fetch(`${baseUrl}/api/agentrix/private-cloud?gitServerId=gitlab-main`, {
      headers: { Cookie: cookie },
    });
    assert.equal(config.status, 200);
    const configBody = await config.json();
    assert.equal(configBody.runnerGitlabTokens.length, 0);
    assert.equal(configBody.agentrix.serverUrl, 'https://agentrix.xmz.ai');
    assert.equal(configBody.agentrix.cliImage, 'registry.internal/agentrix/agentrix-cli:2026.07');
    assert.equal(configBody.llmProxy.apiKey, '');
  } finally {
    await app.close();
    await close(gitlab);
    await close(agentrix);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Agentrix private cloud requires event forward token before fetching runner secret', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN: process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN,
  };
  const requests = [];
  const gitlab = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/v4/user' && req.method === 'GET') {
      assert.equal(req.headers['private-token'], 'gl-bot-pat');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 7,
        username: 'issue-flow-bot',
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  delete process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN;

  const { app, baseUrl } = await listenApp(store);
  try {
    await store.createUser({ id: 'user-alice', displayName: 'Alice', email: 'alice@example.com' });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '101', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    const rejected = await fetch(`${baseUrl}/api/agentrix/private-cloud/gitlab-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `issue_flow_session_gitlab-main=${session.id}` },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
        runnerId: 'cloud-main',
        llmProxyApiKey: 'llm-proxy-key',
      }),
    });
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.equal(body.error, 'agentrix_forward_token_required');
    assert.deepEqual(requests, ['/api/v4/user']);
  } finally {
    await app.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Agentrix private cloud validates Bot PAT before fetching runner secret', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_AGENTRIX_BASE_URL: process.env.ISSUE_FLOW_AGENTRIX_BASE_URL,
  };
  const requests = [];
  const gitlab = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url === '/api/v4/user' && req.method === 'GET') {
      assert.equal(req.headers['private-token'], 'bad-bot-pat');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '403 Forbidden' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  const agentrix = http.createServer((req, res) => {
    requests.push(`agentrix:${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ secret: 'should-not-be-used' }));
  });
  const agentrixBase = await listen(agentrix);
  await seedGitlabServer(store, gitlabBase, { botPat: 'bad-bot-pat' });
  process.env.ISSUE_FLOW_AGENTRIX_BASE_URL = agentrixBase;

  const { app, baseUrl } = await listenApp(store);
  try {
    await store.createUser({ id: 'user-alice', displayName: 'Alice', email: 'alice@example.com' });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '101', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    const checked = await fetch(`${baseUrl}/api/agentrix/private-cloud/git-server/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `issue_flow_session_gitlab-main=${session.id}` },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
      }),
    });
    assert.equal(checked.status, 400);
    assert.equal((await checked.json()).error, 'runner_gitlab_bot_pat_invalid');
    assert.deepEqual(requests, ['/api/v4/user']);
    requests.length = 0;

    const rejected = await fetch(`${baseUrl}/api/agentrix/private-cloud/gitlab-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `issue_flow_session_gitlab-main=${session.id}` },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
        runnerId: 'cloud-main',
        llmProxyApiKey: 'llm-proxy-key',
      }),
    });
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.equal(body.error, 'runner_gitlab_bot_pat_invalid');
    assert.deepEqual(requests, ['/api/v4/user']);
    assert.equal((await store.listRunnerGitlabTokens({ userId: 'user-alice', gitServerId: 'gitlab-main' })).length, 0);
  } finally {
    await app.close();
    await close(gitlab);
    await close(agentrix);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('Agentrix private cloud rejects manual GitLab token input', async () => {
  const { dir, store } = tempStore();
  const requests = [];
  const gitlab = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, { adminPat: '' });
  const { app, baseUrl } = await listenApp(store);
  try {
    await store.createUser({ id: 'user-alice', displayName: 'Alice', email: 'alice@example.com' });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '101', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '101',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    const rejected = await fetch(`${baseUrl}/api/agentrix/private-cloud/gitlab-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `issue_flow_session_gitlab-main=${session.id}` },
      body: JSON.stringify({
        gitServerId: 'gitlab-main',
        runnerId: 'cloud-main',
        token: 'manual-token',
      }),
    });
    assert.equal(rejected.status, 400);
    const body = await rejected.json();
    assert.equal(body.error, 'runner_gitlab_token_manual_unsupported');
    assert.deepEqual(requests, []);
    assert.equal((await store.listRunnerGitlabTokens({ userId: 'user-alice', gitServerId: 'gitlab-main' })).length, 0);
  } finally {
    await app.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentrixAuthServer() {
  return http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer agentrix-key');
    if (req.url === '/v1/auth/me') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        user: {
          id: 'agx-user-1',
          username: 'alice',
          email: 'alice@agentrix.test',
          avatar: null,
          role: 'user',
          encryptedSecret: null,
          secretSalt: null,
          stripeCustomerId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function createInstallVariableGitlabServer({ variables = new Map(), writes = [], failKey = '' } = {}) {
  function variableKey(url) {
    return decodeURIComponent(String(url).split('/variables/')[1] || '');
  }
  function saveVariable(req, res, key) {
    if (key === failKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: `${key} write failed` }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const variableKeyValue = body.key || key;
      writes.push({ key: variableKeyValue, value: body.value });
      variables.set(variableKeyValue, {
        key: variableKeyValue,
        value: body.value,
        environment_scope: body.environment_scope || '*',
        variable_type: body.variable_type || 'env_var',
        masked: Boolean(body.masked),
      });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(variables.get(variableKeyValue)));
    });
  }
  return http.createServer((req, res) => {
    if (req.url === '/api/v4/user' && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 701, username: 'project_42_bot' }));
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'App', path_with_namespace: 'team/app', default_branch: 'main' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/701' && req.method === 'GET') {
      assert.equal(req.headers['private-token'], 'glpat-issue-flow-token-1234567890');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 701, username: 'project_42_bot', access_level: 40 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/access_tokens' && req.method === 'POST') {
      assert.equal(req.headers['private-token'], 'gl-admin-pat');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 701, name: 'issue-flow-test-token', token: 'glpat-issue-flow-token-1234567890' }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/issues?')
      || req.url.startsWith('/api/v4/projects/42/merge_requests?')
      || req.url.startsWith('/api/v4/projects/42/labels?')
      || req.url.startsWith('/api/v4/projects/42/variables?')) {
      assert.equal(req.headers['private-token'], 'glpat-issue-flow-token-1234567890');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'GET') {
      const variable = variables.get(variableKey(req.url));
      if (!variable) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '404 Variable Not Found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(variable));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'PUT') {
      saveVariable(req, res, variableKey(req.url));
      return;
    }
    if (req.url === '/api/v4/projects/42/variables' && req.method === 'POST') {
      saveVariable(req, res, '');
      return;
    }
    if (req.url.startsWith('/api/v4/groups/') && req.method === 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 Variable Not Found' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('GitLab settings checks variables independently and caches safe metadata', async () => {
  const { dir, store } = tempStore();
  const variables = new Map([
    ['AGENTRIX_BASE_URL', { key: 'AGENTRIX_BASE_URL', value: 'https://agentrix.xmz.ai', environment_scope: '*', variable_type: 'env_var' }],
    ['AGENTRIX_API_KEY', { key: 'AGENTRIX_API_KEY', environment_scope: '*', variable_type: 'env_var', masked: true }],
    ['AGENTRIX_ISSUE_FLOW_AGENT', { key: 'AGENTRIX_ISSUE_FLOW_AGENT', value: 'codex', environment_scope: '*', variable_type: 'env_var' }],
    ['ISSUE_FLOW_AUTO_DEFAULT', { key: 'ISSUE_FLOW_AUTO_DEFAULT', value: 'triage', environment_scope: '*', variable_type: 'env_var' }],
    ['ISSUE_FLOW_REVIEW_ENABLED', { key: 'ISSUE_FLOW_REVIEW_ENABLED', value: 'false', environment_scope: '*', variable_type: 'env_var' }],
  ]);
  let updatedVariable;
  let createdProjectToken = false;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user' && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 701, username: 'project_42_bot' }));
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET' && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, name: 'App', path_with_namespace: 'team/app', default_branch: 'main' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/701' && req.method === 'GET') {
      assert.equal(req.headers['private-token'], 'glpat-issue-flow-token-1234567890');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 701, username: 'project_42_bot', access_level: 40 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/access_tokens' && req.method === 'POST') {
      assert.equal(req.headers['private-token'], 'gl-admin-pat');
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.access_level, 40);
        assert.deepEqual(body.scopes, ['api']);
        assert.match(body.name, /^issue-flow-/);
        assert.match(body.expires_at, /^\d{4}-\d{2}-\d{2}$/);
        createdProjectToken = true;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 701, name: body.name, token: 'glpat-issue-flow-token-1234567890' }));
      });
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/issues?') && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/merge_requests?') && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/labels?') && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables?') && req.headers['private-token'] === 'glpat-issue-flow-token-1234567890') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'GET') {
      const key = decodeURIComponent(req.url.split('/').pop());
      const variable = variables.get(key);
      if (!variable) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: '404 Variable Not Found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(variable));
      return;
    }
    if (req.url === '/api/v4/projects/42/variables/ISSUE_FLOW_GITLAB_TOKEN' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.value, 'glpat-issue-flow-token-1234567890');
        assert.equal(body.masked, true);
        variables.set(body.key, {
          key: body.key,
          value: body.value,
          environment_scope: body.environment_scope,
          variable_type: body.variable_type,
          masked: body.masked,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(variables.get(body.key)));
      });
      return;
    }
    if (req.url.startsWith('/api/v4/groups/') && req.method === 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 Variable Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/variables/ISSUE_FLOW_AUTO_DEFAULT' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.value, 'build');
        assert.equal(body.environment_scope, '*');
        updatedVariable = body;
        variables.set(body.key, {
          key: body.key,
          value: body.value,
          environment_scope: body.environment_scope,
          variable_type: body.variable_type,
          masked: body.masked,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(variables.get(body.key)));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{
        id: '42',
        name: 'App',
        pathWithNamespace: 'team/app',
        defaultBranch: 'main',
      }],
    });
    const role = await getGitlabProjectRole({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(role.status, 200);
    assert.equal(role.body.access.role, 'Owner');
    assert.equal(role.body.access.canManage, true);

    const checked = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'variables' },
    });
    assert.equal(checked.status, 200);
    const apiKey = checked.body.steps[0].variables.find((item) => item.key === 'AGENTRIX_API_KEY');
    assert.equal(apiKey.status, 'passed');
    assert.equal(apiKey.detail, '已设置');
    assert.equal(apiKey.value, '*****');
    assert.equal(apiKey.scope, '*');
    const token = checked.body.steps[0].variables.find((item) => item.key === 'ISSUE_FLOW_GITLAB_TOKEN');
    assert.equal(token.status, 'pending_auto');
    assert.equal(token.autoWritable, true);
    assert.equal(token.blocker, false);
    const runnerId = checked.body.steps[0].variables.find((item) => item.key === 'AGENTRIX_RUNNER_ID');
    assert.equal(runnerId.status, 'manual_required');
    assert.equal(runnerId.required, true);
    assert.equal(runnerId.needsInput, true);
    assert.equal(runnerId.manualRequired, true);
    assert.equal(runnerId.blocker, true);
    assert.deepEqual(checked.body.steps[0].missing, ['ISSUE_FLOW_GITLAB_TOKEN']);
    assert.deepEqual(checked.body.steps[0].inputRequired, ['AGENTRIX_RUNNER_ID']);
    assert.deepEqual(checked.body.steps[0].blockers, ['AGENTRIX_RUNNER_ID']);
    assert.equal(checked.body.installable, false);
    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    const cachedApiKey = repo.settings.variables.items.find((item) => item.key === 'AGENTRIX_API_KEY');
    assert.equal(cachedApiKey.value, '*****');
    assert.equal(cachedApiKey.status, undefined);
    assert.equal(cachedApiKey.detail, undefined);
    assert.equal(await store.db.repoSettingItem.count({ where: { repoId: repo.id, kind: 'variable' } }), 5);

    const tokenCreated = await setGitlabProjectInstallVariable({
      store,
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        key: 'ISSUE_FLOW_GITLAB_TOKEN',
      },
    });
    assert.equal(tokenCreated.status, 200);
    assert.equal(createdProjectToken, true);
    assert.equal(tokenCreated.body.steps[0].status, 'needs_input');
    assert.deepEqual(tokenCreated.body.steps[0].missing, []);
    assert.deepEqual(tokenCreated.body.steps[0].inputRequired, ['AGENTRIX_RUNNER_ID']);
    assert.deepEqual(tokenCreated.body.steps[0].blockers, ['AGENTRIX_RUNNER_ID']);
    assert.equal(tokenCreated.body.variable.status, 'passed');
    assert.equal(tokenCreated.body.variable.value, '*****');
    assert.equal(tokenCreated.body.variable.detail, '已验证 GitLab API 权限');

    const saved = await setGitlabProjectInstallVariable({
      store,
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        key: 'ISSUE_FLOW_AUTO_DEFAULT',
        value: 'build',
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(updatedVariable.key, 'ISSUE_FLOW_AUTO_DEFAULT');
    assert.equal(saved.body.variable.value, 'build');
    const updated = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    assert.equal(updated.settings.variables.items.find((item) => item.key === 'ISSUE_FLOW_AUTO_DEFAULT').value, 'build');
    const persistedAuto = await store.db.repoSettingItem.findFirst({
      where: { repoId: updated.id, kind: 'variable', key: 'ISSUE_FLOW_AUTO_DEFAULT' },
    });
    assert.equal(persistedAuto.data.status, undefined);
    assert.equal(persistedAuto.data.value, 'build');
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install variables auto-configures writable rows before manual blockers', async () => {
  const { dir, store } = tempStore();
  const writes = [];
  const gitlab = createInstallVariableGitlabServer({ writes });
  const agentrix = createAgentrixAuthServer();
  const gitlabBase = await listen(gitlab);
  const agentrixBase = await listen(agentrix);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{ id: '42', name: 'App', pathWithNamespace: 'team/app', defaultBranch: 'main' }],
    });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '100', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '100',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    await store.saveUserAgentrixConfig('user:user-alice', {
      agentrix: { apiKey: 'agentrix-key' },
    });

    const result = await setGitlabProjectInstallVariable({
      store,
      session: await store.getSession(session.id),
      env: { ...process.env, ISSUE_FLOW_AGENTRIX_BASE_URL: agentrixBase },
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });

    assert.equal(result.status, 200);
    const step = result.body.steps[0];
    const byKey = new Map(step.variables.map((item) => [item.key, item]));
    assert.equal(step.status, 'needs_input');
    assert.deepEqual(step.missing, []);
    assert.deepEqual(step.inputRequired, ['AGENTRIX_RUNNER_ID']);
    assert.deepEqual(step.blockers, ['AGENTRIX_RUNNER_ID']);
    assert.equal(result.body.installable, false);
    for (const key of [
      'ISSUE_FLOW_GITLAB_TOKEN',
      'AGENTRIX_BASE_URL',
      'AGENTRIX_API_KEY',
      'AGENTRIX_ISSUE_FLOW_AGENT',
      'ISSUE_FLOW_AUTO_DEFAULT',
      'ISSUE_FLOW_REVIEW_ENABLED',
    ]) {
      assert.equal(byKey.get(key).status, 'passed', key);
      assert.equal(byKey.get(key).blocker, false, key);
    }
    assert.equal(byKey.get('AGENTRIX_API_KEY').value, '*****');
    assert.equal(byKey.get('ISSUE_FLOW_AUTO_DEFAULT').value, 'triage');
    assert.equal(byKey.get('ISSUE_FLOW_REVIEW_ENABLED').value, 'false');
    assert.equal(byKey.get('AGENTRIX_RUNNER_ID').status, 'manual_required');
    assert.equal(byKey.get('AGENTRIX_RUNNER_ID').blocker, true);
    assert.deepEqual(writes.map((item) => item.key).sort(), [
      'AGENTRIX_API_KEY',
      'AGENTRIX_BASE_URL',
      'AGENTRIX_ISSUE_FLOW_AGENT',
      'ISSUE_FLOW_AUTO_DEFAULT',
      'ISSUE_FLOW_GITLAB_TOKEN',
      'ISSUE_FLOW_REVIEW_ENABLED',
    ].sort());
  } finally {
    await close(gitlab);
    await close(agentrix);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install variable write failure marks only that row failed', async () => {
  const { dir, store } = tempStore();
  const writes = [];
  const gitlab = createInstallVariableGitlabServer({ writes, failKey: 'AGENTRIX_BASE_URL' });
  const agentrix = createAgentrixAuthServer();
  const gitlabBase = await listen(gitlab);
  const agentrixBase = await listen(agentrix);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{ id: '42', name: 'App', pathWithNamespace: 'team/app', defaultBranch: 'main' }],
    });
    const session = await store.createSession({
      userId: 'user-alice',
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
      user: { id: '100', username: 'alice', name: 'Alice' },
      account: {
        provider: 'gitlab',
        gitServerId: 'gitlab-main',
        providerUserId: '100',
        username: 'alice',
        displayName: 'Alice',
      },
      token: 'gl-oauth-user-token',
    });
    await store.saveUserAgentrixConfig('user:user-alice', {
      agentrix: { apiKey: 'agentrix-key', runnerId: 'cloud-main' },
    });

    const result = await setGitlabProjectInstallVariable({
      store,
      session: await store.getSession(session.id),
      env: { ...process.env, ISSUE_FLOW_AGENTRIX_BASE_URL: agentrixBase },
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        agentrix: { runnerId: 'cloud-main' },
      },
    });

    assert.equal(result.status, 200);
    const step = result.body.steps[0];
    const byKey = new Map(step.variables.map((item) => [item.key, item]));
    assert.equal(step.status, 'failed');
    assert.deepEqual(step.blockers, ['AGENTRIX_BASE_URL']);
    assert.deepEqual(step.inputRequired, []);
    assert.deepEqual(step.missing, []);
    assert.equal(result.body.installable, false);
    assert.equal(byKey.get('AGENTRIX_BASE_URL').status, 'failed');
    assert.equal(byKey.get('AGENTRIX_BASE_URL').blocker, true);
    assert.match(byKey.get('AGENTRIX_BASE_URL').detail, /HTTP_500/);
    for (const key of [
      'ISSUE_FLOW_GITLAB_TOKEN',
      'AGENTRIX_API_KEY',
      'AGENTRIX_RUNNER_ID',
      'AGENTRIX_ISSUE_FLOW_AGENT',
      'ISSUE_FLOW_AUTO_DEFAULT',
      'ISSUE_FLOW_REVIEW_ENABLED',
    ]) {
      assert.equal(byKey.get(key).status, 'passed', key);
      assert.equal(byKey.get(key).blocker, false, key);
    }
  } finally {
    await close(gitlab);
    await close(agentrix);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab settings checks project runners for issue-flow tag', async () => {
  const { dir, store } = tempStore();
  let runners = [
    { id: 1, description: 'issue flow runner', active: true, paused: false, status: 'online' },
  ];
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/runners' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(runners));
      return;
    }
    if (req.url === '/api/v4/runners/1' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, active: true, paused: false, status: 'online', short_sha: 'bXP7WASs', tag_list: ['issue-flow', 'shell'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const created = await store.createRepository({
      gitServerId: 'gitlab-main',
      projectId: '42',
      projectPath: 'team/app',
      defaultBranch: 'main',
      webUrl: `${gitlabBase}/team/app`,
    });
    const matched = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'runners' },
    });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.steps[0].id, 'runners');
    assert.equal(matched.body.steps[0].status, 'passed');
    assert.equal(matched.body.repository.settings.runners.items[0].name, 'issue flow runner');
    assert.equal(matched.body.repository.settings.runners.items[0].shortToken, 'bXP7WASs');
    let cached = await store.getRepository(created.repo.id);
    assert.equal(cached.settings.runners.items[0].name, 'issue flow runner');
    assert.equal(cached.settings.runners.items[0].shortToken, 'bXP7WASs');
    assert.equal(cached.settings.runners.items[0].status, 'passed');

    runners = [
      { id: 2, description: 'generic runner', active: true, paused: false, status: 'online', tag_list: ['shell'] },
      { id: 3, description: 'paused issue flow runner', active: true, paused: true, status: 'online', tag_list: ['issue-flow'] },
    ];
    const missing = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'runners' },
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.steps[0].status, 'needs_action');
    assert.match(missing.body.steps[0].detail, /issue-flow tag/);
    cached = await store.getRepository(created.repo.id);
    assert.equal(cached.settings.runners.items[0].status, 'needs_action');
    assert.equal(cached.settings.runners.items[0].name, '');
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab runner setup enables project group and instance runner switches', async () => {
  const { dir, store } = tempStore();
  let sharedRunnersEnabled = false;
  let groupRunnersEnabled = false;
  let updateSeen = false;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        shared_runners_enabled: sharedRunnersEnabled,
        group_runners_enabled: groupRunnersEnabled,
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.shared_runners_enabled, true);
        assert.equal(body.group_runners_enabled, true);
        sharedRunnersEnabled = true;
        groupRunnersEnabled = true;
        updateSeen = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 42, path_with_namespace: 'team/app', shared_runners_enabled: true, group_runners_enabled: true }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/runners' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sharedRunnersEnabled && groupRunnersEnabled
        ? [{ id: 1, active: true, paused: false, status: 'online', tag_list: ['issue-flow'], runner_type: 'instance_type' }]
        : []));
      return;
    }
    if (req.url.startsWith('/api/v4/runners?') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const result = await setGitlabProjectInstallRunner({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.steps[0].status, 'passed');
    assert.equal(updateSeen, true);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab runner setup assigns matching project runner when available', async () => {
  const { dir, store } = tempStore();
  let assigned = false;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        shared_runners_enabled: true,
        group_runners_enabled: true,
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/runners' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(assigned ? [{ id: 9, active: true, paused: false, status: 'online', tag_list: ['issue-flow'], runner_type: 'project_type' }] : []));
      return;
    }
    if (req.url.startsWith('/api/v4/runners?') && req.method === 'GET') {
      assert.match(req.url, /tag_list=issue-flow/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 9, active: true, paused: false, status: 'online', tag_list: ['issue-flow'], runner_type: 'project_type', locked: false }]));
      return;
    }
    if (req.url === '/api/v4/projects/42/runners' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(JSON.parse(raw).runner_id, '9');
        assigned = true;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const result = await setGitlabProjectInstallRunner({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.steps[0].status, 'passed');
    assert.equal(assigned, true);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install check stops when admin PAT cannot manage the repo', async () => {
  const { dir, store } = tempStore();
  let unexpectedFollowup = false;
  let adminAccessLevel = 30;
  let memberPostCount = 0;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user' && req.headers.authorization === 'Bearer gl-oauth-user-token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/user' && req.headers['private-token'] === 'gl-admin-pat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 200, username: 'issue-flow-bot', name: 'Issue Flow Bot', email: 'bot@example.com' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      if (req.headers.authorization === 'Bearer gl-oauth-user-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 42,
          name: 'App',
          path_with_namespace: 'team/app',
          web_url: `${gitlabBase}/team/app`,
          default_branch: 'main',
        }));
        return;
      }
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/200' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 200, username: 'issue-flow-bot', access_level: adminAccessLevel }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(body.user_id, '200');
        assert.equal(body.access_level, 40);
        memberPostCount += 1;
        adminAccessLevel = 40;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 200, username: 'issue-flow-bot', access_level: adminAccessLevel }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' || req.url.startsWith('/api/v4/projects/42/variables/')) {
      unexpectedFollowup = true;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{
        id: '42',
        name: 'App',
        pathWithNamespace: 'team/app',
        webUrl: `${gitlabBase}/team/app`,
        defaultBranch: 'main',
      }],
    });

    const checked = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.installable, false);
    assert.equal(checked.body.steps.length, 1);
    assert.equal(checked.body.steps[0].id, 'permissions');
    assert.equal(checked.body.steps[0].status, 'blocked');
    assert.match(checked.body.steps[0].detail, /Issue Flow Bot/);
    assert.equal(checked.body.steps[0].memberUrl, `${gitlabBase}/team/app/-/project_members`);
    assert.equal(unexpectedFollowup, false);

    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    const cached = repo.settings.permissions.items[0];
    assert.equal(cached.username, 'issue-flow-bot');
    assert.equal(cached.email, 'bot@example.com');
    assert.equal(cached.role, 'Developer');
    assert.equal(cached.canManage, false);
    assert.equal(cached.status, undefined);

    const fixed = await setGitlabProjectInstallPermission({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(fixed.status, 200);
    assert.equal(memberPostCount, 1);
    assert.equal(fixed.body.steps[0].status, 'passed');
    assert.equal(fixed.body.permission.role, 'Maintainer');

    const updated = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    assert.equal(updated.settings.permissions.items[0].role, 'Maintainer');
    assert.equal(updated.settings.permissions.items[0].canManage, true);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab webhook check only caches hooks matched from GitLab', async () => {
  const { dir, store } = tempStore();
  let expectedWebhookUrl = '';
  let hooks = [];
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(hooks));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{
        id: '42',
        name: 'App',
        pathWithNamespace: 'team/app',
        defaultBranch: 'main',
      }],
    });
    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    expectedWebhookUrl = `https://issue-flow.internal/webhooks/gitlab/${repo.id}`;
    hooks = [{
      id: 9001,
      url: expectedWebhookUrl,
      issues_events: true,
      note_events: true,
      merge_requests_events: true,
      pipeline_events: true,
      job_events: true,
      enable_ssl_verification: true,
    }];

    const matched = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'webhook' },
    });
    assert.equal(matched.status, 200);
    assert.equal(matched.body.steps[0].status, 'passed');
    assert.equal(matched.body.steps[0].detail, expectedWebhookUrl);
    const cached = await store.db.repoSettingItem.findFirst({
      where: { repoId: repo.id, kind: 'webhook', key: 'issue-flow' },
    });
    assert.equal(cached.data.url, expectedWebhookUrl);
    assert.equal(cached.data.hookId, '9001');

    hooks = [];
    const missing = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'webhook' },
    });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.steps[0].status, 'needs_action');
    assert.equal(await store.db.repoSettingItem.count({
      where: { repoId: repo.id, kind: 'webhook', key: 'issue-flow' },
    }), 0);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab webhook auto configure creates hook and caches returned GitLab facts', async () => {
  const { dir, store } = tempStore();
  let expectedWebhookUrl = '';
  const calls = [];
  const gitlab = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        assert.equal(body.url, expectedWebhookUrl);
        assert.equal(body.token, 'backend-webhook-secret');
        assert.equal(body.issues_events, true);
        assert.equal(body.note_events, true);
        assert.equal(body.merge_requests_events, true);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 9101,
          url: body.url,
          issues_events: true,
          note_events: true,
          merge_requests_events: true,
          pipeline_events: true,
          job_events: true,
          enable_ssl_verification: true,
          created_at: '2026-07-01T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{
        id: '42',
        name: 'App',
        pathWithNamespace: 'team/app',
        defaultBranch: 'main',
      }],
    });
    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    expectedWebhookUrl = `https://issue-flow.internal/webhooks/gitlab/${repo.id}`;

    const configured = await setGitlabProjectInstallWebhook({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42' },
    });
    assert.equal(configured.status, 200);
    assert.equal(configured.body.step.status, 'passed');
    assert.equal(configured.body.step.detail, expectedWebhookUrl);
    assert.equal(configured.body.webhook.hookId, '9101');
    assert.equal(configured.body.repository.webhook.hookId, '9101');

    const cached = await store.db.repoSettingItem.findFirst({
      where: { repoId: repo.id, kind: 'webhook', key: 'issue-flow' },
    });
    assert.equal(cached.data.url, expectedWebhookUrl);
    assert.equal(cached.data.hookId, '9101');
    assert.equal(cached.data.issuesEvents, true);
    assert.deepEqual(calls, [
      'GET /api/v4/user',
      'GET /api/v4/projects/42',
      'GET /api/v4/projects/42/members/all/100',
      'GET /api/v4/projects/42/hooks',
      'POST /api/v4/projects/42/hooks',
    ]);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab plugin check reads only install manifest and caches version facts', async () => {
  const { dir, store } = tempStore();
  const manifest = {
    version: 1,
    issueFlowVersion: '0.1.0',
    provider: 'gitlab',
    runtime: 'agentrix',
    files: {},
  };
  let manifestReads = 0;
  let mergeRequestReads = 0;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/members/all/100' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', access_level: 50 }));
      return;
    }
    if (req.url === '/api/v4/projects/42/merge_requests/9' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      mergeRequestReads += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ iid: 9, state: 'closed' }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/')) {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/api/v4/projects/42/repository/files/.issue-flow%2Finstall-manifest.json?ref=main');
      manifestReads += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: '.issue-flow/install-manifest.json',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify(manifest)).toString('base64'),
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const user = await store.createUser({ id: 'user-alice', displayName: 'Alice' });
    await store.syncRepositories({
      gitServerId: 'gitlab-main',
      userId: user.id,
      projects: [{
        id: '42',
        name: 'App',
        pathWithNamespace: 'team/app',
        defaultBranch: 'main',
      }],
    });

    const checked = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'plugins' },
    });
    assert.equal(checked.status, 200);
    assert.equal(manifestReads, 1);
    assert.equal(checked.body.steps.length, 1);
    assert.equal(checked.body.steps[0].id, 'plugins');
    assert.equal(checked.body.steps[0].status, 'needs_action');
    assert.equal(checked.body.steps[0].plugins[0].status, 'needs_action');
    assert.equal(checked.body.steps[0].plugins[0].installedVersion, '0.1.0');
    assert.equal(checked.body.steps[0].plugins[0].needsUpgrade, true);

    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    assert.equal(repo.settings.plugins.items.length, 1);
    assert.equal(repo.settings.plugins.items[0].key, 'issue-flow');
    assert.equal(repo.settings.plugins.items[0].installedVersion, '0.1.0');
    assert.equal(repo.settings.plugins.items[0].status, 'needs_action');
    assert.equal(await store.db.repoSettingItem.count({ where: { repoId: repo.id, kind: 'plugin', key: 'issue-flow' } }), 1);

    await store.updateRepositorySettingsCache(repo.id, {
      plugins: {
        items: [{
          ...repo.settings.plugins.items[0],
          pendingMergeRequest: {
            iid: '9',
            webUrl: `${gitlabBase}/team/app/-/merge_requests/9`,
            sourceBranch: 'issue-flow/upgrade-123',
          },
        }],
        checkedAt: new Date().toISOString(),
      },
    });
    const stalePending = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'plugins' },
    });
    assert.equal(stalePending.status, 200);
    assert.equal(mergeRequestReads, 1);
    assert.equal(manifestReads, 2);
    assert.equal(stalePending.body.steps[0].plugins[0].pendingMergeRequest, undefined);

    delete manifest.issueFlowVersion;
    const unknown = await checkGitlabProjectInstall({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token', projectId: '42', checkType: 'plugins' },
    });
    assert.equal(unknown.status, 200);
    assert.equal(manifestReads, 3);
    assert.equal(unknown.body.steps[0].status, 'needs_action');
    assert.equal(unknown.body.steps[0].detail, `未知版本 -> ${packageVersion}`);
    assert.equal(unknown.body.steps[0].plugins[0].installedVersion, '');
    assert.equal(unknown.body.steps[0].plugins[0].status, 'needs_action');
    assert.equal(unknown.body.steps[0].plugins[0].needsUpgrade, true);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab token validation uses project token without exposing it in result', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers['private-token'], 'glpat-validation-token');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-OAuth-Scopes': 'api, read_api',
      });
      res.end(JSON.stringify({ username: 'alice' }));
      return;
    }
    if (req.url === '/api/v4/projects/team%2Fapp') {
      assert.equal(req.headers['private-token'], 'glpat-validation-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, default_branch: 'main' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const result = await validateGitlabToken({
      apiUrl: `${baseUrl}/api/v4`,
      projectPath: 'team/app',
      token: 'glpat-validation-token',
    });
    assert.equal(result.status, 'valid');
    assert.equal(result.username, 'alice');
    assert.equal(result.projectId, '42');
    assert.equal(result.defaultBranch, 'main');
    assert.deepEqual(result.scopes, ['api', 'read_api']);
    assert.doesNotMatch(JSON.stringify(result), /glpat-validation-token/);
  } finally {
    await close(server);
  }
});

test('GitLab webhook upsert updates an existing hook by URL when hook id is unknown', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { id: 7007, url: 'https://issue-flow.internal/webhooks/gitlab/repo_existing' },
      ]));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks/7007' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        assert.equal(body.url, 'https://issue-flow.internal/webhooks/gitlab/repo_existing');
        assert.equal(body.token, 'backend-webhook-secret');
        assert.equal(body.issues_events, true);
        assert.equal(body.note_events, true);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 7007 }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'POST') {
      assert.fail('matching hook should be updated instead of creating a duplicate');
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const hook = await upsertGitlabWebhook({
      apiUrl: `${baseUrl}/api/v4`,
      token: 'gl-oauth-user-token',
      authType: 'bearer',
      projectIdOrPath: '42',
      webhookUrl: 'https://issue-flow.internal/webhooks/gitlab/repo_existing',
      webhookSecret: 'backend-webhook-secret',
    });
    assert.equal(hook.id, 7007);
    assert.deepEqual(calls, [
      'GET /api/v4/projects/42/hooks',
      'PUT /api/v4/projects/42/hooks/7007',
    ]);
  } finally {
    await close(server);
  }
});

test('GitLab OAuth flow stores session token server-side and project APIs use the session cookie', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_APP_URL: process.env.ISSUE_FLOW_APP_URL,
  };
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        assert.equal(body.get('client_id'), 'oauth-client');
        assert.equal(body.get('client_secret'), 'oauth-secret');
        assert.equal(body.get('code'), 'oauth-code');
        assert.match(body.get('redirect_uri'), /\/api\/auth\/gitlab\/callback$/);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'gl-oauth-session-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'api',
          expires_in: 3600,
        }));
      });
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, {
    oauthClientId: 'oauth-client',
    oauthClientSecret: 'oauth-secret',
    webhookSecret: 'backend-webhook-secret',
  });
  process.env.ISSUE_FLOW_APP_URL = 'http://web.local';

  const { app: apiApp, baseUrl } = await listenApp(store);
  try {
    const authorize = await fetch(`${baseUrl}/api/auth/gitlab/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitServerId: 'gitlab-main', returnTo: '/repos' }),
    });
    assert.equal(authorize.status, 200);
    assert.equal(authorize.headers.get('set-cookie'), null);
    const authorizeBody = await authorize.json();
    const location = new URL(authorizeBody.authorizeUrl);
    assert.equal(location.origin, gitlabBase);
    assert.equal(location.pathname, '/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'oauth-client');
    const state = location.searchParams.get('state');
    assert.match(state || '', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const callback = await fetch(`${baseUrl}/api/auth/gitlab/callback?code=oauth-code&state=${state}`, {
      redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://web.local/repos?gitlab=connected');
    const sessionCookie = callback.headers.get('set-cookie');
    assert.match(sessionCookie, /issue_flow_user=/);
    assert.match(sessionCookie, /issue_flow_session_gitlab-main=/);
    assert.doesNotMatch(sessionCookie, /gl-oauth-session-token/);

    const session = await fetch(`${baseUrl}/api/session?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.user.username, 'alice');
    assert.equal(sessionBody.session.gitServerId, 'gitlab-main');
    assert.doesNotMatch(JSON.stringify(sessionBody), /gl-oauth-session-token/);

    const repositoriesBeforeExplicitSync = await fetch(`${baseUrl}/api/repositories?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(repositoriesBeforeExplicitSync.status, 200);
    assert.doesNotMatch(JSON.stringify(await repositoriesBeforeExplicitSync.json()), /gl-oauth-session-token/);

    const projects = await fetch(`${baseUrl}/api/gitlab/projects?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(projects.status, 200);
    const projectsBody = await projects.json();
    assert.equal(projectsBody.projects[0].pathWithNamespace, 'team/app');
    assert.equal(projectsBody.projects[0].canInstall, true);
    assert.doesNotMatch(JSON.stringify(projectsBody), /gl-oauth-session-token/);

    const repositories = await fetch(`${baseUrl}/api/repositories?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(repositories.status, 200);
    const repositoriesBody = await repositories.json();
    assert.equal(repositoriesBody.repositories[0].projectPath, 'team/app');
    assert.doesNotMatch(JSON.stringify(repositoriesBody), /gl-oauth-session-token/);
  } finally {
    await apiApp.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('GitLab OAuth callback does not wait for repository sync', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_APP_URL: process.env.ISSUE_FLOW_APP_URL,
  };
  let releaseProjects;
  let markProjectsRequested;
  const projectsCanRespond = new Promise((resolve) => { releaseProjects = resolve; });
  const projectsRequested = new Promise((resolve) => { markProjectsRequested = resolve; });
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        assert.equal(body.get('client_id'), 'oauth-client');
        assert.equal(body.get('client_secret'), 'oauth-secret');
        assert.equal(body.get('code'), 'oauth-code');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'gl-oauth-session-token',
          refresh_token: 'refresh-token',
          token_type: 'Bearer',
          scope: 'api',
          expires_in: 3600,
        }));
      });
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      markProjectsRequested();
      projectsCanRespond.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{
          id: 42,
          name: 'App',
          path_with_namespace: 'team/app',
          default_branch: 'main',
          permissions: { project_access: { access_level: 40 } },
        }]));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, {
    oauthClientId: 'oauth-client',
    oauthClientSecret: 'oauth-secret',
  });
  process.env.ISSUE_FLOW_APP_URL = 'http://web.local';

  const { app: apiApp, baseUrl } = await listenApp(store);
  try {
    const authorize = await fetch(`${baseUrl}/api/auth/gitlab/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitServerId: 'gitlab-main', returnTo: '/repos' }),
    });
    assert.equal(authorize.status, 200);
    const state = new URL((await authorize.json()).authorizeUrl).searchParams.get('state');

    const callbackPromise = fetch(`${baseUrl}/api/auth/gitlab/callback?code=oauth-code&state=${state}`, {
      redirect: 'manual',
    });
    await projectsRequested;
    const callbackBeforeProjectsResponse = await Promise.race([
      callbackPromise,
      new Promise((resolve) => setTimeout(() => resolve(undefined), 200)),
    ]);
    releaseProjects();
    assert.ok(callbackBeforeProjectsResponse, 'OAuth callback should return before GitLab projects responds');

    const callback = callbackBeforeProjectsResponse || await callbackPromise;
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), 'http://web.local/repos?gitlab=connected');

    const user = await store.db.user.findFirst({ where: { displayName: 'Alice' } });
    await waitFor(async () => {
      const { repositories: repos } = await store.listRepositories({ gitServerId: 'gitlab-main', userId: user && user.id });
      return repos.length === 1 && repos[0].projectPath === 'team/app';
    });
  } finally {
    releaseProjects();
    await apiApp.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('GitLab OAuth skips repository sync for existing git accounts', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_APP_URL: process.env.ISSUE_FLOW_APP_URL,
  };
  let tokenRequests = 0;
  let projectRequests = 0;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        tokenRequests += 1;
        const body = new URLSearchParams(raw);
        assert.equal(body.get('client_id'), 'oauth-client');
        assert.equal(body.get('client_secret'), 'oauth-secret');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `gl-oauth-session-token-${tokenRequests}`,
          refresh_token: `refresh-token-${tokenRequests}`,
          token_type: 'Bearer',
          scope: 'api',
          expires_in: 3600,
        }));
      });
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.match(req.headers.authorization || '', /^Bearer gl-oauth-session-token-/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 100, username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      projectRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, {
    oauthClientId: 'oauth-client',
    oauthClientSecret: 'oauth-secret',
  });
  process.env.ISSUE_FLOW_APP_URL = 'http://web.local';

  const { app: apiApp, baseUrl } = await listenApp(store);
  async function loginOnce() {
    const authorize = await fetch(`${baseUrl}/api/auth/gitlab/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitServerId: 'gitlab-main', returnTo: '/repos' }),
    });
    assert.equal(authorize.status, 200);
    const state = new URL((await authorize.json()).authorizeUrl).searchParams.get('state');
    const callback = await fetch(`${baseUrl}/api/auth/gitlab/callback?code=oauth-code&state=${state}`, {
      redirect: 'manual',
    });
    assert.equal(callback.status, 302);
    return callback;
  }

  try {
    await loginOnce();
    await waitFor(() => projectRequests === 1);
    await loginOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(projectRequests, 1);

    const account = await store.findUserGitAccount({
      provider: 'gitlab',
      gitServerId: 'gitlab-main',
      providerUserId: '100',
    });
    assert.equal(account.username, 'alice');
  } finally {
    await apiApp.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('GitLab API routes refresh expired OAuth session before using it', async () => {
  const { dir, store } = tempStore();
  let refreshCalled = false;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/oauth/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = new URLSearchParams(raw);
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'expired-refresh');
        refreshCalled = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'fresh-oauth-token',
          refresh_token: 'fresh-refresh-token',
          scope: 'api',
          expires_in: 3600,
        }));
      });
      return;
    }
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer fresh-oauth-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer fresh-oauth-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, {
    oauthClientId: 'oauth-client',
    oauthClientSecret: 'oauth-secret',
  });
  const user = await store.createUser({ displayName: 'Alice' });
  const session = await store.createSession({
    userId: user.id,
    token: 'expired-oauth-token',
    refreshToken: 'expired-refresh',
    gitServerId: 'gitlab-main',
    gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
    user: { username: 'alice', name: 'Alice' },
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const { app: apiApp, baseUrl } = await listenApp(store);
  try {
    const response = await fetch(`${baseUrl}/api/gitlab/projects?gitServerId=gitlab-main`, {
      headers: { Cookie: `issue_flow_session_gitlab-main=${session.id}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects[0].pathWithNamespace, 'team/app');
    assert.equal(refreshCalled, true);
    const saved = await store.getSession(session.id);
    assert.equal(saved.token, 'fresh-oauth-token');
    assert.equal(saved.refreshToken, 'fresh-refresh-token');
  } finally {
    await apiApp.close();
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab project list keeps unknown access non-installable when detail permission is unavailable', async () => {
  const { dir, store } = tempStore();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 42,
          name: 'Installable',
          path_with_namespace: 'team/installable',
          default_branch: 'main',
        },
        {
          id: 43,
          name: 'Unknown',
          path_with_namespace: 'team/unknown',
          default_branch: 'main',
        },
      ]));
      return;
    }
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'Installable',
        path_with_namespace: 'team/installable',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }));
      return;
    }
    if (req.url === '/api/v4/projects/43' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '403 Forbidden' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  await seedGitlabServer(store, baseUrl);
  try {
    const projects = await listGitlabProjectsWithInstallStatus({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token' },
    });
    assert.equal(projects.status, 200);
    assert.equal(projects.body.projects.find((project) => project.id === '42').canInstall, true);
    assert.equal(projects.body.projects.find((project) => project.id === '43').canInstall, false);
    assert.equal(projects.body.projects.find((project) => project.id === '43').permissionStatus, 'unknown');
  } finally {
    await close(server);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
