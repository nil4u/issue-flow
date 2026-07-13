const assert = require('node:assert/strict');
const test = require('node:test');

require('tsx/cjs');

const {
  createForwardSession,
  forwardServerConfig,
} = require('../src/core/agentrix-forward.ts');

function fakeStore(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getAgentrixForwardCursor(route) {
      calls.push(['getCursor', route]);
      return overrides.cursor || 0;
    },
    async setAgentrixForwardCursor(route, cursor) {
      calls.push(['setCursor', route, cursor]);
      return cursor;
    },
    async upsertTaskRuntime(input) {
      calls.push(['runtime', input]);
      if (overrides.failRuntime) throw new Error('db down');
      return { task: { taskId: input.taskId }, applied: true };
    },
    async upsertTaskLink(input) {
      calls.push(['link', input]);
      return { task: { taskId: input.taskId }, applied: true };
    },
    async appendTaskEvent(input) {
      calls.push(['event', input]);
      return { taskEvent: { eventId: input.eventId }, applied: true };
    },
    async appendTaskUsageReport(input) {
      calls.push(['usage', input]);
      return { applied: true, count: input.reports.length };
    },
  };
}

function session(store, sent = [], closed = []) {
  return createForwardSession({
    store,
    logger: { warn() {}, error() {} },
    send: (frame) => sent.push(frame),
    close: (code, reason) => closed.push({ code, reason }),
  });
}

test('forwardServerConfig requires the token and defaults the path', () => {
  assert.deepEqual(forwardServerConfig({}), { token: '', path: '/webhooks/agentrix/forward' });
  assert.deepEqual(
    forwardServerConfig({
      ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN: ' secret ',
    }),
    { token: 'secret', path: '/webhooks/agentrix/forward' },
  );
});

test('session answers hello with the stored resume cursor', async () => {
  const store = fakeStore({ cursor: 41 });
  const sent = [];
  const forward = session(store, sent);
  await forward.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, machineId: 'runner-1', hostname: 'ci' }));
  assert.deepEqual(sent, [{ type: 'hello-ack', resumeFromCursor: 41 }]);
  assert.equal(forward.machineId(), 'runner-1');
  assert.deepEqual(store.calls[0], ['getCursor', { machineId: 'runner-1', cloudId: '' }]);
});

test('session keys the cursor route on cloudId plus machineId', async () => {
  const store = fakeStore();
  const sent = [];
  const forward = session(store, sent);
  await forward.handleMessage(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    machineId: 'runner-1',
    cloudId: 'cloud-a',
    hostname: 'ci',
  }));
  assert.deepEqual(forward.route(), { machineId: 'runner-1', cloudId: 'cloud-a' });
  await forward.handleMessage(JSON.stringify({
    type: 'events',
    events: [{
      cursor: 3,
      eventId: 'evt-1',
      taskId: 'task-abc',
      eventType: 'worker-running',
      direction: 'outbound',
      eventData: {},
      createdAt: '2026-07-01T08:00:00Z',
    }],
  }));
  assert.deepEqual(store.calls[store.calls.length - 1], ['setCursor', { machineId: 'runner-1', cloudId: 'cloud-a' }, 3]);
});

test('session omits resumeFromCursor when no cursor is stored', async () => {
  const sent = [];
  await session(fakeStore(), sent).handleMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, machineId: 'runner-1', hostname: 'ci' }));
  assert.deepEqual(sent, [{ type: 'hello-ack' }]);
});

test('session rejects unsupported protocol versions and events before hello', async () => {
  const closed = [];
  const forward = session(fakeStore(), [], closed);
  await forward.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: 2, machineId: 'runner-1' }));
  assert.equal(closed[0].code, 4400);

  const closedEarly = [];
  await session(fakeStore(), [], closedEarly).handleMessage(JSON.stringify({ type: 'events', events: [] }));
  assert.equal(closedEarly[0].code, 4400);
  assert.equal(closedEarly[0].reason, 'hello_required');
});

test('session projects event batches and acknowledges the highest cursor', async () => {
  const store = fakeStore();
  const sent = [];
  const forward = session(store, sent);
  await forward.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, machineId: 'runner-1', hostname: 'ci' }));
  await forward.handleMessage(JSON.stringify({
    type: 'events',
    events: [
      {
        cursor: 7,
        eventId: 'evt-1',
        taskId: 'task-abc',
        eventType: 'create-task',
        direction: 'outbound',
        eventData: { model: 'claude-sonnet-5' },
        createdAt: '2026-07-01T08:00:00Z',
      },
      {
        cursor: 8,
        eventId: 'evt-2',
        taskId: 'task-abc',
        chatId: 'chat-1',
        eventType: 'task-message',
        direction: 'outbound',
        eventData: { message: { type: 'result', subtype: 'success', num_turns: 3 } },
        createdAt: '2026-07-01T08:30:00Z',
      },
      {
        cursor: 9,
        eventId: 'evt-3',
        taskId: 'task-abc',
        eventType: 'task-usage-report',
        direction: 'outbound',
        eventData: { modelUsage: { 'claude-sonnet-5': { inputTokens: 100, outputTokens: 20 } } },
        createdAt: '2026-07-01T08:30:00Z',
      },
    ],
  }));
  assert.deepEqual(sent[sent.length - 1], { type: 'ack', cursor: 9 });
  const runtimeCalls = store.calls.filter(([kind]) => kind === 'runtime');
  assert.equal(runtimeCalls.length, 2);
  assert.equal(runtimeCalls[1][1].status, 'succeeded');
  const eventCalls = store.calls.filter(([kind]) => kind === 'event');
  assert.equal(eventCalls.length, 1);
  assert.equal(eventCalls[0][1].eventType, 'agent_result');
  const usageCalls = store.calls.filter(([kind]) => kind === 'usage');
  assert.equal(usageCalls.length, 1);
  assert.equal(usageCalls[0][1].reports[0].inputTokens, 100);
  assert.deepEqual(store.calls[store.calls.length - 1], ['setCursor', { machineId: 'runner-1', cloudId: '' }, 9]);
});

test('session closes without acking when event projection fails', async () => {
  const store = fakeStore({ failRuntime: true });
  const sent = [];
  const closed = [];
  const forward = session(store, sent, closed);
  await forward.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, machineId: 'runner-1', hostname: 'ci' }));
  await forward.handleMessage(JSON.stringify({
    type: 'events',
    events: [{
      cursor: 9,
      eventId: 'evt-1',
      taskId: 'task-abc',
      eventType: 'create-task',
      direction: 'outbound',
      eventData: {},
      createdAt: '2026-07-01T08:00:00Z',
    }],
  }));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 1011);
  assert.ok(!sent.some((frame) => frame.type === 'ack'), 'failed batches are not acknowledged');
  assert.ok(!store.calls.some(([kind]) => kind === 'setCursor'), 'failed batches do not advance the cursor');
});

test('session ignores malformed JSON with a 4400 close', async () => {
  const closed = [];
  await session(fakeStore(), [], closed).handleMessage('not json');
  assert.equal(closed[0].code, 4400);
  assert.equal(closed[0].reason, 'invalid_json');
});
