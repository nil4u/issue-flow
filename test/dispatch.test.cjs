const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  resolveAutomationDecision,
  resolveReviewEnabled,
  resolveRuntimeResumeDecision,
  runPrMerged,
  runPrReview,
} = require('../skills/issue-flow/scripts/dispatch.cjs');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');
const { providers } = require('../skills/issue-flow/scripts/providers.cjs');

function withEnv(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('dispatch parser accepts runtime and Agentrix path options', () => {
  assert.deepEqual(parseArgs([
    'auto',
    '--event',
    '/tmp/event.json',
    '--runtime',
    'agentrix',
    '--prompts-dir',
    '.issue-flow/prompts',
    '--templates-dir',
    '.issue-flow/templates',
    '--plan-root-dir',
    '.issue-flow/issues',
    '--pr-number',
    '12',
    '--review-enabled',
    'true',
  ]), {
    command: 'auto',
    options: {
      _: [],
      event: '/tmp/event.json',
      runtime: 'agentrix',
      promptsDir: '.issue-flow/prompts',
      templatesDir: '.issue-flow/templates',
      planRootDir: '.issue-flow/issues',
      prNumber: '12',
      reviewEnabled: 'true',
    },
  });
});

test('dispatch rejects workflow and plugin directory overrides', () => {
  assert.throws(
    () => parseArgs(['auto', '--workflow-dir', '.github/workflows/custom']),
    /Unknown option: --workflow-dir/
  );
  assert.throws(
    () => parseArgs(['auto', '--plugin-dir', '.agentrix/plugins/custom']),
    /Unknown option: --plugin-dir/
  );
});

test('dispatch automation treats old flow::review as unsupported issue flow', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::review', 'automation::build'],
      },
      agentrix,
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'unsupported_flow',
      flowLabel: 'flow::review',
      automationLabel: 'automation::build',
    }
  );
});

test('dispatch resume treats old flow::review as unsupported issue flow', () => {
  assert.deepEqual(
    resolveRuntimeResumeDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::review'],
      },
      agentrix
    ),
    {
      shouldRun: false,
      reason: 'unsupported_flow',
      flowLabel: 'flow::review',
    }
  );
});

test('dispatch pr-review uses its own enable flag', async () => {
  assert.equal(resolveReviewEnabled({ reviewEnabled: 'true' }), true);
  assert.equal(resolveReviewEnabled({ reviewEnabled: '1' }), true);
  assert.equal(resolveReviewEnabled({ reviewEnabled: 'false' }), false);

  await withEnv({
    ISSUE_FLOW_AUTO_DEFAULT: 'build',
    ISSUE_FLOW_REVIEW_ENABLED: undefined,
  }, async () => {
    assert.deepEqual(await runPrReview({ dryRun: true }), {
      action: 'skipped',
      reason: 'review_disabled',
    });
  });
});

test('dispatch pr-review queues runtime review when enabled', async () => {
  const result = await runPrReview(
    {
      dryRun: true,
      reviewEnabled: '1',
    },
    {
      payload: {
        pull_request: {
          number: 9,
          state: 'open',
          draft: false,
          merged: false,
          title: 'Build #42: Add widget support',
          body: '<!-- issue-flow:source-issue=42 -->',
          html_url: 'https://github.com/example/platform/pull/9',
          base: { ref: 'main' },
          head: { ref: '42-add-widget-support/build' },
          labels: [{ name: 'mr-by::build' }],
          user: { login: 'alice' },
        },
        repository: { full_name: 'example/platform' },
      },
    }
  );

  assert.equal(result.action, 'pr-review');
  assert.equal(result.result.status, 'dry-run');
});

test('dispatch pr-review manual path fetches PR/MR and skips draft state', async () => {
  const original = providers.github.fetchCurrentPullRequest;
  let fetched = false;
  providers.github.fetchCurrentPullRequest = async (pr) => {
    fetched = true;
    return {
      ...pr,
      state: 'open',
      draft: true,
      merged: false,
      title: 'Draft: work in progress',
      labels: [],
    };
  };

  try {
    const result = await runPrReview({
      provider: 'github',
      repo: 'example/platform',
      prNumber: '5',
      dryRun: true,
      reviewEnabled: 'true',
    });

    assert.equal(fetched, true);
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'draft_pull_request');
  } finally {
    providers.github.fetchCurrentPullRequest = original;
  }
});

test('dispatch pr-merged auto-resumes plan merges into build action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-dispatch-merged-test-'));
  const eventPath = path.join(root, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        merged: true,
        labels: [{ name: 'mr-by::plan' }],
        body: '<!-- issue-flow:source-issue=42 -->\nSource issue: #42',
        title: 'Plan #42: Add widget support',
        head: { ref: '42-add-widget-support/plan' },
      },
      repository: { full_name: 'example/platform' },
    })
  );

  try {
    const result = await runPrMerged({
      event: eventPath,
      dryRun: true,
      autoDefault: 'build',
    });

    assert.equal(result.transition.action, 'applied');
    assert.equal(result.transition.flow, 'flow::build');
    assert.equal(result.autoResume.action, 'build');
    assert.equal(result.autoResume.result.status, 'dry-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch pr-merged accepts Agentrix GitLab bridge MR labels and body', async () => {
  await withEnv({
    AGENTRIX_TRIGGER_SOURCE: 'agentrix_daemon_webhook',
    AGENTRIX_PROVIDER: 'gitlab',
    AGENTRIX_EVENT_NAME: 'pull_request',
    AGENTRIX_EVENT_ACTION: 'closed',
    AGENTRIX_PULL_REQUEST_MERGED: 'true',
    AGENTRIX_PR_NUMBER: '7',
    AGENTRIX_HEAD_REF: '42-add-widget-support/plan',
    AGENTRIX_BASE_REF: 'main',
    AGENTRIX_MR_TITLE: 'Plan #42: Add widget support',
    AGENTRIX_PR_BODY: '<!-- issue-flow:source-issue=42 -->\nSource issue: #42',
    AGENTRIX_MR_DESCRIPTION: '<!-- issue-flow:source-issue=42 -->\nSource issue: #42',
    AGENTRIX_MR_URL: 'https://gitlab.example/example/platform/-/merge_requests/7',
    AGENTRIX_LABELS: 'mr-by::plan',
    AGENTRIX_LABELS_JSON: '["mr-by::plan"]',
    CI_PROJECT_ID: '99',
    CI_PROJECT_PATH: 'example/platform',
    GITHUB_EVENT_PATH: undefined,
    GITLAB_EVENT_PATH: undefined,
  }, async () => {
    const result = await runPrMerged({
      provider: 'gitlab',
      dryRun: true,
      autoDefault: 'build',
    });

    assert.equal(result.transition.provider, 'gitlab');
    assert.equal(result.transition.action, 'applied');
    assert.equal(result.transition.issueNumber, 42);
    assert.equal(result.transition.flow, 'flow::build');
    assert.equal(result.autoResume.action, 'build');
    assert.equal(result.autoResume.result.status, 'dry-run');
  });
});
