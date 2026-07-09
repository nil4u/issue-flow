const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

process.env.DATABASE_URL ||= 'postgresql://issue_flow_test:issue_flow_test@127.0.0.1:1/issue_flow_test';
require('tsx/cjs');

const { validateAgentrixApiKey } = require('../src/core/agentrix-api.ts');
const {
  externalServiceCallStarted,
  logExternalServiceCall,
} = require('../src/core/external-service-log.ts');
const { validateGitlabToken } = require('../src/core/gitlab.ts');

function captureLogger() {
  const entries = [];
  const logger = {
    info(payload, message) {
      entries.push({ level: 'info', payload, message });
    },
    warn(payload, message) {
      entries.push({ level: 'warn', payload, message });
    },
    error(payload, message) {
      entries.push({ level: 'error', payload, message });
    },
  };
  return { entries, logger };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('external service logger calls preserve the logger receiver', () => {
  const entries = [];
  const logger = {
    receiverId: 'logger-instance',
    warn(payload, message) {
      assert.equal(this.receiverId, 'logger-instance');
      entries.push({ level: 'warn', payload, message });
    },
  };

  logExternalServiceCall({
    logger,
    service: 'gitlab',
    method: 'GET',
    url: 'https://gitlab.example/api/v4/user?private_token=secret',
    call: externalServiceCallStarted(),
    status: 404,
    error: Object.assign(new Error('missing'), { status: 404 }),
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, 'warn');
  assert.equal(entries[0].message, 'gitlab external call failed');
  assert.equal(entries[0].payload.path, '/api/v4/user?private_token=[redacted]');
});

test('GitLab API calls record safe external service metadata', async () => {
  const gitlab = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer gitlab-secret');
    if (req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 7, username: 'alice' }));
      return;
    }
    if (req.url === '/projects/group%2Fapp') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 42, default_branch: 'main' }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: 'missing' }));
  });
  const baseUrl = await listen(gitlab);
  const { entries, logger } = captureLogger();
  try {
    const result = await validateGitlabToken({
      apiUrl: baseUrl,
      projectPath: 'group/app',
      token: 'gitlab-secret',
      authType: 'bearer',
      logger,
    });

    assert.equal(result.status, 'valid');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((entry) => entry.level), ['info', 'info']);
    assert.deepEqual(entries.map((entry) => entry.payload.path), ['/user', '/projects/group%2Fapp']);
    for (const entry of entries) {
      assert.equal(entry.payload.externalService, 'gitlab');
      assert.equal(entry.payload.method, 'GET');
      assert.equal(entry.payload.origin, baseUrl);
      assert.equal(entry.payload.status, 200);
      assert.equal(typeof entry.payload.durationMs, 'number');
      assert.match(entry.payload.startedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(entry.payload.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.doesNotMatch(JSON.stringify(entries), /gitlab-secret/);
  } finally {
    await close(gitlab);
  }
});

test('Agentrix API failures record status without leaking the API key', async () => {
  const agentrix = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer agentrix-secret');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid api key' }));
  });
  const baseUrl = await listen(agentrix);
  const { entries, logger } = captureLogger();
  try {
    await assert.rejects(
      () => validateAgentrixApiKey({
        env: { ISSUE_FLOW_AGENTRIX_BASE_URL: baseUrl },
        apiKey: 'agentrix-secret',
        logger,
      }),
      /invalid api key/
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'warn');
    assert.equal(entries[0].payload.externalService, 'agentrix');
    assert.equal(entries[0].payload.method, 'GET');
    assert.equal(entries[0].payload.origin, baseUrl);
    assert.equal(entries[0].payload.path, '/v1/auth/me');
    assert.equal(entries[0].payload.status, 401);
    assert.equal(entries[0].payload.error.code, 'agentrix_api_key_invalid');
    assert.doesNotMatch(JSON.stringify(entries), /agentrix-secret/);
  } finally {
    await close(agentrix);
  }
});
