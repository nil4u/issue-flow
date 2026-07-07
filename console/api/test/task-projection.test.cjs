const assert = require('node:assert/strict');
const test = require('node:test');

require('tsx/cjs');

const {
  forwardedTaskEvent,
  forwardedTaskLink,
  forwardedTaskRuntime,
  normalizeTaskAction,
} = require('../src/core/task-projection.ts');

test('normalizeTaskAction folds review_fix into build and rejects unknown actions', () => {
  assert.equal(normalizeTaskAction('triage'), 'triage');
  assert.equal(normalizeTaskAction('Review'), 'review');
  assert.equal(normalizeTaskAction('review_fix'), 'build');
  assert.equal(normalizeTaskAction('deploy'), '');
  assert.equal(normalizeTaskAction(''), '');
});

test('forwardedTaskLink reads issue linkage and action from the task envelope', () => {
  const link = forwardedTaskLink({
    taskId: 'task-abc',
    eventType: 'create-task',
    createdAt: '2026-07-01T08:00:00Z',
    eventData: {
      gitServerId: 'agx-main',
      serverRepoId: '42',
      issueNumber: 7,
      metadata: { issue_flow_action: 'build', issue_flow_issue: 'group/app#7' },
    },
  });
  assert.deepEqual(link, {
    taskId: 'task-abc',
    action: 'build',
    agentrixGitServerId: 'agx-main',
    repositoryId: '42',
    issueNumber: 7,
    queuedAt: '2026-07-01T08:00:00Z',
  });
});

test('forwardedTaskLink accepts resume-task envelopes and partial linkage', () => {
  const resume = forwardedTaskLink({
    taskId: 'task-abc',
    eventType: 'resume-task',
    eventData: {
      gitServerId: 'agx-main',
      serverRepoId: '42',
      issueNumber: 7,
    },
  });
  assert.equal(resume.issueNumber, 7);
  assert.equal(resume.action, '', 'missing metadata leaves the action empty');

  const actionOnly = forwardedTaskLink({
    taskId: 'task-review',
    eventType: 'create-task',
    eventData: { metadata: { issue_flow_action: 'review' } },
  });
  assert.equal(actionOnly.action, 'review', 'action alone still records the task kind');
  assert.equal(actionOnly.issueNumber, 0);
});

test('forwardedTaskLink ignores other event types and empty envelopes', () => {
  assert.equal(forwardedTaskLink({
    taskId: 'task-abc',
    eventType: 'worker-running',
    eventData: { issueNumber: 7 },
  }), undefined);
  assert.equal(forwardedTaskLink({
    taskId: 'task-abc',
    eventType: 'create-task',
    eventData: { model: 'claude-sonnet-5' },
  }), undefined, 'no linkage fields and no action means nothing to link');
  assert.equal(forwardedTaskLink({ eventType: 'create-task', eventData: { issueNumber: 7 } }), undefined);
});

test('forwardedTaskRuntime maps forward event types onto the task lifecycle', () => {
  const queued = forwardedTaskRuntime({
    taskId: 'task-abc',
    eventType: 'create-task',
    createdAt: '2026-07-01T08:00:00Z',
    eventData: { model: 'claude-sonnet-5', agentType: 'claude' },
  });
  assert.deepEqual(queued, {
    taskId: 'task-abc',
    status: 'queued',
    queuedAt: '2026-07-01T08:00:00Z',
    agent: 'claude',
    model: 'claude-sonnet-5',
  });

  const running = forwardedTaskRuntime({
    taskId: 'task-abc',
    eventType: 'worker-running',
    createdAt: '2026-07-01T08:05:00Z',
  });
  assert.equal(running.status, 'running');
  assert.equal(running.startedAt, '2026-07-01T08:05:00Z');

  const succeeded = forwardedTaskRuntime({
    taskId: 'task-abc',
    eventType: 'task-message',
    direction: 'outbound',
    createdAt: '2026-07-01T08:35:00Z',
    eventData: { message: { type: 'result', subtype: 'success', num_turns: 9 } },
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.turns, 9);
  assert.equal(succeeded.finishedAt, '2026-07-01T08:35:00Z');

  const failed = forwardedTaskRuntime({
    taskId: 'task-abc',
    eventType: 'task-message',
    direction: 'outbound',
    eventData: { message: { type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50 } },
  });
  assert.equal(failed.status, 'failed');

  const exit = forwardedTaskRuntime({ taskId: 'task-abc', eventType: 'worker-exit', createdAt: '2026-07-01T09:00:00Z' });
  assert.equal(exit.status, 'cancelled');
  assert.equal(exit.weakStatus, true);

  const usage = forwardedTaskRuntime({
    taskId: 'task-abc',
    eventType: 'task-usage-report',
    eventData: { modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 20 } } },
  });
  assert.deepEqual(usage.modelUsage, { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 20 } });

  assert.equal(forwardedTaskRuntime({ taskId: 'task-abc', eventType: 'task-slash-commands-update' }), undefined);
  assert.equal(forwardedTaskRuntime({ eventType: 'create-task' }), undefined, 'taskId is required');
});

test('forwardedTaskEvent stores every task-message frame as the conversation stream', () => {
  const humanInput = forwardedTaskEvent({
    taskId: 'task-abc',
    eventId: 'evt-1',
    chatId: 'chat-1',
    eventType: 'task-message',
    direction: 'inbound',
    createdAt: '2026-07-01T08:10:00Z',
    eventData: { senderType: 'human', message: { type: 'user' } },
  });
  assert.equal(humanInput.eventType, 'human_input');
  assert.equal(humanInput.chatId, 'chat-1');

  const agentResult = forwardedTaskEvent({
    taskId: 'task-abc',
    eventId: 'evt-2',
    eventType: 'task-message',
    direction: 'outbound',
    eventData: { message: { type: 'result', subtype: 'success' } },
  });
  assert.equal(agentResult.eventType, 'agent_result');

  const assistantTurn = forwardedTaskEvent({
    taskId: 'task-abc',
    eventId: 'evt-3',
    eventType: 'task-message',
    direction: 'outbound',
    eventData: { message: { type: 'assistant' } },
  });
  assert.equal(assistantTurn.eventType, 'agent_message', 'intermediate assistant messages are stored');

  const systemReminder = forwardedTaskEvent({
    taskId: 'task-abc',
    eventId: 'evt-4',
    eventType: 'task-message',
    direction: 'inbound',
    eventData: { senderType: 'agent', message: { type: 'user' } },
  });
  assert.equal(systemReminder.eventType, 'agent_message', 'non-human inbound messages are stored as agent_message');

  assert.equal(forwardedTaskEvent({ taskId: 'task-abc', eventType: 'create-task', eventId: 'evt-5' }), undefined);
  assert.equal(forwardedTaskEvent({ taskId: 'task-abc', eventType: 'worker-running', eventId: 'evt-6' }), undefined);
});
