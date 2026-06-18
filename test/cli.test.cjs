const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = require('../skills/issue-flow/cli.cjs');

const CLI_PATH = path.resolve(__dirname, '..', 'skills', 'issue-flow', 'cli.cjs');

function createBodyFile(content = 'Body') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-cli-'));
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, content, 'utf8');
  return {
    path: bodyFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
  });
}

test('cli help is discoverable by resource and nested action', async () => {
  assert.match(await cli.run(['--help']), /Usage: issue-flow <resource> <action>/);
  assert.match(await cli.run(['issue', '--help']), /comments create --issue <num>/);
  assert.match(await cli.run(['issue', 'comments', '--help']), /Usage: issue-flow issue comments <action>/);
  assert.match(await cli.run(['pr', 'submit', '--help']), /Usage: issue-flow pr submit <plan\|build>/);
});

test('issue get dry-run outputs a single stable JSON envelope', () => {
  const result = runCli(['issue', 'get', '--provider', 'github', '--repo', 'acme/webapp', '--issue', '15', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, 'fetched');
  assert.equal(parsed.provider, 'github');
  assert.equal(parsed.resource, 'issue');
  assert.equal(parsed.issue, 15);
  assert.equal(parsed.data.repo, 'acme/webapp');
  assert.equal(parsed.data.number, 15);
});

test('issue comments create dry-run uses provider port and suppresses helper stdout', () => {
  const body = createBodyFile('Comment body');
  try {
    const result = runCli([
      'issue',
      'comments',
      'create',
      '--provider',
      'github',
      '--repo',
      'acme/webapp',
      '--issue',
      '15',
      '--body-file',
      body.path,
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, 'created');
    assert.equal(parsed.resource, 'issue_comment');
    assert.equal(parsed.commentId, 'dry-run-comment');
    assert.equal(parsed.issue, 15);
  } finally {
    body.cleanup();
  }
});

test('issue apply maps --issue alias and keeps cli stdout as one JSON document', () => {
  const result = runCli([
    'issue',
    'apply',
    '--provider',
    'github',
    '--repo',
    'acme/webapp',
    '--issue',
    '15',
    '--flow',
    'flow::build',
    '--size',
    'size::M',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, 'applied');
  assert.equal(parsed.resource, 'issue');
  assert.deepEqual(parsed.data.labelsToAdd, ['flow::build', 'size::M']);
});

test('pr review maps --pr alias through the unified cli', () => {
  const body = createBodyFile('Review body');
  try {
    const result = runCli([
      'pr',
      'review',
      '--provider',
      'github',
      '--repo',
      'acme/webapp',
      '--pr',
      '7',
      '--body-file',
      body.path,
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, 'reviewed');
    assert.equal(parsed.resource, 'pr');
    assert.match(parsed.stdout, /reviewPullRequest/);
  } finally {
    body.cleanup();
  }
});

test('reaction content is controlled by issue-flow semantics', async () => {
  await assert.rejects(
    () => cli.run(['issue', 'reaction', 'create', '--provider', 'github', '--repo', 'acme/webapp', '--issue', '15', '--content', '+1', '--dry-run']),
    /--content must be one of: eyes/
  );
});
