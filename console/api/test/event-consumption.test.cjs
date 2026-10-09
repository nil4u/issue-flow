const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { recordGitEvent, applyPluginChange } = require('../src/core/events/consume.ts');

test('standard facts update issues and pull requests independently of webhook transport and pipeline triggering', async () => {
  const calls = [];
  const store = {
    async createGitEvent(record) { calls.push(['record', record]); return record; },
    async upsertIssueSnapshot(snapshot) { calls.push(['issue', snapshot]); return { issue: snapshot, applied: true }; },
    async setIssueFlowSpan(span) { calls.push(['span', span]); },
    scheduleIssueStatsRebuild() { calls.push(['stats']); },
    async upsertPullRequestSnapshot(snapshot) { calls.push(['pr', snapshot]); return { pullRequest: snapshot }; },
    async upsertTaskMarkerLink(link) { calls.push(['link', link]); },
  };
  const issue = { issueNumber: 7, status: 'active', flow: 'plan', updatedAt: '2026-01-01' };
  const pullRequest = { prNumber: 3, issueNumber: 7, openedByTaskId: 'task', sourceRuntime: 'agentrix' };
  await recordGitEvent(store, { eventName: 'issues', payload: { token: 'secret' } }, () => ({ issue, pullRequest, projectSpan: true }));
  assert.deepEqual(calls.map(([kind]) => kind), ['record', 'issue', 'span', 'stats', 'pr', 'link']);
  assert.notEqual(calls[0][1].payload.token, 'secret');
  assert.deepEqual(calls[1][1], issue);
  assert.equal(calls[4][1].prNumber, 3);
  calls.length = 0;
  await recordGitEvent(store, { eventName: 'push' }, () => ({}));
  assert.deepEqual(calls.map(([kind]) => kind), ['record']);
});

for (const state of ['merged', 'closed']) {
  test(`plugin ${state} event updates the pending installation once without calling a provider API`, async () => {
    const repo = { id: 'repo', settings: { plugins: { items: [{
      key: 'issue-flow', source: 'native-actions', provider: 'native-actions', targetVersion: '1.2.3',
      installed: false, pendingMergeRequest: { iid: '5', webUrl: 'https://example/pr/5' },
    }] } } };
    let writes = 0;
    const store = {
      async getRepository() { return repo; },
      async updateRepositorySettingsCache(id, settings) { writes++; Object.assign(repo.settings, settings); },
    };
    await applyPluginChange({ store, repo, change: { iid: '5', state } });
    await applyPluginChange({ store, repo, change: { iid: '5', state } });
    assert.equal(writes, 1);
    const plugin = repo.settings.plugins.items[0];
    assert.equal(plugin.pendingMergeRequest, undefined);
    assert.equal(plugin.installed, state === 'merged');
    assert.equal(plugin.source, 'native-actions');
    if (state === 'merged') assert.equal(plugin.installedVersion, '1.2.3');
  });
}


test('event normalization uses the persisted delivery timestamp when storage returns an earlier delivery', async () => {
  const saved = { eventName: 'issues', receivedAt: '2026-01-01T00:00:00Z', payload: {} };
  let normalized;
  await recordGitEvent({ async createGitEvent() { return saved; } }, { ...saved, receivedAt: '2026-02-01T00:00:00Z' }, (record) => {
    normalized = record;
    return {};
  });
  assert.equal(normalized.receivedAt, saved.receivedAt);
});
