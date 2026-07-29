const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { run } = require('../skills/automation-optimizer/scripts/task-context.cjs');

test('task context CLI keeps repository routing internal', async () => {
  const result = await run(['--help']);
  assert.doesNotMatch(result.help, /--git-server-id|--project-id/);
});

test('task context script fetches the issue lifecycle and writes phase files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-task-context-test-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      repositoryId: 'repo-1',
      issueNumber: 17,
      phases: [
        { phase: 'triage', tasks: [] },
        { phase: 'plan', tasks: [{
          taskId: 'task-1',
          events: [
            { sequence: 1, eventType: 'human_input', eventData: { message: { type: 'user' } } },
            { sequence: 2, eventType: 'agent_result', eventData: { message: { type: 'result' } } },
          ],
        }] },
        { phase: 'build', tasks: [{ taskId: 'task-2', events: [{ sequence: 1, eventType: 'worker_state' }] }] },
        { phase: 'review', tasks: [] },
      ],
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const configPath = path.join(root, 'config.json');
    const outputPath = path.join(root, 'context.json');
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: `http://127.0.0.1:${address.port}`,
      gitServerId: 'gitlab-main',
      projectId: '42',
    }));

    const result = await run([
      '--config', configPath,
      '--issue', '17',
      '--output', outputPath,
    ]);

    assert.deepEqual(requests, ['/api/repositories/gitlab-main/42/issues/17/task-context']);
    assert.equal(result.path, outputPath);
    assert.equal(result.taskCount, 2);
    assert.equal(result.eventCount, 3);
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.deepEqual(manifest.phases.map((phase) => phase.phase), ['triage', 'plan', 'build', 'review']);
    assert.equal(manifest.phases.find((phase) => phase.phase === 'plan').eventCount, 2);
    const planContext = JSON.parse(fs.readFileSync(result.phaseFiles.plan, 'utf8'));
    assert.equal(planContext.tasks[0].taskId, 'task-1');
    const buildContext = JSON.parse(fs.readFileSync(result.phaseFiles.build, 'utf8'));
    assert.equal(buildContext.tasks[0].taskId, 'task-2');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
