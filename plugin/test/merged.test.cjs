const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSourceIssueContext,
  normalizeMergeRequestPayload,
  parseAgentrixTaskId,
  parsePlanArtifact,
  parseArgs: parsePrMergedArgs,
  parseSourceIssueNumber,
  pullRequestLabels,
  resolveMergedPrTransition,
  shouldCloseSourceIssue,
} = require('../skills/issue-flow/scripts/pr-merged.cjs');
const { sourceIssueNumber } = require('../skills/issue-flow/scripts/optimization-completion.cjs');

test('automation optimization issue links back to its source issue', () => {
  assert.equal(
    sourceIssueNumber('<!-- issue-flow:automation-optimization source-issue=17 -->'),
    17,
  );
});

test('merged PR parser prefers source issue marker over visible text', () => {
  assert.equal(
    parseSourceIssueNumber({
      body: '<!-- issue-flow:source-issue=482 -->\nSource issue: #111',
      title: 'Plan #111: old title',
      head: { ref: '111-old/plan' },
    }),
    482
  );
});

test('merged PR transition is selected from exactly one source label', () => {
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan']), {
    kind: 'plan',
    label: 'mr-by::plan',
    flow: 'flow::build',
  });
  assert.throws(
    () => resolveMergedPrTransition(['mr-by::plan', 'mr-by::build']),
    /multiple issue-flow source labels/
  );
});

test('merged Decision MR returns to Plan and preserves the original task', () => {
  const body = [
    '<!-- issue-flow:source-issue=42 -->',
    '<!-- issue-flow:agentrix:task=task-plan-42 -->',
    '<!-- issue-flow:plan-artifact artifact=decision format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision.json.isv -->',
  ].join('\n');

  assert.deepEqual(parsePlanArtifact(body), { artifact: 'decision', format: 'json' });
  assert.equal(parseAgentrixTaskId(body), 'task-plan-42');
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body }), {
    kind: 'decision',
    label: 'mr-by::plan',
    flow: 'flow::plan',
    artifact: 'decision',
    format: 'json',
  });
});

test('merged Plan MR distinguishes visual and Markdown plans', () => {
  const visualBody = '<!-- issue-flow:plan-artifact artifact=plan format=json issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan.json.isv -->';
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body: visualBody }), {
    kind: 'plan',
    label: 'mr-by::plan',
    flow: 'flow::build',
    artifact: 'plan',
    format: 'json',
  });

  const markdownBody = '<!-- issue-flow:plan-artifact artifact=plan format=markdown issue=42 branch=42-login/plan commit=def456 path=.issue-flow/issues/42-login/plan/plan.md -->';
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body: markdownBody }), {
    kind: 'plan',
    label: 'mr-by::plan',
    flow: 'flow::build',
    artifact: 'plan',
    format: 'markdown',
  });
});

test('merged Optimization Plan does not advance the parent Issue to Build', () => {
  const body = '<!-- issue-flow:plan-artifact artifact=optimization format=json issue=81 branch=81-optimize/plan commit=abc123 path=.issue-flow/issues/81-optimize/plan/data/optimization-data.json -->';
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body }), {
    kind: 'optimization',
    label: 'mr-by::plan',
    artifact: 'optimization',
    format: 'json',
  });
});

test('merged PR source issue context simulates post-transition labels', () => {
  assert.deepEqual(
    buildSourceIssueContext(
      { name: 'github' },
      { owner: 'example', repo: 'platform', fullName: 'example/platform' },
      42,
      { kind: 'plan', label: 'mr-by::plan', flow: 'flow::build' }
    ),
    {
      provider: 'github',
      owner: 'example',
      repo: 'platform',
      repoFullName: 'example/platform',
      projectId: undefined,
      number: 42,
      state: 'open',
      labels: ['status::active', 'flow::build'],
    }
  );
  assert.deepEqual(
    buildSourceIssueContext(
      { name: 'gitlab' },
      { owner: 'example', repo: 'platform', fullName: 'example/platform', projectId: '42' },
      43,
      { kind: 'build', label: 'mr-by::build', status: 'status::done', clearFlow: true }
    ),
    {
      provider: 'gitlab',
      owner: 'example',
      repo: 'platform',
      repoFullName: 'example/platform',
      projectId: '42',
      number: 43,
      state: 'closed',
      labels: ['status::done'],
    }
  );
  assert.equal(shouldCloseSourceIssue({ kind: 'plan', flow: 'flow::build' }), false);
  assert.equal(shouldCloseSourceIssue({ kind: 'build', status: 'status::done' }), true);
});

test('gitlab merge request payload normalizes for merged source transition', () => {
  const mergeRequest = normalizeMergeRequestPayload(
    {
      object_kind: 'merge_request',
      labels: [{ title: 'mr-by::build' }],
      object_attributes: {
        action: 'merge',
        state: 'merged',
        source_branch: '17-support-gitlab/build',
        title: 'Build #17: Support GitLab issue flow',
        description: '<!-- issue-flow:source-issue=17 -->\nSource issue: https://gitlab.com/example/platform/-/issues/99',
      },
    },
    { provider: 'gitlab' }
  );

  assert.equal(mergeRequest.merged, true);
  assert.deepEqual(pullRequestLabels(mergeRequest), ['mr-by::build']);
  assert.equal(parseSourceIssueNumber(mergeRequest), 17);
  assert.deepEqual(resolveMergedPrTransition(pullRequestLabels(mergeRequest)), {
    kind: 'build',
    label: 'mr-by::build',
    status: 'status::done',
    clearFlow: true,
  });
});
