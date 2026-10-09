const assert = require('node:assert/strict');
const test = require('node:test');
const Fastify = require('fastify');
process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test';
process.env.ISSUE_FLOW_BASE_URL ||= 'https://flow.example';
require('tsx/cjs');
const { installationRoutes } = require('../src/routes/installation.ts');
const { streamPluginInstall } = require('../src/routes/installation/stream.ts');
const { consoleSessionCookieName } = require('../src/utils/http.ts');
const { errorResponse } = require('../src/core/responses.ts');

async function appFixture({ authenticated = true, provider = 'gitlab' } = {}) {
  const app = Fastify();
  app.decorate('issueFlowStore', {
    async getConsoleSessionByToken() { return authenticated ? { userId: 'user' } : undefined; },
    async getGitCredential() { return { userId: 'user', gitServerId: 'server', token: 'credential' }; },
    async getGitServer() { return { id: 'server', type: provider }; },
  });
  app.addHook('onRequest', async (request) => { request.cookies = { [consoleSessionCookieName()]: 'session' }; });
  app.setErrorHandler((error, request, reply) => {
    const result = errorResponse(error);
    reply.code(result.status).send(result.body);
  });
  await app.register(installationRoutes);
  return app;
}

test('installation routes expose a serializable plan selected from the authenticated Git server', async (t) => {
  const app = await appFixture();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/installation/plan', payload: { gitServerId: 'server' } });
  assert.equal(response.statusCode, 200);
  const plan = response.json();
  assert.equal(plan.provider, 'gitlab');
  assert.deepEqual(plan.steps.map((step) => step.id), ['permissions', 'webhook', 'variables', 'labels', 'runners', 'plugins']);
  assert.equal(plan.steps.at(-1).configurable, false);
  assert.ok(plan.steps.every((step) => Object.keys(step).length === 3));
  const invalid = await app.inject({ method: 'POST', url: '/api/installation/configure', payload: { gitServerId: 'server', checkType: 'unknown' } });
  assert.equal(invalid.statusCode, 400);
});

test('installation routes reject missing authentication and unimplemented platforms', async (t) => {
  const anonymous = await appFixture({ authenticated: false });
  const unsupported = await appFixture({ provider: 'github' });
  t.after(() => Promise.all([anonymous.close(), unsupported.close()]));
  for (const path of ['plan', 'check', 'configure', 'plugin', 'plugin/stream']) {
    const result = await anonymous.inject({ method: 'POST', url: `/api/installation/${path}`, payload: { gitServerId: 'server' } });
    assert.equal(result.statusCode, 401, path);
  }
  const result = await unsupported.inject({ method: 'POST', url: '/api/installation/plan', payload: { gitServerId: 'server' } });
  assert.equal(result.statusCode, 400);
});

for (const [status, body, event] of [
  [202, { pendingMergeRequest: { iid: '3' } }, 'complete'],
  [409, { fingerprint: 'v2', conflicts: [{ path: 'workflow.yml' }] }, 'conflicts'],
  [403, { error: 'permission_required' }, 'error'],
]) {
  test(`shared installation stream retains progress and ${event} payloads`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.post('/stream', (request, reply) => streamPluginInstall(request, reply, async (progress) => {
      progress({ id: 'clone', status: 'passed' });
      return { status, body };
    }));
    const response = await app.inject({ method: 'POST', url: '/stream' });
    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.ok(response.body.includes('event: progress\ndata: {"id":"clone","status":"passed"}'));
    assert.ok(response.body.includes(`event: ${event}\ndata: ${JSON.stringify(body)}`));
  });
}
