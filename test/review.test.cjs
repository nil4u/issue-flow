const assert = require('node:assert/strict');
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
  ]), {
    _: [],
    provider: 'github',
    repo: 'example/platform',
    prNumber: '5',
    bodyFile: '/tmp/review.md',
  });
});

test('review script submits through provider review API', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-review-test-'));
  const bodyFile = path.join(root, 'review.md');
  fs.writeFileSync(bodyFile, 'No blocking issues.\n', 'utf8');
  const originalFetch = providers.github.fetchCurrentPullRequest;
  const originalSubmit = providers.github.submitPullRequestReview;
  let captured;

  providers.github.fetchCurrentPullRequest = async (pr) => ({
    ...pr,
    state: 'open',
    headSha: 'abc123',
  });
  providers.github.submitPullRequestReview = async (pr, body, options) => {
    captured = { pr, body, options };
    return { html_url: 'https://github.com/example/platform/pull/5#pullrequestreview-1' };
  };

  try {
    const result = await submitReview({
      provider: 'github',
      repo: 'example/platform',
      prNumber: '5',
      bodyFile,
    });

    assert.equal(captured.pr.number, 5);
    assert.equal(captured.pr.headSha, 'abc123');
    assert.equal(captured.body, 'No blocking issues.');
    assert.equal(result.action, 'submitted');
    assert.equal(result.reviewUrl, 'https://github.com/example/platform/pull/5#pullrequestreview-1');
  } finally {
    providers.github.fetchCurrentPullRequest = originalFetch;
    providers.github.submitPullRequestReview = originalSubmit;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('github review provider submits one pull request review payload', async () => {
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
      { dryRun: true }
    );

    const payload = JSON.parse(logged);
    assert.deepEqual(payload.body, {
      body: 'No blocking issues.',
      event: 'COMMENT',
      commit_id: 'abc123',
    });
    assert.equal(payload.reviewPullRequest, 5);
    assert.equal(result.id, 'dry-run-review');
  } finally {
    console.log = originalLog;
  }
});
