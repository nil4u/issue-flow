const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { agentrixTaskLabel, agentrixTaskUrl, shortTaskId } = require('../src/lib/agentrix-task.ts');

test('task links use /tasks/{encoded id} and trim trailing slashes from the base', () => {
  const url = new URL(agentrixTaskUrl('https://agentrix.test/app//', 'task a/b'));
  assert.equal(url.origin, 'https://agentrix.test');
  assert.equal(url.pathname, `/app/tasks/${encodeURIComponent('task a/b')}`);
  assert.equal(agentrixTaskUrl('https://agentrix.test', 'task-1'), 'https://agentrix.test/tasks/task-1');
});

test('a missing base URL produces no link instead of a relative path', () => {
  assert.equal(agentrixTaskUrl('', 'task-1'), '');
  assert.equal(agentrixTaskUrl('   ', 'task-1'), '');
  assert.equal(agentrixTaskUrl('https://agentrix.test', ''), '');
});

test('task labels prefer the projected title and fall back to the task id', () => {
  assert.equal(agentrixTaskLabel({ taskId: 'task-1', title: '  Build #148: Tasks  ' }), 'Build #148: Tasks');
  assert.equal(agentrixTaskLabel({ taskId: 'task-1', title: '' }), 'Task task-1');
  assert.equal(agentrixTaskLabel({ taskId: 'task-1' }), 'Task task-1');
  const longId = 'cmv99abno03tt2y1i7jk12aa8';
  assert.equal(agentrixTaskLabel({ taskId: longId }), `Task ${shortTaskId(longId)}`);
  assert.equal(shortTaskId(longId), 'cmv99abn…jk12aa8');
  assert.equal(shortTaskId('short-id'), 'short-id');
});
