const assert = require('node:assert/strict');
const test = require('node:test');
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost/test';
process.env.ISSUE_FLOW_BASE_URL = 'https://flow.example';
process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN = 'forward-test';
require('tsx/cjs');
const { agentrixPrivateCloudRoutes } = require('../src/routes/agentrix-private-cloud.ts');
const { errorResponse } = require('../src/core/responses.ts');
const { consoleSessionCookieName } = require('../src/utils/http.ts');

async function fixture(t, authenticated = true) {
  const app = require('fastify')();
  app.decorate('issueFlowStore', {
    getConsoleSessionByToken: async () => authenticated ? { userId: 'user' } : undefined,
    getGitServer: async () => ({ id: 'github-main', type: 'github', baseUrl: 'https://github.com', apiUrl: 'https://api.github.com' }),
    getUserAgentrixConfig: async () => undefined,
    saveUserAgentrixConfig: async () => {},
  });
  app.addHook('onRequest', async request => { request.cookies = { [consoleSessionCookieName()]: 'test-session' }; });
  app.setErrorHandler((error, request, reply) => { const result = errorResponse(error); reply.code(result.status).send(result.body); });
  await app.register(agentrixPrivateCloudRoutes);
  t.after(() => app.close());
  return app;
}
const payload = { gitServerId: 'github-main', runnerId: 'cloud-test', llmProxyBaseUrl: 'https://llm.example', llmProxyApiKey: 'test-key', cloudAuthToken: 'cloud-secret', commitAuthor: { name: 'issue-flow', email: 'bot@example.com' } };
for (const gitServerId of ['github-main', undefined]) {
  test(`HTTP command route reads runnerId from request body (${gitServerId || 'no provider'})`, async t => {
    const app = await fixture(t);
    const response = await app.inject({ method: 'POST', url: '/api/agentrix/private-cloud/command', payload: { ...payload, gitServerId } });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.match(body.dockerCommand, /AGENTRIX_BASE_URL='https:\/\/llm.example'/);
    assert.match(body.dockerCommand, /CLOUD_AUTH_TOKEN='cloud-secret'/);
    assert.doesNotMatch(body.dockerCommand, /GITLAB_|GITHUB_TOKEN/);
    assert.equal(body.runnerGitlabToken, undefined);
  });
}
test('HTTP command route requires Console login', async t => {
  const app = await fixture(t, false);
  const response = await app.inject({ method: 'POST', url: '/api/agentrix/private-cloud/command', payload });
  assert.equal(response.statusCode, 401);
});

test('HTTP command uses the selected Cloud ID when fetching the runner secret', async t => {
  const app = await fixture(t);
  app.issueFlowStore.getUserAgentrixConfig = async () => ({ agentrix: { apiKey: 'agentrix-test' } });
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let requested;
  global.fetch = async (url, options) => {
    requested = new URL(url).pathname;
    assert.equal(options.headers.Authorization, 'Bearer agentrix-test');
    return Response.json({ secret: 'retrieved-cloud-secret' });
  };
  const response = await app.inject({ method: 'POST', url: '/api/agentrix/private-cloud/command', payload: { ...payload, cloudAuthToken: undefined } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(requested, '/v1/private-clouds/cloud-test/runner-secret');
  assert.match(response.json().dockerCommand, /CLOUD_AUTH_TOKEN='retrieved-cloud-secret'/);
});
