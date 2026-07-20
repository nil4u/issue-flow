const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertBodyFileNotTracked,
  assertDecisionArtifactsRemoved,
  assertVisualArtifactData,
  assertVisualBriefNotInIssueArtifacts,
  buildPrBodyWithMarkers,
  buildVisualArtifactComment,
  buildVisualArtifactPublishedComment,
  buildVisualArtifactMarker,
  buildPrBodyWithSourceMarker,
  buildSourceIssueMarker,
  createGitAskpassEnv,
  existingPullRequestApiHead,
  gitPushTokenForProvider,
  gitPushUsernameForProvider,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  isGitTrackedFile,
  normalizeOptionalUrl,
  normalizePrTitle,
  planSubmissionIssueState,
  publishVisualArtifactComment,
  pullRequestNumberFromUrl,
  resolveBaseBranch,
  resolveIssueFlowBaseUrl,
  resolveVisualPlanFeatureMode,
  SUBMIT_KINDS,
  visualArtifactUrl,
  validateSourceIssueSize,
} = require('../skills/issue-flow/scripts/submit.cjs');
const { labelDefinitionFor } = require('../skills/issue-flow/scripts/labels.cjs');

function withTemporaryEnv(values, fn) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('submit body wrapper inserts stable source issue marker', () => {
  withTemporaryEnv({ AGENTRIX_TASK_ID: undefined }, () => {
    assert.equal(buildSourceIssueMarker(482), '<!-- issue-flow:source-issue=482 -->');
    assert.equal(
      buildPrBodyWithSourceMarker('Source issue: #111\n\nBody', 482),
      '<!-- issue-flow:source-issue=482 -->\nSource issue: #111\n\nBody'
    );
    assert.equal(
      buildPrBodyWithMarkers('Source issue: #111\n\nBody', 482, 'task-123'),
      '<!-- issue-flow:source-issue=482 -->\n<!-- issue-flow:source source_task_id=task-123 source_runtime=agentrix -->\nSource issue: #111\n\nBody'
    );
  });
});

test('submit body wrapper replaces stale source issue marker', () => {
  withTemporaryEnv({ AGENTRIX_TASK_ID: undefined }, () => {
    assert.equal(
      buildPrBodyWithSourceMarker('<!-- issue-flow:source-issue=111 -->\nBody', 482),
      '<!-- issue-flow:source-issue=482 -->\nBody'
    );
    assert.equal(
      buildPrBodyWithMarkers('<!-- issue-flow:source-issue=111 -->\n<!-- issue-flow:agentrix:task=old -->\nBody', 482, 'new-task'),
      '<!-- issue-flow:source-issue=482 -->\n<!-- issue-flow:source source_task_id=new-task source_runtime=agentrix -->\nBody'
    );
    assert.equal(
      buildPrBodyWithMarkers('Body', 482),
      '<!-- issue-flow:source-issue=482 -->\nBody'
    );
  });
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

test('submit rejects PR body files that are tracked in git', () => {
  assert.equal(isGitTrackedFile('package.json'), true);
  assert.throws(
    () => assertBodyFileNotTracked('package.json'),
    /PR body file must not be committed to the repository/
  );
});

test('submit base branch prefers Agentrix worker base ref over explicit base fallback', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_BASE_BRANCH: undefined,
      CI_DEFAULT_BRANCH: 'main',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: undefined,
      AGENTRIX_BASE_REF: 'release/2026',
      GITLAB_BRIDGE_BASE_REF: undefined,
      GITHUB_BASE_REF: undefined,
      GITHUB_EVENT_PATH: undefined,
      GITLAB_EVENT_PATH: undefined,
    },
    () => {
      assert.equal(resolveBaseBranch({ base: 'develop' }), 'release/2026');
    }
  );
});

test('submit base branch accepts current GitLab bridge base ref', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_BASE_BRANCH: undefined,
      CI_DEFAULT_BRANCH: 'main',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: undefined,
      AGENTRIX_BASE_REF: undefined,
      GITLAB_BRIDGE_BASE_REF: 'release/2026',
      GITLAB_BRIDGE_REF_NAME: undefined,
      GITHUB_BASE_REF: undefined,
      GITHUB_EVENT_PATH: undefined,
      GITLAB_EVENT_PATH: undefined,
    },
    () => {
      assert.equal(resolveBaseBranch({ base: 'develop' }), 'release/2026');
    }
  );
});

test('submit base branch uses explicit base when Agentrix worker base ref is absent', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_BASE_BRANCH: undefined,
      CI_DEFAULT_BRANCH: 'main',
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'target-from-ci',
      AGENTRIX_BASE_REF: undefined,
      GITLAB_BRIDGE_BASE_REF: undefined,
      GITLAB_BRIDGE_REF_NAME: undefined,
      GITHUB_BASE_REF: 'target-from-github',
      GITHUB_EVENT_PATH: undefined,
      GITLAB_EVENT_PATH: undefined,
    },
    () => {
      assert.equal(resolveBaseBranch({ base: 'develop' }), 'develop');
    }
  );
});

test('submit base branch fails fast when no Agentrix worker env or explicit base exists', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_BASE_BRANCH: undefined,
      CI_DEFAULT_BRANCH: undefined,
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: undefined,
      AGENTRIX_BASE_REF: undefined,
      GITLAB_BRIDGE_BASE_REF: undefined,
      GITLAB_BRIDGE_REF_NAME: undefined,
      GITHUB_BASE_REF: undefined,
      GITHUB_EVENT_PATH: undefined,
      GITLAB_EVENT_PATH: undefined,
    },
    () => {
      assert.throws(
        () => resolveBaseBranch({}),
        /Set AGENTRIX_BASE_REF\/GITLAB_BRIDGE_BASE_REF in the worker environment or pass --base <branch>/
      );
    }
  );
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

test('Markdown plan and build submit use their PR or MR labels', () => {
  assert.equal(SUBMIT_KINDS.plan.labelDefinition, labelDefinitionFor('mr-by::plan'));
  assert.equal(SUBMIT_KINDS.build.labelDefinition, labelDefinitionFor('mr-by::build'));
});

test('visual plan mode is enabled only by the opt-in label', () => {
  assert.equal(resolveVisualPlanFeatureMode({ labels: [] }), 'off');
  assert.equal(resolveVisualPlanFeatureMode({ labels: ['feature:visual-plan:on'] }), 'on');
});

test('Decision and Plan publication use their distinct issue gates', () => {
  assert.deepEqual(planSubmissionIssueState('decision'), { flow: 'flow::clarify' });
  assert.deepEqual(planSubmissionIssueState('plan'), { flow: 'flow::approve' });
});

test('Visual Plan publication requires completed Decision artifacts to be removed', () => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-submit-decision-'));
  try {
    const issueRoot = path.join(root, '.issue-flow/issues/42-issue');
    fs.mkdirSync(path.join(issueRoot, 'decision/data'), { recursive: true });
    fs.writeFileSync(path.join(issueRoot, 'decision/data/decision-data.json'), '{}', 'utf8');
    process.chdir(root);
    assert.throws(() => assertDecisionArtifactsRemoved(42), /Delete the completed Decision artifacts/);
    fs.rmSync(path.join(issueRoot, 'decision'), { recursive: true });
    assert.doesNotThrow(() => assertDecisionArtifactsRemoved(42));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Visual Plan publication rejects visual briefs stored with repository artifacts', () => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-submit-brief-'));
  try {
    const briefPath = path.join(root, '.issue-flow/issues/42-issue/plan/data/visual-brief.md');
    fs.mkdirSync(path.dirname(briefPath), { recursive: true });
    fs.writeFileSync(briefPath, '- **Core outcome**: Add export\n', 'utf8');
    process.chdir(root);
    assert.throws(() => assertVisualBriefNotInIssueArtifacts(42), /use the system temporary path/);
    fs.rmSync(briefPath);
    assert.doesNotThrow(() => assertVisualBriefNotInIssueArtifacts(42));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Visual artifacts contain renderable JSON without presentation code', () => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-submit-json-'));
  try {
    const issueRoot = path.join(root, '.issue-flow/issues/42-issue');
    const planPath = path.join(issueRoot, 'plan/data/plan-data.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      schemaVersion: 1,
      artifact: 'plan',
      meta: { title: 'JSON Plan' },
      core: { outcome: 'Render consistently' },
      sections: [
        { id: 'summary', type: 'summary' },
        { id: 'validation', type: 'validation', items: [{ id: 'render' }] },
      ],
    }), 'utf8');
    process.chdir(root);
    assert.doesNotThrow(() => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'));
    fs.writeFileSync(planPath, JSON.stringify({ schemaVersion: 1, artifact: 'plan', meta: { title: 'Bad Plan' }, core: { outcome: 'Bad' }, sections: [{ id: 'bad', type: 'cards', html: '<div />' }] }), 'utf8');
    assert.throws(() => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'), /cannot contain presentation code/);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Visual artifact submission rejects invalid graph relationships and Decision choices', () => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-submit-invalid-json-'));
  try {
    const artifactPath = path.join(root, '.issue-flow/issues/42-issue/plan/data/plan-data.json');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    process.chdir(root);
    fs.writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: 1,
      artifact: 'plan',
      meta: { title: 'Broken graph' },
      core: { outcome: 'Reject broken endpoints' },
      sections: [
        { id: 'summary', type: 'summary' },
        {
          id: 'architecture', type: 'architecture',
          nodes: [{ id: 'engine' }],
          edges: [{ id: 'read', sourceId: 'engine', destinationId: 'missing' }],
        },
        { id: 'validation', type: 'validation', items: [{ id: 'endpoint-check' }] },
      ],
    }), 'utf8');
    assert.throws(
      () => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'),
      /unknown target: missing/,
    );

    const decisionPath = path.join(root, '.issue-flow/issues/42-issue/decision/data/decision-data.json');
    fs.mkdirSync(path.dirname(decisionPath), { recursive: true });
    fs.writeFileSync(decisionPath, JSON.stringify({
      schemaVersion: 1,
      artifact: 'decision',
      meta: { title: 'Broken choice' },
      decisions: [{
        id: 'storage', type: 'choice', question: 'Storage?', recommendedOptionId: 'missing',
        options: [{ id: 'local' }, { id: 'database' }],
      }],
    }), 'utf8');
    assert.throws(
      () => assertVisualArtifactData('.issue-flow/issues/42-issue/decision/data/decision-data.json', 'decision'),
      /recommendedOptionId does not match an option: missing/,
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Visual artifact submission validates chart variants and numeric items', () => {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-submit-chart-json-'));
  try {
    const artifactPath = path.join(root, '.issue-flow/issues/42-issue/plan/data/plan-data.json');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    process.chdir(root);
    const writePlan = (chart) => fs.writeFileSync(artifactPath, JSON.stringify({
      schemaVersion: 1,
      artifact: 'plan',
      meta: { title: 'Chart plan' },
      core: { outcome: 'Render charts' },
      sections: [
        { id: 'summary', type: 'summary' },
        chart,
        { id: 'validation', type: 'validation', items: [{ id: 'chart-check' }] },
      ],
    }), 'utf8');

    writePlan({ id: 'metrics', type: 'chart', variant: 'radar', items: [{ id: 'value', label: 'Value', value: 1 }] });
    assert.throws(
      () => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'),
      /unsupported variant: radar/,
    );

    writePlan({ id: 'metrics', type: 'chart', variant: 'line', items: [{ id: 'value', label: 'Value', value: 'many' }] });
    assert.throws(
      () => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'),
      /must contain a numeric value/,
    );

    writePlan({ id: 'metrics', type: 'chart', variant: 'donut', items: [{ id: 'value', label: 'Value', value: 1 }] });
    assert.doesNotThrow(() => assertVisualArtifactData('.issue-flow/issues/42-issue/plan/data/plan-data.json', 'plan'));
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('visual publishing uses ISSUE_FLOW_BASE_URL as its service URL', () => {
  withTemporaryEnv({ ISSUE_FLOW_BASE_URL: 'https://flow.example/' }, () => {
    assert.equal(resolveIssueFlowBaseUrl(), 'https://flow.example');
  });
});

test('visual artifact URLs use Git server and provider project routes', () => {
  assert.equal(
    visualArtifactUrl('https://flow.example', 'gitlab-main', '43326', 42),
    'https://flow.example/repos/gitlab-main/43326/plan/42'
  );
  const comment = buildVisualArtifactComment({
    artifact: 'plan',
    format: 'json',
    repositoryId: 'repo_123',
    issueNumber: 42,
    branch: '42-broken-login/plan',
    commit: 'abc123',
    artifactPath: '.issue-flow/issues/42-broken-login/plan/data/plan-data.json',
    url: 'https://flow.example/repos/gitlab-main/43326/plan/42',
  });
  assert.match(comment, /issue-flow:plan-artifact artifact=plan format=json repo=repo_123 issue=42/);
  assert.match(comment, /https:\/\/flow\.example\/repos\/gitlab-main\/43326\/plan\/42/);
  assert.match(comment, /Review comments and approval are recorded on this PR\/MR/);
});

test('visual artifact submission replies with the shared review URL on the PR or MR', () => {
  const comment = buildVisualArtifactPublishedComment({
    artifact: 'plan',
    format: 'json',
    commit: 'abc123',
    url: 'https://flow.example/repos/gitlab-main/43326/plan/42',
  });
  assert.match(comment, /issue-flow:plan-artifact-published artifact=plan commit=abc123/);
  assert.match(comment, /Visual Plan 已发布/);
  assert.match(comment, /https:\/\/flow\.example\/repos\/gitlab-main\/43326\/plan\/42/);
  assert.equal(pullRequestNumberFromUrl('https://github.com/acme/widget/pull/19'), 19);
  assert.equal(pullRequestNumberFromUrl('https://gitlab.example/acme/widget/-/merge_requests/23'), 23);
  assert.equal(pullRequestNumberFromUrl('https://gitlab.example/acme/widget'), undefined);
});

test('visual artifact publication posts the URL as an MR comment', async () => {
  const calls = [];
  const provider = {
    name: 'gitlab',
    createPullRequestComment: async (pullRequest, body, options) => {
      calls.push({ pullRequest, body, options });
      return { id: 501 };
    },
  };
  await publishVisualArtifactComment(
    provider,
    { fullName: 'acme/widget', projectId: '43326' },
    'https://gitlab.example/acme/widget/-/merge_requests/23',
    { artifact: 'decision', format: 'json', commit: 'abc123', url: 'https://flow.example/repos/gitlab-main/43326/plan/42' },
    { dryRun: false },
  );
  assert.equal(calls[0].pullRequest.number, 23);
  assert.match(calls[0].body, /Decision 已发布/);
  assert.match(calls[0].body, /https:\/\/flow\.example\/repos\/gitlab-main\/43326\/plan\/42/);
});

test('plan artifact marker records visual and Markdown formats in the MR body', () => {
  assert.equal(
    buildVisualArtifactMarker({
      artifact: 'decision',
      format: 'json',
      repositoryId: 'repo_123',
      issueNumber: 42,
      branch: '42-issue/plan',
      commit: 'abc123',
      artifactPath: '.issue-flow/issues/42-issue/decision/data/decision-data.json',
    }),
    '<!-- issue-flow:plan-artifact artifact=decision format=json repo=repo_123 issue=42 branch=42-issue/plan commit=abc123 path=.issue-flow/issues/42-issue/decision/data/decision-data.json -->'
  );
  assert.match(
    buildVisualArtifactComment({
      artifact: 'plan',
      format: 'markdown',
      repositoryId: 'repo_123',
      issueNumber: 42,
      branch: '42-issue/plan',
      commit: 'def456',
      artifactPath: '.issue-flow/issues/42-issue/plan/plan.md',
      url: 'https://flow.example/repos/gitlab-main/43326/plan/42',
    }),
    /## Markdown Plan[\s\S]*Format: `markdown`/
  );
});

test('submit source issue size validation blocks missing and conflicting size labels', () => {
  assert.throws(
    () => validateSourceIssueSize({ labels: ['status::active', 'flow::plan'] }, 42),
    /issue-flow issue apply --issue 42 --size size::M/
  );
  assert.throws(
    () => validateSourceIssueSize({ labels: ['size::S', 'size::M'] }, 42),
    /more than one size:: label: size::S, size::M/
  );
  assert.throws(
    () => validateSourceIssueSize({ labels: ['size::XXL'] }, 42),
    /invalid size:: label: size::XXL/
  );
  assert.deepEqual(validateSourceIssueSize({ labels: ['size::XL'] }, 42), {
    ok: true,
    label: 'size::XL',
    weight: 5,
  });
});

test('submit push auth uses GitHub token as temporary askpass credentials', () => {
  withTemporaryEnv(
    {
      GITHUB_TOKEN: 'github-token-123',
      GH_TOKEN: undefined,
      GIT_ASKPASS: undefined,
    },
    () => {
      assert.equal(gitPushTokenForProvider('github'), 'github-token-123');
      assert.equal(gitPushUsernameForProvider('github', 'github-token-123'), 'x-access-token');

      const askpass = createGitAskpassEnv('github');
      try {
        assert.equal(askpass.env.GIT_TERMINAL_PROMPT, '0');
        assert.equal(askpass.env.ISSUE_FLOW_GIT_USERNAME, 'x-access-token');
        assert.equal(askpass.env.ISSUE_FLOW_GIT_TOKEN, 'github-token-123');
        assert.equal(
          spawnSync(askpass.env.GIT_ASKPASS, ['Username for https://github.com'], {
            encoding: 'utf8',
            env: askpass.env,
          }).stdout.trim(),
          'x-access-token'
        );
        assert.equal(
          spawnSync(askpass.env.GIT_ASKPASS, ['Password for https://github.com'], {
            encoding: 'utf8',
            env: askpass.env,
          }).stdout.trim(),
          'github-token-123'
        );
      } finally {
        askpass.cleanup();
      }
    }
  );
});

test('submit push auth uses GitLab CI job token username for askpass', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_GITLAB_TOKEN: undefined,
      GITLAB_TOKEN: undefined,
      GL_TOKEN: undefined,
      GITLAB_PRIVATE_TOKEN: undefined,
      CI_JOB_TOKEN: 'ci-job-token-123',
      GIT_ASKPASS: undefined,
    },
    () => {
      assert.equal(gitPushTokenForProvider('gitlab'), 'ci-job-token-123');
      assert.equal(gitPushUsernameForProvider('gitlab', 'ci-job-token-123'), 'gitlab-ci-token');

      const askpass = createGitAskpassEnv('gitlab');
      try {
        assert.equal(askpass.env.ISSUE_FLOW_GIT_USERNAME, 'gitlab-ci-token');
        assert.equal(askpass.env.ISSUE_FLOW_GIT_TOKEN, 'ci-job-token-123');
      } finally {
        askpass.cleanup();
      }
    }
  );
});

test('submit push auth prefers issue-flow GitLab token over generic GitLab tokens', () => {
  withTemporaryEnv(
    {
      ISSUE_FLOW_GITLAB_TOKEN: 'issue-flow-gitlab-token-123',
      GITLAB_TOKEN: 'generic-gitlab-token-123',
      GL_TOKEN: undefined,
      GITLAB_PRIVATE_TOKEN: undefined,
      CI_JOB_TOKEN: 'ci-job-token-123',
      GIT_ASKPASS: undefined,
    },
    () => {
      assert.equal(gitPushTokenForProvider('gitlab'), 'issue-flow-gitlab-token-123');
      assert.equal(gitPushUsernameForProvider('gitlab', 'issue-flow-gitlab-token-123'), 'oauth2');

      const askpass = createGitAskpassEnv('gitlab');
      try {
        assert.equal(askpass.env.ISSUE_FLOW_GIT_USERNAME, 'oauth2');
        assert.equal(askpass.env.ISSUE_FLOW_GIT_TOKEN, 'issue-flow-gitlab-token-123');
      } finally {
        askpass.cleanup();
      }
    }
  );
});
