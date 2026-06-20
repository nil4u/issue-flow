const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseArgs, submitReview } = require('../skills/issue-flow/scripts/review.cjs');
const { providers } = require('../skills/issue-flow/scripts/providers.cjs');

test('review parser accepts PR number and body file', () => {
  assert.deepEqual(parseArgs([
    '--provider',
    'github',
    '--repo',
    'example/platform',
    '--pr-number',
    '5',
    '--body-file',
    '/tmp/review.md',
    '--comments-file',
    '/tmp/comments.json',
  ]), {
    _: [],
    provider: 'github',
    repo: 'example/platform',
    prNumber: '5',
    bodyFile: '/tmp/review.md',
    commentsFile: '/tmp/comments.json',
  });
});

test('review script submits through provider review API', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-review-test-'));
  const bodyFile = path.join(root, 'review.md');
  const commentsFile = path.join(root, 'comments.json');
  fs.writeFileSync(bodyFile, 'No blocking issues.\n', 'utf8');
  fs.writeFileSync(commentsFile, JSON.stringify([
    {
      path: 'src/app.js',
      line: 42,
      body: 'Please handle this edge case.',
    },
  ]), 'utf8');
  const originalFetch = providers.github.fetchCurrentPullRequest;
  const originalSubmit = providers.github.submitPullRequestReview;
  const originalSpawnSync = childProcess.spawnSync;
  let captured;

  childProcess.spawnSync = () => ({ status: 0, stdout: 'abc123\n' });
  providers.github.fetchCurrentPullRequest = async (pr) => ({
    ...pr,
    state: 'open',
    headSha: 'abc123',
  });
  providers.github.submitPullRequestReview = async (pr, body, options, comments) => {
    captured = { pr, body, options, comments };
    return { html_url: 'https://github.com/example/platform/pull/5#pullrequestreview-1' };
  };

  try {
    const result = await submitReview({
      provider: 'github',
      repo: 'example/platform',
      prNumber: '5',
      bodyFile,
      commentsFile,
    });

    assert.equal(captured.pr.number, 5);
    assert.equal(captured.pr.headSha, 'abc123');
    assert.equal(captured.body, 'No blocking issues.');
    assert.deepEqual(captured.comments, [
      {
        path: 'src/app.js',
        line: 42,
        body: 'Please handle this edge case.',
      },
    ]);
    assert.equal(result.action, 'submitted');
    assert.equal(result.reviewUrl, 'https://github.com/example/platform/pull/5#pullrequestreview-1');
    assert.equal(result.inlineComments, 1);
  } finally {
    providers.github.fetchCurrentPullRequest = originalFetch;
    providers.github.submitPullRequestReview = originalSubmit;
    childProcess.spawnSync = originalSpawnSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('review script skips stale PR head before submitting', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-review-test-'));
  const bodyFile = path.join(root, 'review.md');
  fs.writeFileSync(bodyFile, 'No blocking issues.\n', 'utf8');
  const originalFetch = providers.github.fetchCurrentPullRequest;
  const originalSubmit = providers.github.submitPullRequestReview;
  const originalSpawnSync = childProcess.spawnSync;

  childProcess.spawnSync = () => ({ status: 0, stdout: 'old-head\n' });
  providers.github.fetchCurrentPullRequest = async (pr) => ({
    ...pr,
    state: 'open',
    headSha: 'new-head',
  });
  providers.github.submitPullRequestReview = async () => {
    throw new Error('stale review should not be submitted');
  };

  try {
    const result = await submitReview({
      provider: 'github',
      repo: 'example/platform',
      prNumber: '5',
      bodyFile,
    });

    assert.deepEqual(result, {
      action: 'skipped',
      reason: 'stale_head',
      provider: 'github',
      pullRequest: 5,
      checkoutHead: 'old-head',
      currentHead: 'new-head',
      inlineComments: 0,
    });
  } finally {
    providers.github.fetchCurrentPullRequest = originalFetch;
    providers.github.submitPullRequestReview = originalSubmit;
    childProcess.spawnSync = originalSpawnSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('github review provider submits overall and inline comments in one pull request review payload', async () => {
  const originalLog = console.log;
  let logged = '';
  console.log = (value) => {
    logged = value;
  };

  try {
    const result = await providers.github.submitPullRequestReview(
      {
        owner: 'example',
        repo: 'platform',
        number: 5,
        headSha: 'abc123',
      },
      'No blocking issues.',
      { dryRun: true },
      [
        {
          path: 'src/app.js',
          line: 42,
          body: 'Please handle this edge case.',
        },
      ]
    );

    const payload = JSON.parse(logged);
    assert.deepEqual(payload.body, {
      body: 'No blocking issues.',
      event: 'COMMENT',
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/app.js',
          body: 'Please handle this edge case.',
          line: 42,
          side: 'RIGHT',
        },
      ],
    });
    assert.equal(payload.reviewPullRequest, 5);
    assert.equal(result.id, 'dry-run-review');
  } finally {
    console.log = originalLog;
  }
});
