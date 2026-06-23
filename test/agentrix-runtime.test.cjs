const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

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

test('agentrix mention extraction keeps manual instruction text', () => {
  assert.deepEqual(agentrix.extractMention('@agentrix: please plan this'), {
    triggered: true,
    instruction: 'please plan this',
  });
  assert.deepEqual(agentrix.extractMention('/agentrix please plan this'), {
    triggered: true,
    instruction: 'please plan this',
  });
  assert.deepEqual(agentrix.extractMention('@bot please plan this'), {
    triggered: false,
    instruction: '',
  });
});

test('agentrix config only customizes prompt, template, and plan root paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-agentrix-test-'));
  try {
    const configPath = path.join(root, 'issue-flow.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agentrix: {
          promptsDir: 'custom/prompts',
          templatesDir: 'custom/templates',
          planRootDir: 'custom/issues',
        },
      })
    );

    const config = agentrix.resolveAgentrixConfig({ config: configPath });
    assert.equal(agentrix.normalizeRepoPath(config.projectPromptsDir), 'custom/prompts');
    assert.equal(agentrix.normalizeRepoPath(config.projectTemplatesDir), 'custom/templates');
    assert.equal(agentrix.normalizeRepoPath(config.planRootDir), 'custom/issues');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agentrix prompt falls back to built-in defaults and injects fixed plan conventions', () => {
  const prompt = agentrix.buildPrompt(
    'plan',
    {
      number: 42,
      state: 'open',
      labels: ['status::active', 'type::bug', 'flow::plan', 'automation::plan', 'priority::p2'],
      title: 'Broken login',
      body: 'Cannot log in.',
    },
    {},
    { planRootDir: '.work/items' }
  );

  assert.match(prompt, /针对当前 issue 产出可审阅的根因与修复方案/);
  assert.match(prompt, /## Plan Output/);
  assert.match(prompt, /Plan output file: `\.work\/items\/42-broken-login\/plan\/001-root-cause-and-fix\.md`/);
  assert.match(prompt, /Plan branch: `42-broken-login\/plan`/);
  assert.match(prompt, /PR body: write it to a repo-external temp file/);
  assert.match(prompt, /issue-flow pr submit/);
  assert.match(prompt, /do not put it in git/);
  assert.match(prompt, /do not call `gh`, `glab`, `gh api`, `glab api`/);
  assert.match(prompt, /## Required Skill/);
  assert.match(prompt, /Read this project-level skill file before acting: `skills\/issue-flow\/SKILL\.md`/);
  assert.match(prompt, /^Labels: type::bug, priority::p2$/m);
  assert.doesNotMatch(prompt, /^State: open$/m);
  assert.doesNotMatch(prompt, /^Labels: .*status::active/m);
  assert.doesNotMatch(prompt, /^Labels: .*flow::plan/m);
  assert.doesNotMatch(prompt, /^Labels: .*automation::plan/m);
  assert.doesNotMatch(prompt, /Agentrix Issue-Flow Paths/);
  assert.doesNotMatch(prompt, /Prompt override directory/);
  assert.doesNotMatch(prompt, /Template override directory/);
  assert.doesNotMatch(prompt, /Plan root directory/);
});

test('agentrix build prompt injects build context without plan output section', () => {
  withTemporaryEnv({ AGENTRIX_BASE_REF: 'main' }, () => {
    const prompt = agentrix.buildPrompt(
      'build',
      {
        number: 42,
        state: 'open',
        labels: ['type::feature', 'flow::build'],
        title: 'Add export button',
        body: 'Add CSV export.',
      },
      {},
      { planRootDir: '.work/items' }
    );

    assert.match(prompt, /## Branch/);
    assert.match(prompt, /Create or switch to this non-base branch before committing: `42-add-export-button\/build`/);
    assert.match(prompt, /## Plan Files/);
    assert.match(prompt, /PR body: write it to a repo-external temp file/);
    assert.match(prompt, /Base branch: `main`/);
    assert.match(prompt, /If that env var is absent, pass `--base main` explicitly/);
    assert.match(prompt, /issue-flow pr submit/);
    assert.match(prompt, /do not put it in git/);
    assert.match(prompt, /Read this project-level skill file before acting: `skills\/issue-flow\/SKILL\.md`/);
    assert.doesNotMatch(prompt, /先判断根因类别/);
    assert.doesNotMatch(prompt, /## Plan Output/);
    assert.doesNotMatch(prompt, /Agentrix Issue-Flow Paths/);
  });
});

test('agentrix build prompt uses CI failure template for failure intake issues', () => {
  const prompt = agentrix.buildPrompt(
    'build',
    {
      number: 563,
      state: 'open',
      labels: ['type::ops', 'failure::ci', 'flow::build', 'automation::build', 'size::M'],
      title: 'Fix CI failure: CI / test',
      body: '<!-- issue-flow:pipeline-failure\nfingerprint: sha256:abc\n-->\n# CI Failure Analysis',
    },
    {},
    { planRootDir: '.work/items' }
  );

  assert.match(prompt, /定位 CI failure intake 创建的失败 issue/);
  assert.match(prompt, /先判断根因类别/);
  assert.match(prompt, /repository regression、workflow config、provider permission/);
  assert.match(prompt, /只有确认是仓库代码回归时，才把 `type::ops` 改成 `type::bug`/);
  assert.match(prompt, /不要硬改业务代码/);
  assert.match(prompt, /PR body 写清 Source issue、Root cause、Fix、Validation/);
  assert.match(prompt, /Create or switch to this non-base branch before committing: `563-fix-ci-failure-ci-test\/build`/);
  assert.match(prompt, /^Labels: type::ops, failure::ci, size::M$/m);
});

test('agentrix build prompt uses CI failure template when only the body marker remains', () => {
  const prompt = agentrix.buildPrompt(
    'build',
    {
      number: 564,
      state: 'open',
      labels: ['type::ops', 'flow::build', 'automation::build', 'size::M'],
      title: 'Fix CI failure: Deploy',
      body: '<!-- issue-flow:pipeline-failure\nfingerprint: sha256:def\n-->',
    },
    {},
    { planRootDir: '.work/items' }
  );

  assert.match(prompt, /定位 CI failure intake 创建的失败 issue/);
  assert.match(prompt, /^Labels: type::ops, size::M$/m);
});

test('agentrix run args forward target base ref from Agentrix bridge env', () => {
  withTemporaryEnv({ AGENTRIX_BASE_REF: 'main' }, () => {
    const args = agentrix.buildRunArgs(
      'build',
      {
        provider: 'gitlab',
        repoFullName: 'ai-arch/test',
        number: 42,
        title: 'Add export button',
      },
      {},
      {},
      'prompt',
      '/tmp/result.json'
    );

    assert.equal(args[args.indexOf('--base-ref') + 1], 'main');
  });
});

test('agentrix prompt context keeps size labels visible without extra prompt guidance', () => {
  const triagePrompt = agentrix.buildPrompt(
    'triage',
    {
      number: 42,
      state: 'open',
      labels: ['status::active', 'flow::triage', 'size::M', 'type::feature'],
      title: 'Add export button',
      body: 'Add CSV export.',
    }
  );
  assert.match(triagePrompt, /^Labels: size::M, type::feature$/m);
  assert.doesNotMatch(triagePrompt, /issue-flow issue apply --issue <n> --size/);
});

test('agentrix review prompt uses target URL and review submission script', () => {
  const prompt = agentrix.buildPullRequestPrompt({
    provider: 'github',
    repoFullName: 'example/platform',
    number: 9,
    state: 'open',
    draft: false,
    merged: false,
    baseRef: 'main',
    headRef: '42-add-export-button/build',
    labels: ['mr-by::build'],
    author: 'alice',
    htmlUrl: 'https://github.com/example/platform/pull/9',
    title: 'Build #42: Add export button',
    headSha: 'abc123',
    body: '<!-- issue-flow:source-issue=42 -->\nAdds export support.',
  });

  assert.match(prompt, /## Review Target/);
  assert.match(prompt, /URL: https:\/\/github\.com\/example\/platform\/pull\/9/);
  assert.match(prompt, /## Review Submission/);
  assert.match(prompt, /cli\.cjs pr review --pr 9 --body-file <tmp-review-body-file> \[--comments-file <tmp-inline-comments-json>\]/);
  assert.doesNotMatch(prompt, /--expected-head/);
  assert.match(prompt, /inline review comments/);
  assert.match(prompt, /do not call `gh`, `glab`, `gh api`, `glab api`/);
  assert.match(prompt, /使用下方 review 提交命令发布结果/);
  assert.doesNotMatch(prompt, /## Issue/);
  assert.doesNotMatch(prompt, /Possible source issue/);
  assert.doesNotMatch(prompt, /flow::triage/);
  assert.doesNotMatch(prompt, /automation::build/);
});

test('agentrix review run args include source issue number', () => {
  const args = agentrix.buildRunArgs(
    'review',
    {
      provider: 'github',
      repoFullName: 'example/platform',
      number: 9,
      title: 'Build #42: Add export button',
      body: '<!-- issue-flow:source-issue=42 -->',
    },
    {
      baseUrl: 'https://agentrix.example.test',
      apiKey: 'test-key',
      runnerId: 'runner-1',
    },
    {},
    'prompt',
    '/tmp/result.json'
  );

  assert.equal(args[args.indexOf('--issue-number') + 1], '42');
  assert.ok(args.includes('issue_flow_pr=example/platform#9'));
  assert.ok(args.includes('issue_flow_source_issue=example/platform#42'));
});

test('agentrix default prompts delegate script details to the issue-flow skill', () => {
  const promptsDir = path.resolve(__dirname, '..', 'skills', 'issue-flow', 'assets', 'agentrix', 'runtime', 'prompts');
  for (const entry of fs.readdirSync(promptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.prompt.md')) {
      continue;
    }
    const body = fs.readFileSync(path.join(promptsDir, entry.name), 'utf8');
    assert.doesNotMatch(body, /\$\{CLAUDE_SKILL_DIR\}/, entry.name);
    assert.doesNotMatch(body, /scripts\/[a-z-]+\.cjs/, entry.name);
  }
});

test('agentrix general prompt includes create issue guidance', () => {
  const prompt = agentrix.buildPrompt(
    'general',
    {
      number: 42,
      state: 'open',
      labels: ['status::active'],
      title: 'Discussed requirement',
      body: 'Context',
    },
    { instruction: 'create an issue for this' }
  );

  assert.match(prompt, /issue-flow issue create/);
  assert.match(prompt, /automation::off/);
});

test('agentrix task marker uses issue-flow namespace', () => {
  assert.equal(agentrix.buildTaskCommentMarker('build'), '<!-- issue-flow:agentrix:task:build -->');
  assert.equal(
    agentrix.buildTaskCommentMarker('review', { headSha: 'abc123' }),
    '<!-- issue-flow:agentrix:task:review -->'
  );
  assert.match(
    agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
      pullRequest: {
        body: '<!-- issue-flow:agentrix:task=task-build -->',
        headSha: 'abc123',
      },
    }),
    /Review task: `task-review`/
  );
  assert.match(
    agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
      pullRequest: {
        body: '<!-- issue-flow:agentrix:task=task-build -->',
        headSha: 'abc123',
      },
    }),
    /Build task: `task-build`/
  );
  assert.match(
    agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
      pullRequest: {
        body: '<!-- issue-flow:agentrix:task=task-build -->',
        headSha: 'abc123',
      },
    }),
    /Head: `abc123`/
  );
  assert.match(
    agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, { pullRequest: { headSha: 'abc123' } }),
    /<!-- issue-flow:source source_task_id=task-review source_agent=codex -->/
  );
  assert.match(
    agentrix.buildTaskComment('review', { status: 'starting' }, { pullRequest: { headSha: 'abc123' } }),
    /<!-- issue-flow:source source_agent=codex -->/
  );
  assert.equal(
    agentrix.buildTaskCommentMarker('task_resume', { reviewComment: { id: 101 } }),
    '<!-- issue-flow:agentrix:task:resume-review-comment:101 -->'
  );
  assert.equal(
    agentrix.buildTaskCommentMarker('task_resume', { reviewComment: { id: 101, reviewId: 9 } }),
    '<!-- issue-flow:agentrix:task:resume-review-comment:review:9 -->'
  );
  assert.doesNotMatch(agentrix.buildTaskComment('build', { status: 'starting' }), /issue-flow:task:agentrix/);
});

test('agentrix extracts task run and reviewed head from task comments', () => {
  const comment = agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
    pullRequest: { headSha: 'abc123' },
  });

  assert.equal(agentrix.extractRunIdFromTaskComment(comment), 'task-review');
  assert.equal(agentrix.extractReviewHeadShaFromTaskComment(comment), 'abc123');
  assert.equal(agentrix.extractReviewHeadShaFromTaskComment('<!-- issue-flow:agentrix:task:review:legacy-sha -->'), '');
});

test('agentrix extracts PR/MR task id only from pull request body marker', () => {
  assert.equal(
    agentrix.extractAgentrixTaskIdFromPullRequest({
      body: '<!-- issue-flow:agentrix:task=task-123 -->\nBody',
    }),
    'task-123'
  );
  assert.equal(
    agentrix.extractAgentrixTaskIdFromPullRequest({
      title: '<!-- issue-flow:agentrix:task=task-123 -->',
      body: '',
    }),
    ''
  );
});

test('agentrix resume task args use resume mode without new task metadata', () => {
  const args = agentrix.buildResumeTaskArgs(
    'task-123',
    '有新的 PR/MR review comment，请查看并处理。',
    {
      baseUrl: 'https://agentrix.example.test',
      apiKey: 'test-key',
      runnerId: 'runner-1',
    },
    {
      pullRequest: { repoFullName: 'example/platform', number: 9 },
      reviewComment: { id: '101' },
      sourceIssueNumber: 42,
    },
    '/tmp/result.json'
  );

  assert.equal(args[args.indexOf('--resume') + 1], 'task-123');
  assert.equal(args[1], '@agentrix/agentrix-run@0.7.0');
  assert.ok(args.includes('--prompt'));
  assert.equal(args[args.indexOf('--response-mode') + 1], 'async');
  assert.equal(args[args.indexOf('--result-file') + 1], '/tmp/result.json');
  assert.ok(args.includes('issue_flow_pr=example/platform#9'));
  assert.ok(args.includes('issue_flow_review_comment=101'));
  assert.ok(args.includes('issue_flow_source_issue=example/platform#42'));
  assert.equal(args.includes('--runner-id'), false);
  assert.equal(args.includes('--issue-number'), false);
  assert.equal(args.includes('--title'), false);
});

test('agentrix-run child env does not forward provider tokens', () => {
  const env = agentrix.buildAgentrixRunEnv(
    { envEventName: 'GITHUB_EVENT_NAME' },
    'review',
    {
      GITHUB_TOKEN: 'actions-token',
      GH_TOKEN: 'user-token',
      GITLAB_TOKEN: 'gitlab-token',
      GL_TOKEN: 'gl-token',
      GITLAB_PRIVATE_TOKEN: 'private-token',
      CI_JOB_TOKEN: 'ci-job-token',
      ISSUE_FLOW_GIT_TOKEN: 'git-token',
      GITHUB_EVENT_NAME: 'pull_request',
      AGENTRIX_API_KEY: 'agentrix-key',
      AGENTRIX_RUNNER_ID: 'runner-1',
    }
  );

  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.GL_TOKEN, undefined);
  assert.equal(env.GITLAB_PRIVATE_TOKEN, undefined);
  assert.equal(env.CI_JOB_TOKEN, undefined);
  assert.equal(env.ISSUE_FLOW_GIT_TOKEN, undefined);
  assert.equal(env.AGENTRIX_API_KEY, 'agentrix-key');
  assert.equal(env.AGENTRIX_RUNNER_ID, 'runner-1');
  assert.equal(env.AGENTRIX_EVENT_NAME, 'pull_request');
  assert.equal(env.AGENTRIX_EVENT_ACTION, 'review');
});

test('agentrix review comment resume instruction stays minimal', () => {
  const prompt = agentrix.buildReviewCommentResumeInstruction(
    {
      number: 9,
      htmlUrl: 'https://github.com/example/platform/pull/9',
    },
    {
      id: '101',
      htmlUrl: 'https://github.com/example/platform/pull/9#discussion_r101',
      path: 'src/app.js',
      line: 42,
      author: 'reviewer',
      body: 'Please handle this edge case.',
    },
    {
      sourceIssueNumber: 42,
    }
  );

  assert.match(prompt, /PR\/MR 有新的 review comment/);
  assert.match(prompt, /普通总结 comment/);
  assert.match(prompt, /不要创建新的 inline review comment/);
  assert.doesNotMatch(prompt, /https:\/\/github\.com\/example\/platform\/pull\/9/);
  assert.doesNotMatch(prompt, /src\/app\.js/);
  assert.doesNotMatch(prompt, /Please handle this edge case/);
  assert.doesNotMatch(prompt, /review-comments/);
});
