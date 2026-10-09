const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { installCheckConfig } = require('../src/install-check-config.ts');

test('GitHub settings expose App permissions and Actions without GitLab-specific credentials or runner', () => {
  const config = installCheckConfig('github');
  const items = config.groups.flatMap((group) => group.items);
  assert.ok(items.some((item) => item.id === 'permission:github-app'));
  assert.ok(items.some((item) => item.id === 'actions'));
  assert.ok(!items.some((item) => item.type === 'git-runner' || item.id.includes('GITLAB_TOKEN')));
  assert.equal(items.find((item) => item.id === 'webhook').configurable, false);
  assert.ok(installCheckConfig('gitlab').groups.some((group) => group.id === 'runners'));
});
