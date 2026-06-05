const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSourceIssueContext,
  normalizeMergeRequestPayload,
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
  });
  assert.throws(
    () => resolveMergedPrTransition(['mr-by::plan', 'mr-by::build']),
    /multiple issue-flow source labels/
  );
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
      labels: ['flow::build'],
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
