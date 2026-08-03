const assert = require('node:assert/strict');
const test = require('node:test');

const domain = require('../domain/index.cjs');

test('domain owns managed label parsing and replacement', () => {
  assert.equal(domain.issueFlow(['type::feature', 'flow::plan']), 'plan');
  assert.deepEqual(domain.applyManagedLabels(
    ['type::feature', 'flow::plan', 'automation::build'],
    { flow: 'flow::build' }
  ), ['type::feature', 'automation::build', 'flow::build']);
});

test('domain owns source, artifact, and optimization marker protocols', () => {
  assert.equal(domain.sourceIssueNumber(domain.buildSourceIssueMarker(42)), 42);
  assert.deepEqual(domain.parsePlanArtifactMarker(domain.buildPlanArtifactMarker({
    artifact: 'plan', format: 'json', issueNumber: 42, branch: '42-login/plan', commit: 'abc123', path: '.issue-flow/issues/42/plan.json.isv',
  })), {
    artifact: 'plan', format: 'json', issueNumber: 42, branch: '42-login/plan', commit: 'abc123', path: '.issue-flow/issues/42/plan.json.isv',
  });
  assert.deepEqual(domain.parseOptimizationProposalMarker(domain.buildOptimizationProposalMarker({
    optimizationIssueNumber: 81, sourceIssueNumber: 42, proposalId: 'docs', childIssueNumber: 82,
  })), {
    optimizationIssueNumber: 81, sourceIssueNumber: 42, proposalId: 'docs', action: 'created', childIssueNumber: 82,
  });
});

test('domain owns plan merge transitions and optimization terminal state', () => {
  const body = domain.buildPlanArtifactMarker({
    artifact: 'decision', format: 'json', issueNumber: 42, branch: '42-login/plan', commit: 'abc123', path: '.issue-flow/issues/42/decision.json.isv',
  });
  assert.deepEqual(domain.resolveMergedPullRequestTransition(['mr-by::plan'], { body }), {
    kind: 'decision', flow: 'flow::plan', label: 'mr-by::plan', artifact: 'decision', format: 'json',
  });
  assert.equal(domain.allOptimizationProposalsTerminal([
    { kind: 'project-change', state: 'completed' },
    { kind: 'project-developer-feedback', state: 'pending' },
  ]), true);
});
