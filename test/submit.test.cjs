const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  assertBodyFileNotTracked,
  buildAgentrixTaskMarker,
  buildPrBodyWithMarkers,
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
  resolveBaseBranch,
  SUBMIT_KINDS,
  validateIssueFlowBranch,
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
    assert.equal(buildAgentrixTaskMarker('task-123'), '<!-- issue-flow:agentrix:task=task-123 -->');
    assert.equal(
      buildPrBodyWithSourceMarker('Source issue: #111\n\nBody', 482),
      '<!-- issue-flow:source-issue=482 -->\nSource issue: #111\n\nBody'
    );
    assert.equal(
      buildPrBodyWithMarkers('Source issue: #111\n\nBody', 482, 'task-123'),
      '<!-- issue-flow:source-issue=482 -->\n<!-- issue-flow:agentrix:task=task-123 -->\n<!-- issue-flow:source source_task_id=task-123 -->\nSource issue: #111\n\nBody'
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
      '<!-- issue-flow:source-issue=482 -->\n<!-- issue-flow:agentrix:task=new-task -->\n<!-- issue-flow:source source_task_id=new-task -->\nBody'
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

test('submit kinds use catalog definitions for PR and MR labels', () => {
  assert.equal(SUBMIT_KINDS.plan.labelDefinition, labelDefinitionFor('mr-by::plan'));
  assert.equal(SUBMIT_KINDS.build.labelDefinition, labelDefinitionFor('mr-by::build'));
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
