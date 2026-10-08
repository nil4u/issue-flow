const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
require('tsx/cjs');
const { normalizedActionValues, actionValuesChanged, actionFieldPlaceholder, actionExecutionEditable } = require('../src/lib/action-execution.ts');

test('blank inputs inherit and never serialize preview defaults', () => {
  const draft = { defaults: { agent: ' codex ' }, build: { agent: ' ', model: ' model ' } };
  assert.deepEqual(normalizedActionValues(draft), { defaults: { agent: 'codex' }, build: { model: 'model' } });
  assert.equal(actionFieldPlaceholder('build', 'agent', draft), '继承 defaults: codex');
  assert.equal(actionFieldPlaceholder('defaults', 'agent', draft), '由运行时决定');
  assert.equal(actionFieldPlaceholder('build', 'reasoningEffort', draft), '由运行时决定');
});

test('dirty comparison ignores whitespace and detects clearing overrides', () => {
  const original = { defaults: { agent: 'codex' }, build: { model: 'model' } };
  assert.equal(actionValuesChanged({ defaults: { agent: ' codex ' }, build: { model: 'model', agent: '' } }, original), false);
  assert.equal(actionValuesChanged({ ...original, build: { model: '' } }, original), true);
});

test('configuration loads independently and pending state refreshes without installer', () => {
  const hook = fs.readFileSync(require.resolve('../src/hooks/use-action-execution.ts'), 'utf8');
  assert.match(hook, /action-execution\/read/);
  assert.match(hook, /setInterval/);
  assert.doesNotMatch(hook, /hasRepoSettingsData|install-plugin/);
  const component = fs.readFileSync(require.resolve('../src/components/action-execution-settings.tsx'), 'utf8');
  assert.match(component, /actionExecutionEditable/);
  assert.match(component, /snapshot.reasoningEfforts.map/);
  assert.match(component, /清除覆盖/);
});

test('editing is unavailable for read-only users, invalid files, pending MR or failed/loading reads', () => {
  const ready = { state: 'ready' };
  assert.equal(actionExecutionEditable(ready, true, false, ''), true);
  assert.equal(actionExecutionEditable(ready, false, false, ''), false);
  assert.equal(actionExecutionEditable(ready, true, true, ''), false);
  assert.equal(actionExecutionEditable(ready, true, false, 'failed'), false);
  assert.equal(actionExecutionEditable({ ...ready, pendingMergeRequest: { iid: 12 } }, true, false, ''), false);
  for (const state of ['missing', 'invalid_json', 'invalid_config', 'stale']) {
    assert.equal(actionExecutionEditable({ state }, true, false, ''), false);
  }
});
