const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  findActionTaskComment,
  parseArgs,
  resolveAutomationDecision,
  resolveReviewEnabled,
  resolveRuntimeResumeDecision,
  runPrMerged,
  runAuto,
  runReview,
  runReviewComment,
  runResume,
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

test('dispatch review uses its own enable flag', async () => {
  assert.equal(resolveReviewEnabled({ reviewEnabled: 'true' }), true);
  assert.equal(resolveReviewEnabled({ reviewEnabled: '1' }), true);
  assert.equal(resolveReviewEnabled({ reviewEnabled: 'false' }), false);

  await withEnv({
    ISSUE_FLOW_AUTO_DEFAULT: 'build',
    ISSUE_FLOW_REVIEW_ENABLED: undefined,
  }, async () => {
    assert.deepEqual(await runReview({ dryRun: true }), {
      action: 'skipped',
      reason: 'review_disabled',
    });
  });
});

test('dispatch review queues runtime review when enabled', async () => {
  const result = await runReview(
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
          head: { ref: '42-add-widget-support/build', sha: 'abc123' },
          labels: [{ name: 'mr-by::build' }],
          user: { login: 'alice' },
        },
        repository: { full_name: 'example/platform' },
      },
    }
  );

  assert.equal(result.action, 'review');
  assert.equal(result.result.status, 'dry-run');
});

function githubReviewCommentPayload(overrides = {}) {
  return {
    action: overrides.action || 'created',
    comment: {
      id: 101,
      body: 'Please handle this edge case.',
      html_url: 'https://github.com/example/platform/pull/9#discussion_r101',
      in_reply_to_id: overrides.inReplyToId,
      path: 'src/app.js',
      line: 42,
      side: 'RIGHT',
      user: { login: overrides.author || 'reviewer', type: overrides.userType || 'User' },
    },
    pull_request: {
      number: 9,
      state: overrides.state || 'open',
      draft: Boolean(overrides.draft),
      merged: Boolean(overrides.merged),
      title: 'Build #42: Add widget support',
      body: overrides.body === undefined
        ? '<!-- issue-flow:source-issue=42 -->\n<!-- issue-flow:agentrix:task=task-123 -->\nBody'
        : overrides.body,
      html_url: 'https://github.com/example/platform/pull/9',
      base: { ref: 'main' },
      head: { ref: '42-add-widget-support/build', sha: 'abc123' },
      labels: overrides.labels || [{ name: 'mr-by::build' }],
      user: { login: 'alice' },
    },
    repository: { full_name: 'example/platform' },
  };
}

test('dispatch review-comment resumes the PR body task id on created event', async () => {
  const result = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ userType: 'Bot', author: 'agentrix-bot' }) }
  );

  assert.equal(result.action, 'task_resume');
  assert.equal(result.taskId, 'task-123');
  assert.equal(result.pullRequest, 9);
  assert.equal(result.sourceIssue, 42);
  assert.equal(result.reviewComment, '101');
  assert.equal(result.result.status, 'dry-run');
});

test('dispatch review-comment skips unsupported edited events', async () => {
  const result = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ action: 'edited' }) }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'unsupported_event_action');
});

test('dispatch review-comment skips review comment replies', async () => {
  const result = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ inReplyToId: 100 }) }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'review_comment_reply');
});

test('dispatch review-comment skips missing PR task marker and closed PRs', async () => {
  const missingTask = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ body: '<!-- issue-flow:source-issue=42 -->\nBody' }) }
  );
  assert.equal(missingTask.action, 'skipped');
  assert.equal(missingTask.reason, 'missing_agentrix_task');

  const closed = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ state: 'closed' }) }
  );
  assert.equal(closed.action, 'skipped');
  assert.equal(closed.reason, 'pull_request_not_open');
});

test('dispatch review-comment duplicate lock does not resume twice', async () => {
  const originalList = providers.github.listPullRequestComments;
  providers.github.listPullRequestComments = async () => [
    {
      id: 300,
      body: agentrix.buildTaskComment('task_resume', { status: 'starting' }, {
        reviewComment: { id: '101', htmlUrl: 'https://github.com/example/platform/pull/9#discussion_r101' },
        pullRequest: { number: 9 },
        agentrixTaskId: 'task-123',
      }),
      html_url: 'https://github.com/example/platform/pull/9#issuecomment-300',
    },
  ];

  try {
    const result = await runReviewComment(
      { dryRun: true },
      { payload: githubReviewCommentPayload() }
    );

    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'duplicate_review_comment_resume');
    assert.equal(result.existingCommentId, 300);
  } finally {
    providers.github.listPullRequestComments = originalList;
  }
});

test('dispatch review task lock is scoped to the PR and records the reviewed head SHA', () => {
  const comments = [
    {
      body: agentrix.buildTaskComment('review', { status: 'starting' }, {
        pullRequest: { headSha: 'old-sha' },
      }),
    },
  ];

  assert.equal(
    findActionTaskComment(comments, 'review', agentrix, { pullRequest: { headSha: 'new-sha' } }),
    comments[0]
  );
  assert.equal(
    agentrix.extractReviewHeadShaFromTaskComment(comments[0]),
    'old-sha'
  );
});

test('dispatch review resumes the existing reviewer task for a new PR head', async () => {
  const originalList = providers.github.listPullRequestComments;
  const originalCreate = providers.github.createPullRequestComment;
  const originalUpdate = providers.github.updatePullRequestComment;
  const updates = [];
  const existing = {
    id: 300,
    body: agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
      pullRequest: { headSha: 'old-sha' },
    }),
    html_url: 'https://github.com/example/platform/pull/9#issuecomment-300',
  };
  providers.github.listPullRequestComments = async () => [existing];
  providers.github.createPullRequestComment = async () => {
    throw new Error('review resume should not create a new task comment');
  };
  providers.github.updatePullRequestComment = async (_pr, commentId, body) => {
    updates.push({ commentId, body });
  };

  try {
    const result = await runReview(
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
            head: { ref: '42-add-widget-support/build', sha: 'new-sha' },
            labels: [{ name: 'mr-by::build' }],
            user: { login: 'alice' },
          },
          repository: { full_name: 'example/platform' },
        },
      }
    );

    assert.equal(result.action, 'review');
    assert.equal(result.resumed, true);
    assert.equal(result.result.taskId, 'task-review');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].commentId, 300);
    assert.match(updates[0].body, /Run: `task-review`/);
    assert.match(updates[0].body, /Head: `new-sha`/);
  } finally {
    providers.github.listPullRequestComments = originalList;
    providers.github.createPullRequestComment = originalCreate;
    providers.github.updatePullRequestComment = originalUpdate;
  }
});

test('dispatch review skips the existing reviewer task for the same PR head', async () => {
  const originalList = providers.github.listPullRequestComments;
  providers.github.listPullRequestComments = async () => [
    {
      id: 300,
      body: agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
        pullRequest: { headSha: 'same-sha' },
      }),
      html_url: 'https://github.com/example/platform/pull/9#issuecomment-300',
    },
  ];

  try {
    const result = await runReview(
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
            head: { ref: '42-add-widget-support/build', sha: 'same-sha' },
            labels: [{ name: 'mr-by::build' }],
            user: { login: 'alice' },
          },
          repository: { full_name: 'example/platform' },
        },
      }
    );

    assert.equal(result.action, 'review');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'duplicate_task');
    assert.equal(result.existingCommentId, 300);
  } finally {
    providers.github.listPullRequestComments = originalList;
  }
});

test('dispatch auto skips non-routing labeled events', async () => {
  const result = await runAuto(
    {
      dryRun: true,
    },
    {
      payload: {
        action: 'labeled',
        label: { name: 'priority::p2' },
        issue: {
          number: 42,
          state: 'open',
          labels: [{ name: 'status::active' }, { name: 'flow::build' }, { name: 'automation::build' }],
        },
        repository: { full_name: 'example/platform' },
      },
    }
  );

  assert.deepEqual(result, {
    action: 'skipped',
    reason: 'label_not_routing',
  });
});

test('dispatch auto blocks conflicting size labels before runtime starts', async () => {
  const result = await runAuto(
    {
      dryRun: true,
      autoDefault: 'build',
    },
    {
      payload: {
        action: 'labeled',
        label: { name: 'flow::build' },
        issue: {
          number: 42,
          state: 'open',
          labels: [
            { name: 'status::active' },
            { name: 'flow::build' },
            { name: 'automation::build' },
            { name: 'size::S' },
            { name: 'size::M' },
          ],
        },
        repository: { full_name: 'example/platform' },
      },
    }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.code, 'multiple_size_labels');
  assert.equal(result.reason, 'This issue has more than one size:: label; choose one size label before continuing.');
  assert.deepEqual(result.labels, ['size::S', 'size::M']);
});

test('dispatch resume blocks conflicting size labels before runtime starts', async () => {
  const result = await runResume(
    {
      dryRun: true,
    },
    {
      payload: {
        issue: {
          number: 42,
          state: 'open',
          labels: [
            { name: 'status::active' },
            { name: 'flow::plan' },
            { name: 'size::S' },
            { name: 'size::M' },
          ],
        },
        repository: { full_name: 'example/platform' },
      },
    }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.code, 'multiple_size_labels');
  assert.deepEqual(result.labels, ['size::S', 'size::M']);
});

test('dispatch review manual path fetches PR/MR and skips draft state', async () => {
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
    const result = await runReview({
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
