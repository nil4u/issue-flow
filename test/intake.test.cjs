const assert = require('node:assert/strict');
const test = require('node:test');

const {
  computeIssueIntakeLabels,
  parseArgs,
  resolveRepoHint,
} = require('../skills/issue-flow/scripts/intake.cjs');

test('intake adds missing default status and flow labels', () => {
  assert.deepEqual(computeIssueIntakeLabels([]), ['status::active', 'flow::triage']);
  assert.deepEqual(computeIssueIntakeLabels(['status::active']), ['flow::triage']);
  assert.deepEqual(computeIssueIntakeLabels(['flow::plan']), ['status::active']);
  assert.deepEqual(computeIssueIntakeLabels(['status::active', 'flow::triage']), []);
});

test('intake CLI parser accepts issue number and dry-run', () => {
  assert.deepEqual(parseArgs(['--issue-number', '123', '--dry-run']), {
    _: [],
    issueNumber: '123',
    dryRun: true,
  });
});

test('intake repo hint falls back to git origin', () => {
  assert.equal(resolveRepoHint({}, {}, () => 'git@github.com:nil4u/issue-flow.git'), 'git@github.com:nil4u/issue-flow.git');
});
