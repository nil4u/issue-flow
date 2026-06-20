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

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

test('cli help is discoverable by resource and nested action', async () => {
  assert.match(await cli.run(['--help']), /Usage: issue-flow <resource> <action>/);
  assert.match(await cli.run(['issue', '--help']), /comments create --issue <num>/);
  assert.match(await cli.run(['issue', 'comments', '--help']), /Usage: issue-flow issue comments <action>/);
  assert.match(await cli.run(['pr', 'submit', '--help']), /Usage: issue-flow pr submit <plan\|build>/);
  assert.match(await cli.run(['pr', 'review-comments', '--help']), /Usage: issue-flow pr review-comments <action>/);
  assert.match(await cli.run(['pr', 'review-comments', '--help']), /list --pr <num>/);
  assert.doesNotMatch(await cli.run(['pr', 'review-comments', '--help']), /reply --pr <num>/);
  assert.doesNotMatch(await cli.run(['pr', 'review-comments', '--help']), /resolve --pr <num>/);
  assert.match(await cli.run(['dispatch', '--help']), /review-comment/);
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

test('issue get dry-run resolves github repo from current checkout remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-cli-remote-'));
  try {
    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/webapp.git'], {
        cwd: dir,
        encoding: 'utf8',
      }).status,
      0
    );

    const env = {
      ...process.env,
      AGENTRIX_PROVIDER: '',
      AGENTRIX_REPOSITORY_NAME: '',
      AGENTRIX_REPOSITORY_OWNER: '',
      CI_PROJECT_ID: '',
      CI_PROJECT_PATH: '',
      CI_REPOSITORY_URL: '',
      GITHUB_REPOSITORY: '',
      GITLAB_API_URL: '',
      GITLAB_BASE_URL: '',
      GITLAB_CI: '',
      GITLAB_PRIVATE_TOKEN: '',
      GITLAB_PROJECT_PATH: '',
      GITLAB_TOKEN: '',
      GL_TOKEN: '',
      ISSUE_FLOW_PROVIDER: '',
    };
    const result = runCli(['issue', 'get', '--issue', '15', '--dry-run'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.provider, 'github');
    assert.equal(parsed.data.repo, 'acme/webapp');
    assert.equal(parsed.data.number, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('issue get dry-run resolves gitlab project from current checkout remote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-cli-remote-'));
  try {
    assert.equal(spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:group/sub/project.git'], {
        cwd: dir,
        encoding: 'utf8',
      }).status,
      0
    );

    const env = {
      ...process.env,
      AGENTRIX_PROVIDER: '',
      AGENTRIX_REPOSITORY_NAME: '',
      AGENTRIX_REPOSITORY_OWNER: '',
      CI_PROJECT_ID: '',
      CI_PROJECT_PATH: '',
      CI_REPOSITORY_URL: '',
      GITHUB_REPOSITORY: '',
      GITLAB_API_URL: '',
      GITLAB_BASE_URL: '',
      GITLAB_CI: '',
      GITLAB_PRIVATE_TOKEN: '',
      GITLAB_PROJECT_PATH: '',
      GITLAB_TOKEN: '',
      GL_TOKEN: '',
      ISSUE_FLOW_PROVIDER: '',
    };
    const result = runCli(['issue', 'get', '--issue', '15', '--dry-run'], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.provider, 'gitlab');
    assert.equal(parsed.data.repo, 'group/sub/project');
    assert.equal(parsed.data.number, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('pr review-comments list dry-run uses provider port', () => {
  const result = runCli([
    'pr',
    'review-comments',
    'list',
    '--provider',
    'github',
    '--repo',
    'acme/webapp',
    '--pr',
    '7',
    '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.action, 'listed');
  assert.equal(parsed.provider, 'github');
  assert.equal(parsed.resource, 'pr_review_comment');
  assert.equal(parsed.pr, 7);
  assert.deepEqual(parsed.items, []);
});

test('dispatch review-comment dry-run returns structured JSON envelope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-cli-event-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      action: 'created',
      comment: {
        id: 101,
        body: 'Please handle this edge case.',
        html_url: 'https://github.com/acme/webapp/pull/7#discussion_r101',
        path: 'src/app.js',
        line: 42,
        user: { login: 'reviewer' },
      },
      pull_request: {
        number: 7,
        state: 'open',
        body: '<!-- issue-flow:agentrix:task=task-123 -->',
        html_url: 'https://github.com/acme/webapp/pull/7',
        head: { ref: '7-example/build', sha: 'abc123' },
      },
      repository: { full_name: 'acme/webapp' },
    })
  );

  try {
    const result = runCli([
      'dispatch',
      'review-comment',
      '--provider',
      'github',
      '--event',
      eventPath,
      '--dry-run',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.action, 'dispatched');
    assert.equal(parsed.command, 'review-comment');
    assert.equal(parsed.data.action, 'task_resume');
    assert.equal(parsed.data.taskId, 'task-123');
    assert.equal(parsed.data.reviewComment, '101');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reaction content is controlled by issue-flow semantics', async () => {
  await assert.rejects(
    () => cli.run(['issue', 'reaction', 'create', '--provider', 'github', '--repo', 'acme/webapp', '--issue', '15', '--content', '+1', '--dry-run']),
    /--content must be one of: eyes/
  );
});
