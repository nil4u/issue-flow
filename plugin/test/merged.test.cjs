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
} = require('../skills/issue-flow/scripts/pr-merged.cjs');

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
    plan: 'plan::approved',
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
    '<!-- issue-flow:plan-artifact artifact=decision format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/decision/data/decision-data.json -->',
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
  const visualBody = '<!-- issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=42 branch=42-login/plan commit=abc123 path=.issue-flow/issues/42-login/plan/data/plan-data.json -->';
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body: visualBody }), {
    kind: 'plan',
    label: 'mr-by::plan',
    flow: 'flow::build',
    plan: 'plan::approved',
    artifact: 'plan',
    format: 'json',
  });

  const markdownBody = '<!-- issue-flow:plan-artifact artifact=plan format=markdown repo=repo_123 issue=42 branch=42-login/plan commit=def456 path=.issue-flow/issues/42-login/plan/plan.md -->';
  assert.deepEqual(resolveMergedPrTransition(['mr-by::plan'], { body: markdownBody }), {
    kind: 'plan',
    label: 'mr-by::plan',
    flow: 'flow::build',
    plan: 'plan::approved',
    artifact: 'plan',
    format: 'markdown',
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
