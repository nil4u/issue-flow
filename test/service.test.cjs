const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const envPath = path.join(__dirname, '..', '.env.dev');
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
require('tsx/cjs');

const { createApp } = require('../apps/api/src/app.ts');
const { IssueFlowStore } = require('../apps/api/src/core/store.ts');
const { installGitlabBootstrap } = require('../apps/api/src/core/gitlab-bootstrap.ts');
const { normalizeGitLabWebhook } = require('@xmz-ai/gitlab-webhook-bridge');
const { upsertGitlabWebhook, validateGitlabToken } = require('../apps/api/src/core/gitlab.ts');
const { buildDispatchOptions } = require('../apps/api/src/core/dispatcher.ts');
const { getUserAgentrixConfig } = require('../apps/api/src/core/user-agentrix-config.ts');
const { handleGitlabWebhook } = require('../apps/api/src/core/gitlab-webhook.ts');
const { applyGitEventToIssueFacts } = require('../apps/api/src/core/issue-projection.ts');
const { connectGitlabSession } = require('../apps/api/src/core/gitlab-auth.ts');
const {
  checkGitlabProjectInstall,
  getGitlabProjectRole,
  installGitlabProject,
  listGitlabProjectsWithInstallStatus,
  setGitlabProjectInstallVariable,
  setGitlabProjectInstallWebhook,
} = require('../apps/api/src/core/gitlab-projects.ts');
const { syncIssuesSnapshot } = require('../apps/api/src/core/repositories.ts');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

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

function setCookieToCookieHeader(value = '') {
  return String(value || '')
    .split(/,\s*(?=[^;,]+=)/)
    .map((part) => part.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function handleGitlabLabelSync(req, res, options = {}) {
  if (req.url.startsWith('/api/v4/projects/42/labels/') && req.method === 'GET') {
    if (options.token) {
      assert.equal(req.headers.authorization, `Bearer ${options.token}`);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '404 Label Not Found' }));
    return true;
  }
  if (req.url === '/api/v4/projects/42/labels' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (options.token) {
        assert.equal(req.headers.authorization, `Bearer ${options.token}`);
      }
      assert.doesNotMatch(raw, /gl-oauth-user-token|agentrix-secret-key|agentrix-default-key|agentrix-upgrade-key/);
      const body = JSON.parse(raw);
      assert.match(body.name, /::/);
      assert.match(body.color, /^#[0-9A-F]{6}$/i);
      if (options.seen) {
        options.seen.push(body.name);
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: body.name, color: body.color, description: body.description || '' }));
    });
    return true;
  }
  return false;
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
      redirectUri: options.oauthRedirectUri || '',
      scopes: options.oauthScopes || 'api read_repository write_repository openid profile email',
    },
    webhook: {
      secret: options.webhookSecret || 'backend-webhook-secret',
    },
    agentrixGitServerId: options.agentrixGitServerId || 'agentrix-gitlab-main',
    adminPat: options.adminPat || 'gl-admin-pat',
  });
}

test('API service requires ISSUE_FLOW_BASE_URL at startup', async () => {
  const previous = process.env.ISSUE_FLOW_BASE_URL;
  delete process.env.ISSUE_FLOW_BASE_URL;
  try {
    await assert.rejects(
      () => createApp({ store: { ready: Promise.resolve() } }),
      /ISSUE_FLOW_BASE_URL is required/
    );
  } finally {
    process.env.ISSUE_FLOW_BASE_URL = previous;
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
        redirectUri: 'https://issue-flow.internal/api/auth/gitlab/callback',
        scopes: 'api read_user openid profile email',
      },
      webhook: {
        secret: 'webhook-secret',
      },
      agentrixGitServerId: 'agentrix-main',
      adminPat: 'admin-pat-secret',
    });
    assert.equal(server.id, 'gitlab-main');
    assert.equal(server.type, 'gitlab');
    assert.equal(server.oauth.clientSecret, 'oauth-secret');
    assert.equal(server.webhook.secret, 'webhook-secret');
    assert.equal(server.agentrixGitServerId, 'agentrix-main');
    assert.equal(server.adminPat, 'admin-pat-secret');

    const row = await store.db.gitServer.findUnique({ where: { id: 'gitlab-main' } });
    const raw = JSON.stringify(row);
    assert.equal(row.oauthClientId, 'oauth-client');
    assert.equal(row.baseUrl, 'https://gitlab.example.com');
    assert.equal(row.apiUrl, 'https://gitlab.example.com/api/v4');
    assert.equal(row.oauthScopes, 'api read_user openid profile email');
    assert.equal(row.agentrixGitServerId, 'agentrix-main');
    assert.equal(row.adminPat, 'admin-pat-secret');
    assert.match(raw, /oauth-secret/);
    assert.match(raw, /webhook-secret/);
    assert.match(raw, /admin-pat-secret/);

    const publicServer = await store.getGitServer('gitlab-main');
    assert.equal(publicServer.oauth.clientSecret, undefined);
    assert.equal(publicServer.webhook.secret, undefined);
    assert.equal(publicServer.adminPat, undefined);
    assert.equal(publicServer.oauth.clientSecretFingerprint.length, 12);
    assert.equal(publicServer.webhook.secretFingerprint.length, 12);
    assert.equal(publicServer.adminPatFingerprint.length, 12);

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
        redirectUri: 'https://issue-flow.internal/api/auth/gitlab/callback',
        scopes: 'api read_user openid profile email',
      },
      webhook: {
        secret: 'webhook-secret-2',
      },
      adminPat: 'admin-pat-secret-2',
    });
    const updated = await store.getGitServer('gitlab-main', { includeSecret: true });
    assert.equal(updated.oauth.clientSecret, 'oauth-secret-2');
    assert.equal(updated.webhook.secret, 'webhook-secret-2');
    assert.equal(updated.agentrixGitServerId, 'agentrix-main');
    assert.equal(updated.adminPat, 'admin-pat-secret-2');
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
        oauthRedirectUri: 'http://127.0.0.1:8788/api/auth/gitlab/callback',
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
    const user = await store.getUser(first.user.id, { includeAccounts: true });

    assert.equal(second.user.id, first.user.id);
    assert.equal(user.accounts.length, 2);
    assert.deepEqual(user.accounts.map((account) => account.gitServerId).sort(), ['github-main', 'gitlab-main']);
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
    assert.equal(issues[0].status, 'done');
    assert.equal(issues[0].closedAt, '2026-07-01T03:00:00.000Z');
    assert.equal(spans.length, 2);
    assert.equal(spans[1].exitedAt, '2026-07-01T03:00:00.000Z');
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
    assert.equal(result.body.count, 2);
    const issues = await store.listIssues(createdRepo.repo.id);
    const spans = await store.listIssueSpans(createdRepo.repo.id);
    assert.deepEqual(issues.map((issue) => `${issue.issueNumber}:${issue.status}`), ['9:active', '10:done']);
    assert.equal(issues[0].title, 'Existing issue');
    assert.equal(issues[0].type, 'feature');
    assert.equal(issues[0].priority, 'P2');
    assert.equal(issues[0].size, 'L');
    assert.equal(issues[0].automation, 'plan');
    assert.equal(issues[1].closedAt, '2026-07-01T06:00:00.000Z');
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

test('API service exposes health and repository list over HTTP', async () => {
  const { dir, store } = tempStore();
  const { app, baseUrl } = await listenApp(store);
  try {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const repositories = await fetch(`${baseUrl}/api/repositories`);
    assert.equal(repositories.status, 200);
    assert.deepEqual(await repositories.json(), { repositories: [] });

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

    const createGitServer = await fetch(`${baseUrl}/api/git-servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'gitlab-post', type: 'gitlab' }),
    });
    assert.equal(createGitServer.status, 404);
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

    const repos = await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id });
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
    assert.equal((await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id })).length, 0);
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
    assert.equal((await store.listRepositories({ gitServerId: 'gitlab-main', userId: user.id })).length, 1);
    assert.equal(await store.db.repoSettingItem.count({
      where: { repoId: repos[0].id, kind: 'webhook', key: 'issue-flow' },
    }), 0);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    const runnerId = checked.body.steps[0].variables.find((item) => item.key === 'AGENTRIX_RUNNER_ID');
    assert.equal(runnerId.status, 'needs_input');
    assert.equal(runnerId.required, true);
    assert.equal(runnerId.needsInput, true);
    assert.deepEqual(checked.body.steps[0].inputRequired, ['AGENTRIX_RUNNER_ID']);
    assert.equal(checked.body.installable, false);
    const repo = await store.findRepositoryByProject({ gitServerId: 'gitlab-main', projectId: '42' });
    const cachedApiKey = repo.settings.variables.items.find((item) => item.key === 'AGENTRIX_API_KEY');
    assert.equal(cachedApiKey.value, '*****');
    assert.equal(cachedApiKey.status, undefined);
    assert.equal(cachedApiKey.detail, undefined);
    assert.equal(await store.db.repoSettingItem.count({ where: { repoId: repo.id, kind: 'variable' } }), 5);

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

test('GitLab login flow lists all visible projects with install status and installs with backend webhook secret', async () => {
  const { dir, store } = tempStore();
  const calls = [];
  const labelsSynced = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-OAuth-Scopes': 'api, read_api',
      });
      res.end(JSON.stringify({ username: 'alice', name: 'Alice' }));
      return;
    }
    if (req.url === '/api/v4/projects?membership=true&per_page=100') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 42,
          name: 'App',
          path_with_namespace: 'team/app',
          default_branch: 'main',
        },
        {
          id: 43,
          name: 'Read Only',
          path_with_namespace: 'team/read-only',
        },
        {
          id: 44,
          name: 'Developer',
          path_with_namespace: 'team/developer',
        },
      ]));
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
        permissions: { project_access: { access_level: 40 } },
      }));
      return;
    }
    if (req.url === '/api/v4/projects/43' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 43,
        name: 'Read Only',
        path_with_namespace: 'team/read-only',
        permissions: { project_access: { access_level: 20 } },
      }));
      return;
    }
    if (req.url === '/api/v4/projects/44' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 44,
        name: 'Developer',
        path_with_namespace: 'team/developer',
        permissions: { project_access: { access_level: 30 } },
      }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/') && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 File Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/commits' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        const body = JSON.parse(raw);
        const paths = body.actions.map((action) => action.file_path);
        assert.equal(body.branch, 'main');
        assert.ok(paths.includes('.gitlab-ci.yml'));
        assert.ok(paths.includes('.gitlab/issue-flow.gitlab-ci.yml'));
        assert.ok(paths.includes('.issue-flow/config.json'));
        assert.ok(paths.some((filePath) => filePath.startsWith('.agentrix/plugins/issue-flow/skills/issue-flow/')));
        assert.equal(body.actions.every((action) => ['create', 'update'].includes(action.action)), true);
        assert.doesNotMatch(raw, /gl-oauth-user-token/);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'bootstrap-commit-sha', web_url: 'https://gitlab.example.com/team/app/-/commit/bootstrap' }));
      });
      return;
    }
    if (handleGitlabLabelSync(req, res, { token: 'gl-oauth-user-token', seen: labelsSynced })) {
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'PUT') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 Variable Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/variables' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        const body = JSON.parse(raw);
        assert.ok([
          'AGENTRIX_BASE_URL',
          'AGENTRIX_API_KEY',
          'AGENTRIX_RUNNER_ID',
          'AGENTRIX_ISSUE_FLOW_AGENT',
          'ISSUE_FLOW_AUTO_DEFAULT',
          'ISSUE_FLOW_REVIEW_ENABLED',
        ].includes(body.key));
        if (body.key === 'AGENTRIX_API_KEY') {
          assert.equal(body.value, 'agentrix-secret-key');
          assert.equal(body.masked, true);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: body.key }));
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
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        const body = JSON.parse(raw);
        assert.equal(body.token, 'backend-webhook-secret');
        assert.match(body.url, /\/webhooks\/gitlab\/repo_/);
        assert.equal(body.merge_requests_events, true);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9001 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  await seedGitlabServer(store, baseUrl, { webhookSecret: 'backend-webhook-secret' });
  const env = {
    ISSUE_FLOW_AGENTRIX_BASE_URL: 'https://agentrix.xmz.ai',
  };
  try {
    const login = await connectGitlabSession({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token' },
      env,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.username, 'alice');
    assert.doesNotMatch(JSON.stringify(login.body), /gl-oauth-user-token/);

    const projects = await listGitlabProjectsWithInstallStatus({
      store,
      input: { gitServerId: 'gitlab-main', token: 'gl-oauth-user-token' },
      env,
    });
    assert.equal(projects.status, 200);
    assert.equal(projects.body.projects[0].canInstall, true);
    assert.equal(projects.body.projects[1].canInstall, false);
    assert.equal(projects.body.projects[2].canInstall, false);

    const installed = await installGitlabProject({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        automation: { autoDefault: 'build', reviewEnabled: true, agent: 'codex' },
        agentrix: { apiKey: 'agentrix-secret-key', runnerId: 'runner-1' },
      },
      env,
    });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.repository.install, undefined);
    assert.ok(installed.body.repository.gitServerId);
    assert.equal(installed.body.repository.webhook.hookId, '9001');
    assert.equal(installed.body.repository.webhook.bootstrapCommitId, 'bootstrap-commit-sha');
    assert.doesNotMatch(JSON.stringify(installed.body), /backend-webhook-secret/);
    assert.doesNotMatch(JSON.stringify(installed.body), /gl-oauth-user-token/);
    assert.doesNotMatch(JSON.stringify(installed.body), /agentrix-secret-key/);
    assert.equal(installed.body.repository.agentrix.baseUrl, 'https://agentrix.xmz.ai');
    assert.ok(labelsSynced.includes('flow::build'));
    assert.ok(labelsSynced.includes('mr-by::build'));
  } finally {
    await close(server);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install uses saved user Agentrix defaults without exposing the API key', async () => {
  const { dir, store } = tempStore();
  const labelsSynced = [];
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/') && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 File Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/commits' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.doesNotMatch(raw, /agentrix-default-key/);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'bootstrap-defaults-commit' }));
      });
      return;
    }
    if (handleGitlabLabelSync(req, res, { token: 'gl-oauth-user-token', seen: labelsSynced })) {
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'PUT') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 Variable Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/variables' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (body.key === 'AGENTRIX_API_KEY') {
          assert.equal(body.value, 'agentrix-default-key');
          assert.equal(body.masked, true);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: body.key }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.doesNotMatch(raw, /agentrix-default-key/);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9002 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase, { webhookSecret: 'backend-webhook-secret' });
  const session = await store.createSession({
    token: 'gl-oauth-user-token',
    gitServerId: 'gitlab-main',
    gitServer: { id: 'gitlab-main', type: 'gitlab', baseUrl: gitlabBase },
    user: { username: 'alice', name: 'Alice' },
    gitlab: { baseUrl: gitlabBase },
  });
  await store.saveUserAgentrixConfig('gitlab-main:alice', {
    automation: { autoDefault: 'build', reviewEnabled: true, agent: 'codex' },
    agentrix: { apiKey: 'agentrix-default-key', runnerId: 'runner-default' },
  });
  try {
    const installed = await installGitlabProject({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: { gitServerId: 'gitlab-main', projectId: '42' },
      session: await store.getSession(session.id),
      env: {
        ISSUE_FLOW_AGENTRIX_BASE_URL: 'https://agentrix.xmz.ai',
      },
    });
    assert.equal(installed.status, 201);
    assert.equal(installed.body.repository.automation.autoDefault, 'build');
    assert.equal(installed.body.repository.agentrix.runnerId, 'runner-default');
    assert.equal(installed.body.repository.agentrix.baseUrl, 'https://agentrix.xmz.ai');
    assert.doesNotMatch(JSON.stringify(installed.body), /agentrix-default-key/);
    assert.ok(labelsSynced.includes('flow::build'));
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install upgrades an already installed repository by rerunning bootstrap and variables', async () => {
  const { dir, store } = tempStore();
  let commitSeen = false;
  let hookUpdated = false;
  const labelsSynced = [];
  const variables = [];
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/files/.gitlab-ci.yml?ref=main' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: '.gitlab-ci.yml',
        encoding: 'base64',
        content: Buffer.from('include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n', 'utf8').toString('base64'),
      }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: 'managed-file',
        encoding: 'base64',
        content: Buffer.from('old managed content\n', 'utf8').toString('base64'),
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/commits' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        const body = JSON.parse(raw);
        const workflow = body.actions.find((action) => action.file_path === '.gitlab/issue-flow.gitlab-ci.yml');
        assert.equal(body.branch, 'main');
        assert.equal(workflow.action, 'update');
        assert.doesNotMatch(workflow.content, /issue-flow-labels:/);
        assert.match(workflow.content, /issue-flow-review-comment:\n  stage: build/);
        assert.doesNotMatch(raw, /gl-oauth-user-token/);
        assert.doesNotMatch(raw, /agentrix-upgrade-key/);
        commitSeen = true;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'upgrade-commit-sha' }));
      });
      return;
    }
    if (handleGitlabLabelSync(req, res, { token: 'gl-oauth-user-token', seen: labelsSynced })) {
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        variables.push(body.key);
        if (body.key === 'AGENTRIX_API_KEY') {
          assert.equal(body.value, 'agentrix-upgrade-key');
          assert.equal(body.masked, true);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: body.key }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks/9001' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        assert.equal(body.token, 'backend-webhook-secret');
        assert.match(body.url, /\/webhooks\/gitlab\/repo_/);
        hookUpdated = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9001 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const existing = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      apiUrl: `${gitlabBase}/api/v4`,
      projectPath: 'team/app',
      agentrix: { apiKey: 'old-agentrix-key' },
    }, {
      status: 'valid',
      projectId: '42',
      defaultBranch: 'main',
    });
    await store.updateRepositoryWebhookCache(existing.repo.id, { hookId: '9001' });

    const upgraded = await installGitlabProject({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        automation: { autoDefault: 'build', reviewEnabled: true, agent: 'codex' },
        agentrix: { apiKey: 'agentrix-upgrade-key', runnerId: 'runner-upgrade' },
      },
      env: {
        ISSUE_FLOW_AGENTRIX_BASE_URL: 'https://agentrix.xmz.ai',
      },
    });

    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.body.upgraded, true);
    assert.equal(upgraded.body.repository.id, existing.repo.id);
    assert.equal(upgraded.body.repository.install, undefined);
    assert.equal(upgraded.body.repository.webhook.bootstrapCommitId, 'upgrade-commit-sha');
    assert.equal(commitSeen, true);
    assert.equal(hookUpdated, true);
    assert.ok(labelsSynced.includes('flow::build'));
    assert.deepEqual(variables.sort(), [
      'AGENTRIX_API_KEY',
      'AGENTRIX_BASE_URL',
      'AGENTRIX_ISSUE_FLOW_AGENT',
      'AGENTRIX_RUNNER_ID',
      'ISSUE_FLOW_AUTO_DEFAULT',
      'ISSUE_FLOW_REVIEW_ENABLED',
    ].sort());
    assert.doesNotMatch(JSON.stringify(upgraded.body), /agentrix-upgrade-key/);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab install upgrade preserves an existing masked GitLab Agentrix API key', async () => {
  const { dir, store } = tempStore();
  const variables = {};
  let hookUpdated = false;
  const gitlab = http.createServer((req, res) => {
    if (req.url === '/api/v4/projects/42' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 42,
        name: 'App',
        path_with_namespace: 'team/app',
        default_branch: 'main',
        permissions: { project_access: { access_level: 40 } },
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/files/.gitlab-ci.yml?ref=main' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: '.gitlab-ci.yml',
        encoding: 'base64',
        content: Buffer.from('include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n', 'utf8').toString('base64'),
      }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/') && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: 'managed-file',
        encoding: 'base64',
        content: Buffer.from('old managed content\n', 'utf8').toString('base64'),
      }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/commits' && req.method === 'POST') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'preserve-commit-sha' }));
      return;
    }
    if (handleGitlabLabelSync(req, res, { token: 'gl-oauth-user-token' })) {
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'GET') {
      const key = decodeURIComponent(req.url.split('/').pop());
      if (key === 'AGENTRIX_API_KEY') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key, value: null, masked: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 Variable Not Found' }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/variables/') && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        variables[body.key] = body.value;
        if (body.key === 'AGENTRIX_API_KEY') {
          assert.equal(body.masked, true);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: body.key }));
      });
      return;
    }
    if (req.url === '/api/v4/projects/42/hooks/9001' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-user-token');
        assert.equal(body.token, 'backend-webhook-secret');
        assert.match(body.url, /\/webhooks\/gitlab\/repo_/);
        hookUpdated = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9001 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const gitlabBase = await listen(gitlab);
  await seedGitlabServer(store, gitlabBase);
  try {
    const existing = await store.createRepository({
      gitServerId: 'gitlab-main',
      baseUrl: gitlabBase,
      apiUrl: `${gitlabBase}/api/v4`,
      projectPath: 'team/app',
      automation: { autoDefault: 'plan', reviewEnabled: true, agent: 'claude', runnerId: 'repo-runner' },
      agentrix: { apiKey: 'repo-agentrix-key', runnerId: 'repo-runner' },
    }, {
      status: 'valid',
      projectId: '42',
      defaultBranch: 'main',
    });
    await store.updateRepositoryWebhookCache(existing.repo.id, { hookId: '9001' });

    const upgraded = await installGitlabProject({
      store,
      basePublicUrl: 'https://issue-flow.internal',
      input: {
        gitServerId: 'gitlab-main',
        token: 'gl-oauth-user-token',
        projectId: '42',
        agentrix: { runnerId: 'repo-runner' },
      },
      env: {
        ISSUE_FLOW_AGENTRIX_BASE_URL: 'https://agentrix.xmz.ai',
      },
    });

    assert.equal(upgraded.status, 200);
    assert.equal(hookUpdated, true);
    assert.equal(upgraded.body.repository.automation.autoDefault, 'triage');
    assert.equal(upgraded.body.repository.automation.reviewEnabled, false);
    assert.equal(upgraded.body.repository.automation.agent, 'codex');
    assert.equal(upgraded.body.repository.agentrix.runnerId, 'repo-runner');
    assert.equal(variables.AGENTRIX_API_KEY, undefined);
    assert.equal(variables.AGENTRIX_ISSUE_FLOW_AGENT, 'codex');
    assert.equal(variables.AGENTRIX_RUNNER_ID, 'repo-runner');
    assert.equal(variables.ISSUE_FLOW_AUTO_DEFAULT, 'triage');
    assert.equal(variables.ISSUE_FLOW_REVIEW_ENABLED, 'false');
    assert.doesNotMatch(JSON.stringify(upgraded.body), /repo-agentrix-key/);
  } finally {
    await close(gitlab);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GitLab OAuth flow stores session token server-side and project APIs use the session cookie', async () => {
  const { dir, store } = tempStore();
  const previousEnv = {
    ISSUE_FLOW_WEB_ORIGIN: process.env.ISSUE_FLOW_WEB_ORIGIN,
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
  process.env.ISSUE_FLOW_WEB_ORIGIN = 'http://web.local';

  const { app: apiApp, baseUrl } = await listenApp(store);
  try {
    const start = await fetch(`${baseUrl}/api/auth/gitlab/start?gitServerId=gitlab-main`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const location = new URL(start.headers.get('location'));
    assert.equal(location.origin, gitlabBase);
    assert.equal(location.pathname, '/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'oauth-client');
    const state = location.searchParams.get('state');
    const stateCookie = start.headers.get('set-cookie');
    assert.match(stateCookie, /issue_flow_oauth_state=/);
    assert.match(stateCookie, /issue_flow_oauth_git_server_id=/);

    const callback = await fetch(`${baseUrl}/api/auth/gitlab/callback?code=oauth-code&state=${state}`, {
      redirect: 'manual',
      headers: { Cookie: setCookieToCookieHeader(stateCookie) },
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

    const repositories = await fetch(`${baseUrl}/api/repositories?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(repositories.status, 200);
    const repositoriesBody = await repositories.json();
    assert.equal(repositoriesBody.repositories[0].projectPath, 'team/app');
    assert.doesNotMatch(JSON.stringify(repositoriesBody), /gl-oauth-session-token/);

    const projects = await fetch(`${baseUrl}/api/gitlab/projects?gitServerId=gitlab-main`, { headers: { Cookie: setCookieToCookieHeader(sessionCookie) } });
    assert.equal(projects.status, 200);
    const projectsBody = await projects.json();
    assert.equal(projectsBody.projects[0].pathWithNamespace, 'team/app');
    assert.equal(projectsBody.projects[0].canInstall, true);
    assert.doesNotMatch(JSON.stringify(projectsBody), /gl-oauth-session-token/);
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

test('server-side GitLab bootstrap wraps existing root CI in a repository commit', async () => {
  const existingRootCi = 'build:\n  script: echo build\n';
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v4/projects/42/repository/files/.gitlab-ci.yml?ref=main' && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        file_path: '.gitlab-ci.yml',
        encoding: 'base64',
        content: Buffer.from(existingRootCi, 'utf8').toString('base64'),
      }));
      return;
    }
    if (req.url.startsWith('/api/v4/projects/42/repository/files/') && req.method === 'GET') {
      assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: '404 File Not Found' }));
      return;
    }
    if (req.url === '/api/v4/projects/42/repository/commits' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        assert.equal(req.headers.authorization, 'Bearer gl-oauth-session-token');
        const body = JSON.parse(raw);
        const rootAction = body.actions.find((action) => action.file_path === '.gitlab-ci.yml');
        const projectAction = body.actions.find((action) => action.file_path === '.gitlab/issue-flow-project.gitlab-ci.yml');
        assert.equal(rootAction.action, 'update');
        assert.match(rootAction.content, /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
        assert.match(rootAction.content, /local: \.gitlab\/issue-flow-project\.gitlab-ci\.yml/);
        assert.equal(projectAction.action, 'create');
        assert.equal(projectAction.content, existingRootCi);
        assert.ok(body.actions.some((action) => action.file_path === '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json'));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'bootstrap-wrap-commit' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const result = await installGitlabBootstrap({
      apiUrl: `${baseUrl}/api/v4`,
      token: 'gl-oauth-session-token',
      authType: 'bearer',
      projectIdOrPath: '42',
      branch: 'main',
    });
    assert.equal(result.commitId, 'bootstrap-wrap-commit');
    assert.equal(result.skipped, false);
  } finally {
    await close(server);
  }
});

test('service dispatch options keep GitLab token out of Agentrix task env', () => {
  const repo = {
    projectPath: 'team/app',
    gitServerId: 'gitlab-main',
    tokenAuth: 'bearer',
    baseUrl: 'https://gitlab.example.com',
    apiUrl: 'https://gitlab.example.com/api/v4',
    automation: {
      autoDefault: 'build',
      reviewEnabled: true,
      agent: 'codex',
      runnerId: 'runner-1',
    },
    agentrix: {
      baseUrl: 'https://agentrix.example.com',
    },
  };
  const secrets = {
    providerToken: 'glpat-provider-token',
    agentrixApiKey: 'agentrix-api-key',
  };
  const options = buildDispatchOptions(repo, secrets);
  assert.equal(options.gitServerId, 'gitlab-main');
  assert.equal(options.gitlabToken, 'glpat-provider-token');
  assert.equal(options.gitlabTokenAuth, 'bearer');
  assert.equal(options.apiKey, 'agentrix-api-key');

  const childEnv = agentrix.buildAgentrixRunEnv(
    { envEventName: 'GITLAB_EVENT_NAME' },
    'build',
    {
      GITLAB_TOKEN: options.gitlabToken,
      GL_TOKEN: options.gitlabToken,
      GITLAB_PRIVATE_TOKEN: options.gitlabToken,
      CI_JOB_TOKEN: options.gitlabToken,
      AGENTRIX_API_KEY: options.apiKey,
    }
  );
  assert.equal(childEnv.GITLAB_TOKEN, undefined);
  assert.equal(childEnv.GL_TOKEN, undefined);
  assert.equal(childEnv.GITLAB_PRIVATE_TOKEN, undefined);
  assert.equal(childEnv.CI_JOB_TOKEN, undefined);
  assert.equal(childEnv.AGENTRIX_API_KEY, 'agentrix-api-key');

  const defaulted = buildDispatchOptions({
    projectPath: 'team/app',
    baseUrl: 'https://gitlab.example.com',
    apiUrl: 'https://gitlab.example.com/api/v4',
  }, {});
  assert.equal(defaulted.autoDefault, 'triage');
  assert.equal(defaulted.gitServerId, '');
});
