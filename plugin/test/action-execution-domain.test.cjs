const assert = require('node:assert/strict');
const test = require('node:test');
const domain = require('../domain/index.cjs');
const runtime = require('../skills/issue-flow/scripts/action-execution.cjs');

function configuration() {
  return { provider: 'gitlab', agentrix: { runnerId: 'runner', actions: { defaults: { agent: 'codex', model: 'base' }, build: { model: 'build', reasoningEffort: null }, future: { agent: 'future' } } } };
}

test('runtime and public domain share validation and enums', () => {
  assert.equal(runtime.validateActionExecutionConfig, domain.validateActionExecutionConfig);
  assert.equal(runtime.REASONING_EFFORTS, domain.REASONING_EFFORTS);
  assert.deepEqual(domain.ACTION_NAMES, ['defaults', 'triage', 'plan', 'build', 'review', 'general']);
  const config = configuration();
  const snapshot = domain.actionExecutionSnapshot(config);
  assert.deepEqual(snapshot.preview.build.agent, { value: 'codex', source: 'defaults' });
  assert.deepEqual(snapshot.preview.build.model, { value: 'build', source: 'build' });
  assert.deepEqual(snapshot.preview.defaults.reasoningEffort, { source: 'runtime' });
  assert.equal(snapshot.explicit.build.reasoningEffort, undefined);
  assert.equal(runtime.resolveActionExecution('build', { model: 'explicit' }, config.agentrix).values.model, 'explicit');
});

test('merge trims overrides, clears fields and preserves unrelated configuration', () => {
  const config = configuration();
  const input = domain.actionExecutionSnapshot(config).explicit;
  input.build = { agent: ' claude ', model: '', reasoningEffort: ' high ' };
  const next = domain.mergeActionExecution(config, input);
  assert.deepEqual(next.agentrix.actions.build, { agent: 'claude', reasoningEffort: 'high' });
  assert.deepEqual(next.agentrix.actions.future, config.agentrix.actions.future);
  assert.equal(next.provider, config.provider);
  assert.equal(next.agentrix.runnerId, 'runner');
  assert.equal(config.agentrix.actions.build.model, 'build');
});

test('no semantic edits preserve nulls, missing actions and whitespace', () => {
  const config = configuration();
  config.agentrix.actions.defaults.agent = ' codex ';
  assert.deepEqual(domain.mergeActionExecution(config, domain.actionExecutionSnapshot(config).explicit), config);
});

test('invalid source and request configurations are rejected', () => {
  for (const config of [{}, { agentrix: [] }, { agentrix: { actions: null } }, { agentrix: { actions: { build: { agent: '' } } } }, { agentrix: { actions: { build: { unknown: 'x' } } } }]) {
    assert.throws(() => domain.actionExecutionSnapshot(config));
  }
  const config = configuration();
  for (const changes of [{ reasoningEffort: 'ultra' }, { model: 1 }, { extra: 'x' }]) {
    assert.throws(() => domain.mergeActionExecution(config, { ...domain.actionExecutionSnapshot(config).explicit, build: changes }));
  }
  assert.throws(() => domain.mergeActionExecution(config, { future: {} }));
});
