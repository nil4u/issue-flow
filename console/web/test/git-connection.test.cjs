const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { gitConnectionPresentation, githubAuthorizationPath } = require('../src/lib/git-connection.ts');

test('a linked GitHub account is ready only after repository access is confirmed', () => {
  const unlinked = gitConnectionPresentation('github', false);
  assert.equal(unlinked.button, '连接 GitHub');
  assert.equal(unlinked.action, 'connect');
  assert.equal(gitConnectionPresentation('github', true).busy, true);
  const pending = gitConnectionPresentation('github', true, { status: 'needs_authorization', repositoryCount: 0 });
  assert.equal(pending.ready, false);
  assert.equal(pending.action, 'authorize');
  const connected = gitConnectionPresentation('github', true, { status: 'connected', repositoryCount: 12 });
  assert.equal(connected.text, '已连接 · 12 个仓库');
  assert.equal(connected.ready, true);
  assert.equal(connected.button, '管理仓库授权');
});

test('failure, revoked login and empty authorization each offer the matching recovery action', () => {
  for (const [status, action] of [['sync_failed', 'sync'], ['needs_login', 'connect'], ['no_repositories', 'authorize'], ['suspended', 'authorize']]) {
    const result = gitConnectionPresentation('github', true, { status });
    assert.equal(result.action, action);
    assert.equal(result.ready, false);
    assert.equal(result.busy, false);
  }
  assert.equal(gitConnectionPresentation('gitlab', true).button, '同步仓库');
});

test('authorization preserves the current account or repository page', () => {
  const url = new URL(githubAuthorizationPath('github-main', '/settings/account?tab=git'), 'https://flow.example');
  assert.equal(url.pathname, '/api/auth/github/install');
  assert.equal(url.searchParams.get('returnTo'), '/settings/account?tab=git');
  assert.equal(url.searchParams.get('gitServerId'), 'github-main');
});
