const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  analyzeFailureContext,
  buildDuplicateComment,
  createIssueCliArgs,
  buildIssueBody,
  findMatchingIssue,
  fingerprintFailure,
  githubFailureContext,
  gitlabFailureContext,
  parsePipelineFailureMarker,
  runFailureIntake,
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

test('transient-looking and low-signal failures still require agent review', () => {
  const transient = analyzeFailureContext(baseContext({ log: 'npm ERR! network ECONNRESET while fetching package' }));
  assert.equal(transient.category, 'agent_review_required');
  assert.equal(transient.failureKind, 'ci_failure');
  assert.equal(transient.suspectedFixScope, 'agent_to_determine');

  const unknown = analyzeFailureContext(baseContext({ log: 'Error: Process completed with exit code 1' }));
  assert.equal(unknown.category, 'agent_review_required');
  assert.equal(unknown.normalizedErrorSignature, 'Error: Process completed with exit code 1');
});

test('failure intake does not pre-classify repo or provider failures', () => {
  const repoAnalysis = analyzeFailureContext(baseContext());
  assert.equal(repoAnalysis.category, 'agent_review_required');
  assert.equal(typeLabelForAnalysis(repoAnalysis), 'type::bug');

  const providerAnalysis = analyzeFailureContext(baseContext({
    log: 'Error: Resource not accessible by integration',
  }));
  assert.equal(providerAnalysis.category, 'agent_review_required');
  assert.equal(typeLabelForAnalysis(providerAnalysis), 'type::bug');
});

test('github workflow run analysis uses the first failed job without classifying actionability', async () => {
  const payload = {
    workflow_run: {
      id: 100,
      conclusion: 'failure',
      name: 'CI',
      html_url: 'https://github.com/acme/webapp/actions/runs/100',
      head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head_branch: 'main',
      pull_requests: [{ number: 7 }],
    },
  };
  const provider = {
    collectWorkflowRunFailureDetails: async () => ({
      jobs: [
        {
          name: 'download',
          htmlUrl: 'https://github.com/acme/webapp/actions/jobs/1',
          log: 'npm ERR! network ECONNRESET while fetching package',
          steps: [{ name: 'Install', conclusion: 'failure' }],
        },
        {
          name: 'test',
          htmlUrl: 'https://github.com/acme/webapp/actions/jobs/2',
          log: 'FAIL test/app.test.js\nAssertionError: expected 1 to equal 2',
          steps: [{ name: 'Run tests', conclusion: 'failure' }],
        },
      ],
    }),
  };
  const context = await githubFailureContext(payload, provider, { fullName: 'acme/webapp' });

  assert.equal(context.jobName, 'download');
  assert.equal(context.stepName, 'Install');
  assert.equal(analyzeFailureContext(context).category, 'agent_review_required');
});

test('github failure intake skips its own failed workflow in script logic', async () => {
  const context = await githubFailureContext(
    {
      workflow_run: {
        id: 101,
        conclusion: 'failure',
        name: 'Issue Flow Failure Intake',
        html_url: 'https://github.com/acme/webapp/actions/runs/101',
      },
    },
    {
      collectWorkflowRunFailureDetails: async () => {
        throw new Error('self runs should skip before fetching jobs');
      },
    },
    { fullName: 'acme/webapp' }
  );

  assert.deepEqual(context, {
    skipped: true,
    reason: 'self_failure_intake_workflow',
  });
});

test('low-signal failed workflow still creates an agent review issue in dry-run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-pipeline-failed-test-'));
  const eventPath = path.join(dir, 'event.json');
  try {
    fs.writeFileSync(
      eventPath,
      JSON.stringify({
        workflow_run: {
          id: 100,
          conclusion: 'failure',
          name: 'CI',
          html_url: 'https://github.com/acme/webapp/actions/runs/100',
          head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          head_branch: 'main',
        },
        repository: {
          full_name: 'acme/webapp',
        },
      }),
      'utf8'
    );

    const result = await runFailureIntake({
      dryRun: true,
      event: eventPath,
      provider: 'github',
      repo: 'acme/webapp',
    });

    assert.equal(result.action, 'would_create_or_update');
    assert.equal(result.analysis.category, 'agent_review_required');
    assert.match(result.labels.join(' '), /size::M/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitlab Agentrix bridge env is treated as a failed pipeline signal', () => {
  const context = gitlabFailureContext(
    {},
    { fullName: 'acme/webapp' },
    {},
    {
      AGENTRIX_TRIGGER_SOURCE: 'agentrix_daemon_webhook',
      AGENTRIX_PROVIDER: 'gitlab',
      AGENTRIX_EVENT_NAME: 'workflow_run',
      AGENTRIX_EVENT_ACTION: 'completed',
      AGENTRIX_WORKFLOW_RUN_CONCLUSION: 'failure',
      AGENTRIX_PIPELINE_URL: 'https://gitlab.example/acme/webapp/-/pipelines/99',
      AGENTRIX_SHA: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      AGENTRIX_REF: 'main',
      ISSUE_FLOW_FAILURE_LOG: 'FAIL test/app.test.js',
    }
  );

  assert.equal(context.provider, 'gitlab');
  assert.equal(context.runUrl, 'https://gitlab.example/acme/webapp/-/pipelines/99');
  assert.equal(context.commitSha, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(context.skipped, undefined);
});

test('create issue cli args forward provider-specific options', () => {
  const args = createIssueCliArgs({
    title: 'Fix CI failure',
    bodyFile: '/tmp/body.md',
    type: 'type::ops',
    fingerprint: { label: 'ci-fp::1234abcd' },
    options: {
      provider: 'gitlab',
      repo: 'group/project',
      gitlabUrl: 'https://gitlab.example',
      gitlabApiUrl: 'https://gitlab.example/api/v4',
      gitlabProject: 'group/project',
      gitlabToken: 'token',
    },
  });

  assert.match(args.join(' '), /--provider gitlab/);
  assert.match(args.join(' '), /--size size::M/);
  assert.match(args.join(' '), /--repo group\/project/);
  assert.match(args.join(' '), /--gitlab-url https:\/\/gitlab\.example/);
  assert.match(args.join(' '), /--gitlab-api-url https:\/\/gitlab\.example\/api\/v4/);
  assert.match(args.join(' '), /--gitlab-project group\/project/);
  assert.match(args.join(' '), /--gitlab-token token/);
});
