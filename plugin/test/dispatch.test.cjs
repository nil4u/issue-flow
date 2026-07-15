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
  runPipelineFailed,
  runReview,
  runReviewComment,
  runComment,
  runResume,
} = require('../skills/issue-flow/scripts/dispatch.cjs');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');
const pipelineFailed = require('../skills/issue-flow/scripts/pipeline-failed.cjs');
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
  const payload = {
    action: overrides.action || 'created',
    comment: {
      id: overrides.commentId || 101,
      body: overrides.commentBody || 'Please handle this edge case.',
      html_url: `https://github.com/example/platform/pull/9#discussion_r${overrides.commentId || 101}`,
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
        ? '<!-- issue-flow:source-issue=42 -->\n<!-- issue-flow:source source_task_id=task-123 source_runtime=agentrix -->\nBody'
        : overrides.body,
      html_url: 'https://github.com/example/platform/pull/9',
      base: { ref: 'main' },
      head: { ref: '42-add-widget-support/build', sha: 'abc123' },
      labels: overrides.labels || [{ name: 'mr-by::build' }],
      user: { login: 'alice' },
    },
    repository: { full_name: 'example/platform' },
  };
  if (overrides.reviewId !== undefined) {
    payload.comment.pull_request_review_id = overrides.reviewId;
  }
  if (overrides.issueComment) {
    payload.issue = {
      number: payload.pull_request.number,
      state: payload.pull_request.state,
      title: payload.pull_request.title,
      body: payload.pull_request.body,
      html_url: payload.pull_request.html_url,
      labels: payload.pull_request.labels,
      user: payload.pull_request.user,
      pull_request: { url: 'https://api.github.com/repos/example/platform/pulls/9' },
    };
    delete payload.pull_request;
  }
  return payload;
}

function githubIssueCommentPayload(overrides = {}) {
  return {
    action: overrides.action || 'created',
    comment: {
      id: overrides.commentId || 501,
      body: overrides.commentBody || '@agentrix here is the missing product constraint',
      html_url: 'https://github.com/example/platform/issues/42#issuecomment-501',
      user: { login: overrides.author || 'reviewer', type: overrides.userType || 'User' },
    },
    issue: {
      number: 42,
      state: overrides.state || 'open',
      title: 'Need clarification',
      body: 'Context',
      html_url: 'https://github.com/example/platform/issues/42',
      labels: overrides.labels || [{ name: 'status::active' }, { name: 'flow::clarify' }],
      user: { login: 'alice' },
    },
    repository: { full_name: 'example/platform' },
  };
}

test('dispatch comment without instruction does not auto-run clarify flow', async () => {
  const result = await runComment(
    { dryRun: true },
    { payload: githubIssueCommentPayload({ commentBody: '@agentrix' }) }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'unsupported_flow');
  assert.equal(result.flowLabel, 'flow::clarify');
});

test('dispatch comment resumes the only resumable issue task while clarifying', async () => {
  const originalList = providers.github.listIssueComments;
  providers.github.listIssueComments = async () => [
    {
      id: 300,
      html_url: 'https://github.com/example/platform/issues/42#issuecomment-300',
      body: agentrix.buildTaskComment('triage', { status: 'dry-run', runId: 'task-triage' }),
    },
  ];

  try {
    const result = await runComment(
      { dryRun: true },
      { payload: githubIssueCommentPayload() }
    );

    assert.equal(result.action, 'task_resume');
    assert.equal(result.taskId, 'task-triage');
    assert.equal(result.taskAction, 'triage');
    assert.equal(result.issueNumber, 42);
    assert.equal(result.result.status, 'dry-run');
  } finally {
    providers.github.listIssueComments = originalList;
  }
});

test('dispatch visual review comment resumes the existing plan task with bot-authored review', async () => {
  const originalList = providers.github.listIssueComments;
  const originalCreate = providers.github.createIssueComment;
  const originalUpdate = providers.github.updateIssueComment;
  const comments = [];
  const updates = [];
  providers.github.listIssueComments = async () => [
    {
      id: 300,
      html_url: 'https://github.com/example/platform/issues/42#issuecomment-300',
      body: agentrix.buildTaskComment('plan', {
        status: 'queued',
        runId: 'task-plan',
        detailUrl: 'https://agentrix.example/tasks/task-plan',
      }),
    },
  ];
  providers.github.createIssueComment = async (issue, body) => {
    comments.push({ issue: issue.number, body });
    return { id: 502, body };
  };
  providers.github.updateIssueComment = async (issue, commentId, body) => {
    updates.push({ issue: issue.number, commentId, body });
  };

  try {
    const result = await runComment(
      { dryRun: true },
      {
        payload: githubIssueCommentPayload({
          userType: 'Bot',
          author: 'issue-flow-bot',
          labels: [{ name: 'status::active' }, { name: 'flow::plan' }, { name: 'visual-plan::changes-requested' }],
          commentBody: [
            '<!-- issue-flow:visual-review artifact=plan review=visual_review_1 status=changes-requested -->',
            '## Visual Plan Review',
            '',
            '1. **plan/index.html** — 确认一下还会有其他状态吗？',
          ].join('\n'),
        }),
      }
    );

    assert.equal(result.action, 'task_resume');
    assert.equal(result.taskId, 'task-plan');
    assert.equal(result.taskAction, 'plan');
    assert.equal(result.issueNumber, 42);
    assert.deepEqual(result.visualReview, {
      artifact: 'plan',
      reviewId: 'visual_review_1',
      status: 'changes-requested',
    });
    assert.equal(result.result.status, 'dry-run');
    assert.equal(comments.length, 1);
    assert.equal(comments[0].issue, 42);
    assert.match(comments[0].body, /Agentrix task queued/);
    assert.match(comments[0].body, /\[open task\]\(https:\/\/agentrix\.example\/tasks\/task-plan\)/);
    assert.match(comments[0].body, /^Action: `plan`$/m);
    assert.match(comments[0].body, /^Run: `task-plan`$/m);
    assert.match(comments[0].body, /Trigger: https:\/\/github\.com\/example\/platform\/issues\/42#issuecomment-501/);
    assert.deepEqual(updates.map(({ issue, commentId }) => ({ issue, commentId })), [{ issue: 42, commentId: 502 }]);
    assert.match(updates[0].body, /\[open task\]\(https:\/\/agentrix\.example\/tasks\/task-plan\)/);
  } finally {
    providers.github.listIssueComments = originalList;
    providers.github.createIssueComment = originalCreate;
    providers.github.updateIssueComment = originalUpdate;
  }
});

test('dispatch approved visual plan comment leaves continuation to flow build', async () => {
  const result = await runComment(
    { dryRun: true },
    {
      payload: githubIssueCommentPayload({
        userType: 'Bot',
        author: 'issue-flow-bot',
        labels: [{ name: 'status::active' }, { name: 'flow::build' }, { name: 'visual-plan::approved' }],
        commentBody: [
          '<!-- issue-flow:visual-review artifact=plan review=visual_review_2 status=approved -->',
          '## Visual Plan Review',
          '',
          'Status: **approved**',
        ].join('\n'),
      }),
    }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'visual_plan_approved');
  assert.equal(result.issueNumber, 42);
});

test('dispatch comment falls back to general when clarify has multiple resumable issue tasks', async () => {
  const originalList = providers.github.listIssueComments;
  providers.github.listIssueComments = async () => [
    {
      id: 300,
      body: agentrix.buildTaskComment('triage', { status: 'dry-run', runId: 'task-triage' }),
    },
    {
      id: 301,
      body: agentrix.buildTaskComment('build', { status: 'dry-run', runId: 'task-build' }),
    },
  ];

  try {
    const result = await runComment(
      { dryRun: true },
      { payload: githubIssueCommentPayload() }
    );

    assert.equal(result.action, 'general');
    assert.equal(result.result.status, 'dry-run');
  } finally {
    providers.github.listIssueComments = originalList;
  }
});

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

test('dispatch review-comment resumes GitHub PR ordinary issue comments', async () => {
  const result = await runReviewComment(
    { dryRun: true },
    { payload: githubReviewCommentPayload({ issueComment: true }) }
  );

  assert.equal(result.action, 'task_resume');
  assert.equal(result.taskId, 'task-123');
  assert.equal(result.pullRequest, 9);
  assert.equal(result.sourceIssue, 42);
  assert.equal(result.reviewComment, '101');
});

test('dispatch Plan review comment uses the Plan-specific resume instruction', async () => {
  const originalPlanInstruction = agentrix.buildVisualReviewResumeInstruction;
  const originalReviewInstruction = agentrix.buildReviewCommentResumeInstruction;
  let planInstructionInput;
  agentrix.buildVisualReviewResumeInstruction = (_issue, comment, data) => {
    planInstructionInput = { comment, data };
    return 'plan review instruction';
  };
  agentrix.buildReviewCommentResumeInstruction = () => assert.fail('generic review instruction must not handle Engine Plan reviews');

  try {
    const result = await runReviewComment(
      { dryRun: true },
      {
        payload: githubReviewCommentPayload({
          issueComment: true,
          commentBody: '<!-- issue-flow:visual-review artifact=plan review=visual_review_1 status=changes-requested -->\n## Visual Plan Review\n\n请修改。',
          body: [
            '<!-- issue-flow:source-issue=42 -->',
            '<!-- issue-flow:agentrix:task=task-plan-42 -->',
            '<!-- issue-flow:plan-artifact artifact=plan format=html repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/index.html -->',
          ].join('\n'),
          labels: [{ name: 'mr-by::plan' }],
        }),
      }
    );

    assert.equal(result.action, 'task_resume');
    assert.equal(result.taskId, 'task-plan-42');
    assert.equal(planInstructionInput.data.visualReview.artifact, 'plan');
    assert.equal(planInstructionInput.data.visualReview.status, 'changes-requested');
    assert.match(planInstructionInput.data.pullRequest.body, /format=html/);
  } finally {
    agentrix.buildVisualReviewResumeInstruction = originalPlanInstruction;
    agentrix.buildReviewCommentResumeInstruction = originalReviewInstruction;
  }
});

test('dispatch review-comment skips issue-flow sourced comments', async () => {
  const result = await runReviewComment(
    { dryRun: true },
    {
      payload: githubReviewCommentPayload({
        commentBody: '<!-- issue-flow:source source_task_id=task-123 source_agent=codex source_runtime=agentrix -->\nAgent output.',
      }),
    }
  );

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'source_provenance');
  assert.equal(result.sourceTaskId, 'task-123');
  assert.equal(result.sourceAgent, 'codex');
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

test('dispatch review-comment acknowledges without posting another task message', async () => {
  const originalCreate = providers.github.createPullRequestComment;
  const originalUpdate = providers.github.updatePullRequestComment;
  const originalReaction = providers.github.addReviewCommentReaction;
  const reactions = [];
  const comments = [];
  providers.github.createPullRequestComment = async (pr, body) => {
    comments.push({ pr: pr.number, body });
    return { id: 104, body };
  };
  providers.github.updatePullRequestComment = async () => {
    throw new Error('review-comment resume should not update a PR task comment');
  };
  providers.github.addReviewCommentReaction = async (pr, comment, content) => {
    reactions.push({ pr: pr.number, comment: comment.id, content });
  };

  try {
    const result = await runReviewComment(
      { dryRun: true },
      { payload: githubReviewCommentPayload({ commentId: 103, reviewId: 901 }) }
    );

    assert.equal(result.action, 'task_resume');
    assert.equal(result.reviewComment, '103');
    assert.deepEqual(reactions, [{ pr: 9, comment: '103', content: 'eyes' }]);
    assert.deepEqual(comments, []);
  } finally {
    providers.github.createPullRequestComment = originalCreate;
    providers.github.updatePullRequestComment = originalUpdate;
    providers.github.addReviewCommentReaction = originalReaction;
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
    assert.match(updates[0].body, /Review task: `task-review`/);
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

test('dispatch Decision merge resumes the original Plan task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-dispatch-decision-merged-test-'));
  const eventPath = path.join(root, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 9,
        html_url: 'https://github.com/example/platform/pull/9',
        merged: true,
        labels: [{ name: 'mr-by::plan' }],
        body: [
          '<!-- issue-flow:source-issue=42 -->',
          '<!-- issue-flow:agentrix:task=task-plan-42 -->',
          '<!-- issue-flow:plan-artifact artifact=decision format=html repo=repo_123 issue=42 branch=42-add-widget-support/plan commit=abc123 path=.issue-flow/issues/42-add-widget-support/decision.html -->',
        ].join('\n'),
        title: 'Decision #42: Add widget support',
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

    assert.equal(result.transition.kind, 'decision');
    assert.equal(result.transition.flow, 'flow::plan');
    assert.equal(result.transition.taskId, 'task-plan-42');
    assert.equal(result.autoResume.action, 'task_resume');
    assert.equal(result.autoResume.result.status, 'dry-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dispatch pipeline-failed directly auto-resumes created failure issue', async () => {
  const original = pipelineFailed.runFailureIntake;
  pipelineFailed.runFailureIntake = async () => ({
    action: 'created',
    issueNumber: 563,
    issueUrl: 'https://github.com/example/platform/issues/563',
    labels: [
      'type::ops',
      'status::active',
      'flow::build',
      'automation::build',
      'priority::p2',
      'size::M',
      'failure::ci',
      'ci-fp::1234abcd',
    ],
    fingerprint: { label: 'ci-fp::1234abcd' },
  });

  try {
    const result = await runPipelineFailed({
      provider: 'github',
      repo: 'example/platform',
      dryRun: true,
      autoDefault: 'off',
    });

    assert.equal(result.failureIntake.action, 'created');
    assert.equal(result.autoResume.action, 'build');
    assert.equal(result.autoResume.result.status, 'dry-run');
  } finally {
    pipelineFailed.runFailureIntake = original;
  }
});

test('dispatch pipeline-failed does not auto-resume skipped intake', async () => {
  const original = pipelineFailed.runFailureIntake;
  pipelineFailed.runFailureIntake = async () => ({
    action: 'skipped',
    reason: 'github_workflow_run_not_failed',
  });

  try {
    const result = await runPipelineFailed({
      provider: 'github',
      repo: 'example/platform',
      dryRun: true,
      autoDefault: 'build',
    });

    assert.deepEqual(result, {
      action: 'skipped',
      reason: 'github_workflow_run_not_failed',
    });
  } finally {
    pipelineFailed.runFailureIntake = original;
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

test('dispatch pr-merged accepts current GitLab bridge MR labels and body', async () => {
  await withEnv({
    GITLAB_BRIDGE_EVENT_NAME: 'pull_request',
    GITLAB_BRIDGE_EVENT_ACTION: 'closed',
    GITLAB_BRIDGE_PULL_REQUEST_MERGED: 'true',
    GITLAB_BRIDGE_PR_NUMBER: '7',
    GITLAB_BRIDGE_HEAD_REF: '42-add-widget-support/plan',
    GITLAB_BRIDGE_BASE_REF: 'main',
    GITLAB_BRIDGE_PR_TITLE: 'Plan #42: Add widget support',
    GITLAB_BRIDGE_PR_BODY: '<!-- issue-flow:source-issue=42 -->\nSource issue: #42',
    GITLAB_BRIDGE_PR_URL: 'https://gitlab.example/example/platform/-/merge_requests/7',
    GITLAB_BRIDGE_LABELS_JSON: '["mr-by::plan"]',
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
