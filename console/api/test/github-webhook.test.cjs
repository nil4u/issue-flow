const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test';
require('tsx/cjs');
const { fixture, server, remote } = require('./helpers/github.cjs');
const { handleGithubWebhook, verifyGithubSignature } = require('../src/core/github/webhook.ts');
const { githubEventFacts } = require('../src/core/events/github.ts');
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; });

function delivery(payload, eventName = 'issues') {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, headers: { 'x-github-event': eventName, 'x-github-delivery': 'delivery', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', server.webhook.secret).update(rawBody).digest('hex')}` } };
}

test('webhook validates the exact raw body and rejects unsigned events before writing', async () => {
  const input = delivery({ action: 'opened' });
  assert.equal(verifyGithubSignature(server.webhook.secret, input.rawBody, input.headers['x-hub-signature-256']), true);
  assert.equal(verifyGithubSignature(server.webhook.secret, Buffer.from('tampered'), input.headers['x-hub-signature-256']), false);
  const setup = fixture();
  setup.store.upsertRepo = async () => assert.fail('must reject before mutating');
  await assert.rejects(handleGithubWebhook({ store: setup.store, ...input, rawBody: Buffer.from('tampered') }), (error) => error.status === 401);
});

test('GitHub issue events update facts without dispatching pipelines and replay the same delivery safely', async () => {
  const setup = fixture();
  const records = new Map();
  const snapshots = [];
  setup.store.createGitEvent = async (record) => {
    if (!records.has(record.deliveryId)) records.set(record.deliveryId, { ...record, receivedAt: '2026-01-01' });
    return records.get(record.deliveryId);
  };
  setup.store.upsertIssueSnapshot = async (snapshot) => { snapshots.push(snapshot); return { applied: false }; };
  global.fetch = async () => assert.fail('issue synchronization must not trigger Actions or request an installation token');
  const input = delivery({ repository: remote, action: 'labeled', issue: { id: 99, number: 2, title: 'Test', state: 'open', body: '', user: { login: 'alex' }, labels: [{ name: 'flow::build' }, { name: 'size::M' }] } });
  await handleGithubWebhook({ store: setup.store, ...input });
  await handleGithubWebhook({ store: setup.store, ...input });
  assert.equal(records.size, 1);
  assert.equal(snapshots[0].flow, 'build');
  assert.equal(snapshots[0].author, 'alex');
  assert.equal(snapshots[0].repositoryId, '123');
});

test('PR merge clears pending plugin and execution configuration through the common consumer', async () => {
  const setup = fixture();
  setup.repository.settings = {
    plugins: { items: [{ key: 'issue-flow', provider: 'github', targetVersion: '1.0.0', pendingMergeRequest: { iid: '3' } }] },
    actionExecution: { state: 'ready', pendingMergeRequest: { iid: 3, sourceBranch: 'install' } },
  };
  setup.store.createGitEvent = async (record) => ({ ...record, receivedAt: '2026-01-01' });
  setup.store.upsertPullRequestSnapshot = async (snapshot) => ({ pullRequest: snapshot });
  global.fetch = async () => assert.fail('PR synchronization needs no provider call');
  await handleGithubWebhook({ store: setup.store, ...delivery({ repository: remote, action: 'closed', pull_request: { id: 12, number: 3, state: 'closed', merged: true, head: { ref: 'install' }, base: { ref: 'main' } } }, 'pull_request') });
  assert.equal(setup.repository.settings.plugins.items[0].installed, true);
  assert.equal(setup.repository.settings.plugins.items[0].source, 'github');
  assert.equal(setup.repository.settings.actionExecution.state, 'stale');
});

test('App installation removal revokes local repository grants', async () => {
  const setup = fixture();
  let revoked;
  setup.store.db = { userRepoAccess: { deleteMany: async (input) => { revoked = input.where; } } };
  setup.store.createGitEvent = async (record) => record;
  await handleGithubWebhook({ store: setup.store, ...delivery({ action: 'removed', installation: { id: 7 }, repositories_removed: [{ id: 123 }] }, 'installation_repositories') });
  assert.equal(revoked.repoId, 'local-repo');
  assert.equal(setup.repository.settings.webhook.installationActive, false);
});

test('comment events cannot overwrite issue snapshots and merged PRs retain provenance', () => {
  assert.equal(githubEventFacts({ eventName: 'issue_comment', payload: { issue: { number: 2, state: 'open' } } }).issue, undefined);
  const facts = githubEventFacts({ eventName: 'pull_request', gitServerId: 'server', repositoryId: '123', payload: { pull_request: { id: 4, number: 5, state: 'closed', merged: true, labels: [{ name: 'mr-by::build' }] } } });
  assert.equal(facts.pullRequest.state, 'merged');
  assert.equal(facts.pullRequest.kind, 'build');
});

test('an older installation PR cannot complete a different pending installation', async () => {
  const setup = fixture();
  setup.repository.settings.plugins = { items: [{ key: 'issue-flow', provider: 'github', installed: false, pendingMergeRequest: { iid: '4', sourceBranch: 'issue-flow/install-new' } }] };
  setup.store.createGitEvent = async (record) => ({ ...record, receivedAt: '2026-01-01' });
  setup.store.upsertPullRequestSnapshot = async (snapshot) => ({ pullRequest: snapshot });
  await handleGithubWebhook({ store: setup.store, ...delivery({ repository: remote, action: 'closed', pull_request: { id: 12, number: 3, state: 'closed', merged: true, head: { ref: 'issue-flow/install-old' }, base: { ref: 'main' } } }, 'pull_request') });
  assert.equal(setup.repository.settings.plugins.items[0].pendingMergeRequest.iid, '4');
  assert.equal(setup.repository.settings.plugins.items[0].installed, false);
});
