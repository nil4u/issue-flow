const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { checkProjectInstall, configureInstallStep, installProjectPlugin, installPlan } = require('../src/core/installation/workflow.ts');

function fixture() {
  const calls = [];
  const repository = { id: 'repo', settings: {} };
  const store = {
    async getRepository() { return repository; },
    async updateRepositorySettingsCache(id, settings) {
      calls.push(['cache', id]);
      Object.assign(repository.settings, settings);
      return repository;
    },
  };
  const provider = {
    id: 'native-actions',
    async isChangeOpen() { return true; },
    async readManifest() { return { provider: 'native-actions', issueFlowVersion: '1.0.0' }; },
    async install(input) {
      calls.push(['install', input]);
      return { branch: 'main', sourceBranch: 'install', files: ['workflow.yml'], actionCount: 1, mergeRequest: { id: '9', iid: '3', webUrl: 'https://example/pr/3' } };
    },
  };
  const adapter = {
    id: provider.id,
    async context() { return { server: { id: 'server' }, config: {}, project: {}, existing: repository }; },
    async access() { return { canManage: true }; },
    plugin: () => provider,
    steps: ['permissions', 'actions', 'plugins'].map((id) => ({
      id, label: id, stopWhenBlocked: id === 'permissions',
      async check() { calls.push(['check', id]); return { id, status: 'passed' }; },
      ...(id === 'plugins' ? {} : { async configure() { calls.push(['configure', id]); return { status: 200, body: {} }; } }),
    })),
  };
  return { adapter, provider, repository, calls, options: { store, input: {} } };
}

test('installation plan and execution follow provider steps without requiring a webhook or GitLab runner', async () => {
  const { adapter, calls, options } = fixture();
  assert.deepEqual(installPlan(adapter).steps.map(({ id, configurable }) => [id, configurable]), [
    ['permissions', true], ['actions', true], ['plugins', false],
  ]);
  const result = await checkProjectInstall(options, adapter);
  assert.equal(result.body.installable, true);
  assert.deepEqual(calls, [['check', 'permissions'], ['check', 'actions'], ['check', 'plugins']]);
  calls.length = 0;
  await checkProjectInstall({ ...options, input: { checkTypes: ['plugins', 'actions', 'actions'] } }, adapter);
  assert.deepEqual(calls, [['check', 'actions'], ['check', 'plugins']]);
});

test('blocked prerequisites and denied project access stop subsequent installation operations', async () => {
  const { adapter, calls, options } = fixture();
  adapter.steps[0].check = async () => ({ id: 'permissions', status: 'blocked' });
  const checked = await checkProjectInstall(options, adapter);
  assert.equal(checked.body.installable, false);
  assert.equal(checked.body.steps.length, 1);
  assert.deepEqual(calls, []);
  adapter.access = async () => ({ canManage: false });
  assert.equal((await checkProjectInstall(options, adapter)).status, 403);
  assert.equal((await installProjectPlugin(options, adapter)).status, 403);
  assert.deepEqual(calls, []);
});

test('configure only executes an operation declared by the provider', async () => {
  const { adapter, calls, options } = fixture();
  assert.equal((await configureInstallStep({ ...options, input: { checkType: 'plugins' } }, adapter)).status, 400);
  assert.equal((await configureInstallStep({ ...options, input: { checkType: '__proto__' } }, adapter)).status, 400);
  await configureInstallStep({ ...options, input: { checkType: 'actions' } }, adapter);
  assert.deepEqual(calls, [['configure', 'actions']]);
});

test('plugin installation caches a pending change and reuses it without creating another change', async () => {
  const { adapter, calls, options, repository } = fixture();
  const first = await installProjectPlugin(options, adapter);
  assert.equal(first.status, 202);
  assert.equal(repository.settings.plugins.items[0].source, adapter.id);
  assert.equal(repository.settings.plugins.items[0].provider, adapter.id);
  assert.equal(first.body.pendingMergeRequest.iid, '3');
  const second = await installProjectPlugin(options, adapter);
  assert.equal(second.status, 200);
  assert.equal(calls.filter(([call]) => call === 'install').length, 1);
});

test('plugin conflicts preserve their fingerprint and leave installation cache untouched', async () => {
  const { adapter, provider, calls, options } = fixture();
  provider.install = async () => ({ conflicts: true, plan: { fingerprint: 'stale', conflicts: [{ path: 'workflow.yml' }] } });
  const result = await installProjectPlugin(options, adapter);
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { fingerprint: 'stale', conflicts: [{ path: 'workflow.yml' }] });
  assert.deepEqual(calls, []);
});

test('unchanged installation refreshes the manifest through the provider', async () => {
  const { adapter, provider, options } = fixture();
  provider.install = async () => ({ skipped: true });
  const result = await installProjectPlugin(options, adapter);
  assert.equal(result.status, 200);
  assert.equal(result.body.plugin.installedVersion, '1.0.0');
  assert.equal(result.body.plugin.source, adapter.id);
});
