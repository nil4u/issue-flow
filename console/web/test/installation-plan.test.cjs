const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { installProgressSteps } = require('../src/lib/installation-plan.ts');

test('installation progress uses the provider plan order without injecting GitLab-only prerequisites', () => {
  const plan = { provider: 'native-actions', steps: [
    { id: 'permissions', label: '权限', configurable: true },
    { id: 'actions', label: 'Actions', configurable: false },
    { id: 'plugins', label: '插件', configurable: false },
  ] };
  assert.deepEqual(installProgressSteps(plan), plan.steps.map(({ id, label }) => ({ id, label, status: 'pending' })));
  assert.equal(plan.steps[0].status, undefined);
});
