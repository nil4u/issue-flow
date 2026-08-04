const assert = require('node:assert/strict');
const test = require('node:test');

const { allOptimizationProposalsTerminal, parseArtifactMarker, parseProposalMarker, proposalStates, sourceIssueNumber } = require('../skills/issue-flow/scripts/optimization-completion.cjs');

test('optimization completion markers preserve parent, source, and proposal identity', () => {
  assert.deepEqual(parseProposalMarker('<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=docs action=ignored -->'), {
    optimizationIssueNumber: 81,
    sourceIssueNumber: 17,
    proposalId: 'docs',
    action: 'ignored',
  });
  assert.equal(sourceIssueNumber('<!-- issue-flow:automation-optimization source-issue=17 -->'), 17);
  assert.deepEqual(parseArtifactMarker({ body: '<!-- issue-flow:plan-artifact artifact=optimization format=json issue=81 branch=81-optimize/plan commit=abc123 path=.issue-flow/issues/81-optimize/plan/data/optimization-data.json -->' }), {
    issueNumber: 81,
    branch: '81-optimize/plan',
    commit: 'abc123',
    path: '.issue-flow/issues/81-optimize/plan/data/optimization-data.json',
  });
});

test('optimization completion treats ignored, done, and drop as terminal', () => {
  const data = { proposals: [{ id: 'docs' }, { id: 'tests' }, { id: 'tooling' }] };
  const states = proposalStates(data, 81, [
    { body: '<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=docs action=ignored -->' },
  ], [
    { description: '<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=tests -->', labels: ['status::done'] },
    { body: '<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=tooling -->', labels: [{ name: 'status::drop' }] },
  ]);
  assert.deepEqual(states, [
    { id: 'docs', kind: 'project-change', state: 'ignored' },
    { id: 'tests', kind: 'project-change', state: 'completed' },
    { id: 'tooling', kind: 'project-change', state: 'cancelled' },
  ]);
});

test('optimization completion excludes developer feedback from terminal state', () => {
  const data = {
    proposals: [
      { id: 'docs', kind: 'project-change' },
      { id: 'tests', kind: 'project-change' },
      { id: 'project-feedback', kind: 'project-developer-feedback' },
      { id: 'feedback', kind: 'issue-flow-feedback' },
    ],
  };
  const states = proposalStates(data, 81, [
    { body: '<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=docs action=ignored -->' },
  ], [
    { description: '<!-- issue-flow:optimization-proposal optimization-issue=81 source-issue=17 proposal=tests -->', labels: ['status::done'] },
  ]);
  assert.deepEqual(states, [
    { id: 'docs', kind: 'project-change', state: 'ignored' },
    { id: 'tests', kind: 'project-change', state: 'completed' },
    { id: 'project-feedback', kind: 'project-developer-feedback', state: 'pending' },
    { id: 'feedback', kind: 'issue-flow-feedback', state: 'pending' },
  ]);
  assert.equal(allOptimizationProposalsTerminal(states), true);
});
