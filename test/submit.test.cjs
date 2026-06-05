const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPrBodyWithSourceMarker,
  buildSourceIssueMarker,
  existingPullRequestApiHead,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  normalizeOptionalUrl,
  normalizePrTitle,
  SUBMIT_KINDS,
} = require('../skills/issue-flow/scripts/submit.cjs');

test('submit body wrapper inserts stable source issue marker', () => {
  assert.equal(buildSourceIssueMarker(482), '<!-- issue-flow:source-issue=482 -->');
  assert.equal(
    buildPrBodyWithSourceMarker('Source issue: #111\n\nBody', 482),
    '<!-- issue-flow:source-issue=482 -->\nSource issue: #111\n\nBody'
  );
});

test('submit body wrapper replaces stale source issue marker', () => {
  assert.equal(
    buildPrBodyWithSourceMarker('<!-- issue-flow:source-issue=111 -->\nBody', 482),
    '<!-- issue-flow:source-issue=482 -->\nBody'
  );
});

test('submit PR lookup tries branch and owner-qualified head filters', () => {
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };

  assert.deepEqual(headBranchFilterCandidates(repo, '482-html-artifacts/plan'), [
    '482-html-artifacts/plan',
    'acme-org:482-html-artifacts/plan',
  ]);
  assert.deepEqual(headBranchFilterCandidates(repo, 'somebody:482-html-artifacts/plan'), [
    'somebody:482-html-artifacts/plan',
  ]);
});

test('submit PR REST lookup uses owner-qualified head branch', () => {
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };

  assert.equal(existingPullRequestApiHead(repo, '482-html-artifacts/plan'), 'acme-org:482-html-artifacts/plan');
  assert.equal(existingPullRequestApiHead(repo, 'somebody:482-html-artifacts/plan'), 'somebody:482-html-artifacts/plan');
});

test('submit PR create falls back to update on duplicate PR errors', () => {
  assert.equal(
    isExistingPullRequestError(
      new Error('pull request create failed: GraphQL: A pull request already exists for acme-org:482-html-artifacts/plan.')
    ),
    true
  );
  assert.equal(isExistingPullRequestError(new Error('pull request create failed: Validation Failed')), false);
});

test('submit PR lookup treats null query output as no existing PR', () => {
  assert.equal(normalizeOptionalUrl('null'), '');
  assert.equal(normalizeOptionalUrl(' https://github.com/acme-org/webapp/pull/482\n'), 'https://github.com/acme-org/webapp/pull/482');
});

test('PR title normalization keeps existing issue number', () => {
  assert.equal(
    normalizePrTitle(SUBMIT_KINDS.plan, 482, 'Plan #482: HTML artifacts'),
    'Plan #482: HTML artifacts'
  );
  assert.equal(
    normalizePrTitle(SUBMIT_KINDS.build, 482, 'HTML artifacts'),
    'Build #482: HTML artifacts'
  );
});
