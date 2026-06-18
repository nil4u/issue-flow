const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeFailureContext,
  buildDuplicateComment,
  buildIssueBody,
  findMatchingIssue,
  fingerprintFailure,
  parsePipelineFailureMarker,
  typeLabelForAnalysis,
} = require('../skills/issue-flow/scripts/pipeline-failed.cjs');

function baseContext(overrides = {}) {
  return {
    provider: 'github',
    repoFullName: 'acme/webapp',
    workflowName: 'CI',
    jobName: 'test',
    stepName: 'Run tests',
    runUrl: 'https://github.com/acme/webapp/actions/runs/100',
    commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    branch: 'main',
    pullRequest: '#7',
    log: 'FAIL test/app.test.js\nAssertionError: expected 1 to equal 2',
    ...overrides,
  };
}

test('fingerprint is based on root cause and ignores run id, commit, and time', () => {
  const contextA = baseContext();
  const analysisA = analyzeFailureContext(contextA);
  const contextB = baseContext({
    runUrl: 'https://github.com/acme/webapp/actions/runs/200',
    commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const analysisB = analyzeFailureContext(contextB);

  assert.equal(fingerprintFailure(contextA, analysisA).full, fingerprintFailure(contextB, analysisB).full);
});

test('body marker exact fingerprint matches dedupe candidates and avoids hash collisions', () => {
  const context = baseContext();
  const analysis = analyzeFailureContext(context);
  const fingerprint = fingerprintFailure(context, analysis);
  const body = buildIssueBody(context, analysis, fingerprint);

  assert.deepEqual(parsePipelineFailureMarker(body), {
    fingerprint: fingerprint.full,
    provider: 'github',
    workflow: 'CI',
    job: 'test',
    step: 'Run tests',
  });
  assert.equal(findMatchingIssue([{ number: 1, body }], fingerprint).number, 1);
  assert.equal(findMatchingIssue([{ number: 2, body: body.replace(fingerprint.full, 'sha256:ffffffff') }], fingerprint), undefined);
});

test('duplicate failure comment records the new run and same root cause', () => {
  const context = baseContext({ runUrl: 'https://github.com/acme/webapp/actions/runs/300' });
  const analysis = analyzeFailureContext(context);
  const comment = buildDuplicateComment(context, analysis, true);

  assert.match(comment, /actions\/runs\/300/);
  assert.match(comment, /Same root cause: yes/);
  assert.match(comment, /FAIL test\/app\.test\.js/);
});

test('transient and insufficient failures are skipped with explicit categories', () => {
  const transient = analyzeFailureContext(baseContext({ log: 'npm ERR! network ECONNRESET while fetching package' }));
  assert.equal(transient.category, 'non_actionable_or_transient');
  assert.equal(transient.skipReason, 'transient_or_external');

  const unknown = analyzeFailureContext(baseContext({ log: 'Error: Process completed with exit code 1' }));
  assert.equal(unknown.category, 'non_actionable_or_transient');
  assert.equal(unknown.skipReason, 'insufficient_actionable_signal');
});

test('repo and provider actionable failures map to expected issue types', () => {
  const repoAnalysis = analyzeFailureContext(baseContext());
  assert.equal(repoAnalysis.category, 'actionable_repo_fix');
  assert.equal(typeLabelForAnalysis(repoAnalysis), 'type::bug');

  const providerAnalysis = analyzeFailureContext(baseContext({
    log: 'Error: Resource not accessible by integration',
  }));
  assert.equal(providerAnalysis.category, 'actionable_provider_fix');
  assert.equal(typeLabelForAnalysis(providerAnalysis), 'type::ops');
});
