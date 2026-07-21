/**
 * [INPUT]: 依赖 agentrix runtime 的 prompt/run/comment 构造能力
 * [OUTPUT]: 对外提供 Agentrix runtime 的行为回归测试
 * [POS]: test 套件中的 Agentrix runtime 契约验证，覆盖提示拼装、任务参数与评论标记
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');
const PROVIDER_CLI_RULE = 'Provider actions covered by issue-flow must go through its unified CLI; do not call `gh`, `glab`, `gh api`, `glab api`, or hand-write provider API requests for those actions.';
// Prompt 中的 SKILL.md 路径相对 process.cwd() 生成，期望值按同一规则计算，
// 使测试从仓库根或 plugin/ 目录运行都成立。
const REQUIRED_SKILL_PATH = path
  .relative(process.cwd(), path.resolve(__dirname, '..', 'skills', 'issue-flow', 'SKILL.md'))
  .replace(/\\/g, '/')
  .replace(/^\.?\//, '');
const REQUIRED_SKILL_BLOCK = `## Required Skill\n\nRead this project-level skill file before acting: \`${REQUIRED_SKILL_PATH}\`\n${PROVIDER_CLI_RULE}`;

function assertRequiredSkillAtEnd(prompt) {
  assert.equal(prompt.trimEnd().endsWith(REQUIRED_SKILL_BLOCK), true);
  assert.equal(
    prompt.indexOf(PROVIDER_CLI_RULE),
    prompt.lastIndexOf(PROVIDER_CLI_RULE),
    'provider CLI rule must only be injected once, not duplicated in prompt bodies'
  );
  assert.doesNotMatch(prompt, /不得直接调用/);
}

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

test('agentrix command logging shell-quotes args and redacts api key', () => {
  const command = agentrix.redactedCommand('npx', [
    '--yes',
    '@agentrix/agentrix-run@latest',
    '--api-key',
    'sk-secret-value',
    '--title',
    "Review PR #8: Bob's change",
    '--prompt',
    'line one\nline two',
  ]);

  assert.equal(
    command,
    "npx --yes @agentrix/agentrix-run@latest --api-key '[redacted]' --title 'Review PR #8: Bob'\\''s change' --prompt 'line one\nline two'"
  );
  assert.doesNotMatch(command, /sk-secret-value/);
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
  assertRequiredSkillAtEnd(prompt);
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

test('agentrix plan prompt enables visual artifacts only with the issue feature label', () => {
  const prompt = agentrix.buildPrompt('plan', {
    number: 42,
    labels: ['type::bug', 'size::M', 'feature:visual-plan:on'],
    title: 'Broken login',
    body: 'Cannot log in.',
  }, {}, { planRootDir: '.issue-flow/issues' });

  assert.match(prompt, /Decision 或根因修复 Visual Plan/);
  assert.match(prompt, /Plan output JSON: `\.issue-flow\/issues\/42-broken-login\/plan\/data\/plan-data\.json`/);
  const visualBriefPath = path.join(os.tmpdir(), 'issue-flow', 'visual-plan', '42-broken-login', 'visual-brief.md').replace(/\\/g, '/');
  assert.equal(prompt.includes(`Temporary visual brief (do not commit): \`${visualBriefPath}\``), true);
  assert.doesNotMatch(prompt, /plan\/data\/visual-brief\.md/);
  assert.match(prompt, /--artifact <decision\|plan>/);
  assert.doesNotMatch(prompt, /PR body:/);
  assert.match(prompt.trimEnd(), /skills\/vision-plan\/SKILL\.md`$/);
});

test('agentrix build prompt injects explicit task base context without plan output section', () => {
  withTemporaryEnv({ AGENTRIX_BASE_REF: 'ignored-main' }, () => {
    const prompt = agentrix.buildPrompt(
      'build',
      {
        number: 42,
        state: 'open',
        labels: ['type::feature', 'flow::build'],
        title: 'Add export button',
        body: 'Add CSV export.',
      },
      { baseRef: 'main' },
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
    assertRequiredSkillAtEnd(prompt);
    assert.doesNotMatch(prompt, /先判断根因类别/);
    assert.doesNotMatch(prompt, /## Plan Output/);
    assert.doesNotMatch(prompt, /Agentrix Issue-Flow Paths/);
  });
});

test('agentrix build prompt provides only the visual plan JSON path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-visual-build-'));
  try {
    const planDir = path.join(root, '42-add-export-button', 'plan');
    fs.mkdirSync(path.join(planDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(planDir, 'data', 'plan-data.json'), '{not parsed by runtime');
    fs.writeFileSync(path.join(planDir, '001-implementation.md'), '# Markdown plan\n');

    const visualPrompt = agentrix.buildPrompt('build', {
      number: 42,
      labels: ['type::feature', 'flow::build', 'feature:visual-plan:on'],
      title: 'Add export button',
      body: 'Add CSV export.',
    }, {}, { planRootDir: root });
    assert.match(visualPrompt, /plan\/data\/plan-data\.json/);
    assert.doesNotMatch(visualPrompt, /\*\*Core outcome\*\*: Add export/);
    assert.doesNotMatch(visualPrompt, /visual-brief\.md/);
    assert.doesNotMatch(visualPrompt, /not parsed by runtime/);
    assert.doesNotMatch(visualPrompt, /001-implementation\.md/);

    const markdownPrompt = agentrix.buildPrompt('build', {
      number: 42,
      labels: ['type::feature', 'flow::build'],
      title: 'Add export button',
      body: 'Add CSV export.',
    }, {}, { planRootDir: root });
    assert.match(markdownPrompt, /001-implementation\.md/);
    assert.doesNotMatch(markdownPrompt, /plan-data\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('agentrix build prompt ignores GitLab bridge base ref when task base is explicit', () => {
  withTemporaryEnv({ AGENTRIX_BASE_REF: undefined, GITLAB_BRIDGE_BASE_REF: 'main' }, () => {
    const prompt = agentrix.buildPrompt(
      'build',
      {
        number: 42,
        state: 'open',
        labels: ['type::feature', 'flow::build'],
        title: 'Add export button',
        body: 'Add CSV export.',
      },
      { baseRef: 'release/2026' },
      { planRootDir: '.work/items' }
    );

    assert.match(prompt, /Base branch: `release\/2026`/);
    assert.match(prompt, /pass `--base release\/2026` explicitly/);
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

test('agentrix run args ignore dispatch env and forward explicit task base ref', () => {
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
      { baseRef: 'release/2026' },
      'prompt',
      '/tmp/result.json'
    );

    assert.equal(args[args.indexOf('--base-ref') + 1], 'release/2026');
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
  assert.match(prompt, /^Number: #9$/m);
  assert.match(prompt, /^Source issue: #42$/m);
  assert.match(prompt, /URL: https:\/\/github\.com\/example\/platform\/pull\/9/);
  assert.match(prompt, /## Review Submission/);
  assert.match(prompt, /cli\.cjs pr review --pr 9 --body-file <tmp-review-body-file> \[--comments-file <tmp-inline-comments-json>\] \[--as-comment\]/);
  assert.doesNotMatch(prompt, /--expected-head/);
  assert.match(prompt, /inline review comments/);
  assertRequiredSkillAtEnd(prompt);
  assert.match(prompt, /没有明确问题时加 `--as-comment`/);
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

test('agentrix default general prompt delegates create issue guidance to the required skill', () => {
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

  assertRequiredSkillAtEnd(prompt);

  const defaultPrompt = fs.readFileSync(
    path.resolve(__dirname, '..', 'skills', 'issue-flow', 'assets', 'agentrix', 'runtime', 'prompts', 'general.prompt.md'),
    'utf8',
  );
  assert.doesNotMatch(defaultPrompt, /issue-flow issue create/);
  assert.doesNotMatch(defaultPrompt, /automation::off/);

  const skill = fs.readFileSync(path.resolve(__dirname, '..', 'skills', 'issue-flow', 'SKILL.md'), 'utf8');
  assert.match(skill, /开放讨论已经形成清晰需求/);
  assert.match(skill, /automation::off/);
});

test('agentrix task marker uses issue-flow namespace', () => {
  assert.equal(agentrix.buildTaskCommentMarker('build'), '<!-- issue-flow:agentrix:task:build -->');
  assert.equal(
    agentrix.buildTaskCommentMarker('review', { headSha: 'abc123' }),
    '<!-- issue-flow:agentrix:task:review -->'
  );
  const reviewComment = agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, {
    pullRequest: {
      body: '<!-- issue-flow:source source_task_id=task-build source_runtime=agentrix -->',
      headSha: 'abc123',
    },
  });
  assert.match(
    reviewComment,
    /^- Review task: `task-review`$/m
  );
  assert.match(
    reviewComment,
    /^- Build task: `task-build`$/m
  );
  assert.match(
    reviewComment,
    /^- Head: `abc123`$/m
  );
  assert.equal(agentrix.extractRunIdFromTaskComment(reviewComment), 'task-review');
  assert.equal(agentrix.extractReviewHeadShaFromTaskComment(reviewComment), 'abc123');
  assert.equal(agentrix.extractRunIdFromTaskComment('Review task: `legacy-task`'), 'legacy-task');
  assert.equal(agentrix.extractReviewHeadShaFromTaskComment('Head: `legacy-head`'), 'legacy-head');
  assert.match(
    agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' }, { pullRequest: { headSha: 'abc123' } }),
    /<!-- issue-flow:source source_task_id=task-review source_agent=codex source_runtime=agentrix -->/
  );
  withTemporaryEnv({ AGENTRIX_TASK_ID: undefined }, () => {
    assert.match(
      agentrix.buildTaskComment('review', { status: 'starting' }, { pullRequest: { headSha: 'abc123' } }),
      /<!-- issue-flow:source source_agent=codex source_runtime=agentrix -->/
    );
  });
  assert.equal(
    agentrix.buildTaskCommentMarker('task_resume', { reviewComment: { id: 101 } }),
    '<!-- issue-flow:agentrix:task:resume-review-comment:101 -->'
  );
  assert.equal(
    agentrix.buildTaskCommentMarker('task_resume', { reviewComment: { id: 101, reviewId: 9 } }),
    '<!-- issue-flow:agentrix:task:resume-review-comment:review:9 -->'
  );
  const visualResumeComment = agentrix.buildTaskComment(
    'task_resume',
    { status: 'dry-run', runId: 'task-plan' },
    {
      agentrixTaskId: 'task-plan',
      issueTask: { action: 'plan', taskId: 'task-plan' },
      comment: { htmlUrl: 'https://github.com/example/platform/issues/42#issuecomment-501' },
    }
  );
  assert.match(visualResumeComment, /^Action: `plan`$/m);
  assert.match(visualResumeComment, /^Run: `task-plan`$/m);
  assert.match(visualResumeComment, /Trigger: https:\/\/github\.com\/example\/platform\/issues\/42#issuecomment-501/);
  assert.doesNotMatch(visualResumeComment, /^Agentrix task:/m);
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

test('agentrix extracts only resumable issue tasks from task comments', () => {
  const taskComment = {
    id: 300,
    html_url: 'https://github.com/example/platform/issues/42#issuecomment-300',
    body: agentrix.buildTaskComment('plan', {
      status: 'queued',
      runId: 'task-plan',
      detailUrl: 'https://agentrix.example/tasks/task-plan',
    }),
  };

  assert.deepEqual(agentrix.extractIssueTaskFromTaskComment(taskComment), {
    action: 'plan',
    taskId: 'task-plan',
    commentId: '300',
    commentUrl: 'https://github.com/example/platform/issues/42#issuecomment-300',
    detailUrl: 'https://agentrix.example/tasks/task-plan',
  });
  assert.equal(
    agentrix.extractIssueTaskFromTaskComment(agentrix.buildTaskComment('triage', { status: 'starting' })),
    undefined
  );
  assert.equal(
    agentrix.extractIssueTaskFromTaskComment(agentrix.buildTaskComment('review', { status: 'dry-run', runId: 'task-review' })),
    undefined
  );
});

test('agentrix extracts PR/MR task id only from its runtime source marker', () => {
  assert.equal(
    agentrix.extractAgentrixTaskIdFromPullRequest({
      body: '<!-- issue-flow:source source_task_id=task-123 source_runtime=agentrix -->\nBody',
    }),
    'task-123'
  );
  assert.equal(
    agentrix.extractAgentrixTaskIdFromPullRequest({
      title: '<!-- issue-flow:source source_task_id=task-123 source_runtime=agentrix -->',
      body: '',
    }),
    ''
  );
  assert.equal(
    agentrix.extractAgentrixTaskIdFromPullRequest({
      body: '<!-- issue-flow:source source_task_id=task-123 source_runtime=other -->',
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
  assert.equal(args[1], '@agentrix/agentrix-run@latest');
  assert.ok(args.includes('--prompt'));
  assert.equal(args[args.indexOf('--response-mode') + 1], 'async');
  assert.equal(args[args.indexOf('--result-file') + 1], '/tmp/result.json');
  assert.equal(args.includes('issue_flow_agentrix_task=task-123'), false);
  assert.ok(args.includes('issue_flow_pr=example/platform#9'));
  assert.ok(args.includes('issue_flow_review_comment=101'));
  assert.ok(args.includes('issue_flow_source_issue=example/platform#42'));
  assert.equal(args.includes('--runner-id'), false);
  assert.equal(args.includes('--issue-number'), false);
  assert.equal(args.includes('--title'), false);
});

test('agentrix run args pass git server repo context to agentrix-run', () => {
  const args = agentrix.buildRunArgs(
    'build',
    {
      provider: 'gitlab',
      number: 42,
      repoFullName: 'team/app',
      projectId: '123',
      title: 'Fix auth',
    },
    {
      gitServerId: 'gitlab-main',
      serverHost: 'git.lianjia.com',
      gitlabProject: '123',
      responseMode: 'async',
    },
    {},
    'prompt',
    '/tmp/result.json'
  );
  const repo = JSON.parse(args[args.indexOf('--repo') + 1]);
  assert.equal(repo.gitServerId, 'gitlab-main');
  assert.equal(repo.serverRepoId, '123');
  assert.equal(repo.owner, 'team');
  assert.equal(repo.name, 'app');
  assert.equal(args[args.indexOf('--client-task-id') + 1], 'if:gl:sgit-lianjia-com:r123:i42:build');
});

test('agentrix client task ids stay semantic and compact', () => {
  assert.equal(
    agentrix.buildClientTaskId(
      'triage',
      {
        provider: 'gitlab',
        projectId: '43326',
        number: 12,
        repoFullName: 'wuling/test',
        htmlUrl: 'https://git.lianjia.com/wuling/test/-/issues/12',
      },
      {}
    ),
    'if:gl:sgit-lianjia-com:r43326:i12:triage'
  );
  assert.equal(
    agentrix.buildClientTaskId(
      'review',
      {
        provider: 'gitlab',
        projectId: '43326',
        number: 15,
        repoFullName: 'wuling/test',
        headSha: '537ab1a19ecab1aca934c8a5fc66660f71b90f6b',
      },
      {
        serverHost: 'git.lianjia.com',
      }
    ),
    'if:gl:sgit-lianjia-com:r43326:pr15:h537ab1a19eca:review'
  );
  assert.equal(
    agentrix.buildClientTaskId(
      'general',
      {
        provider: 'gitlab',
        projectId: '43326',
        number: 12,
        repoFullName: 'wuling/test',
      },
      {
        serverHost: 'git.lianjia.com',
      }
    ),
    ''
  );
  assert.equal(
    agentrix.buildClientTaskId(
      'general',
      {
        provider: 'gitlab',
        projectId: '43326',
        number: 12,
        repoFullName: 'wuling/test',
      },
      {
        serverHost: 'git.lianjia.com',
      },
      {
        comment: { id: 5088825 },
      }
    ),
    'if:gl:sgit-lianjia-com:r43326:i12:c5088825:general'
  );
});

test('agentrix run args keep GitLab subgroup namespace as repo owner', () => {
  const args = agentrix.buildRunArgs(
    'build',
    {
      number: 42,
      repoFullName: 'ai-arch/test/test1',
      title: 'Fix subgroup repo injection',
    },
    {
      gitServerId: 'gitlab-git-lianjia-com',
      responseMode: 'async',
    },
    {},
    'prompt',
    '/tmp/result.json'
  );
  const repo = JSON.parse(args[args.indexOf('--repo') + 1]);
  assert.equal(repo.gitServerId, 'gitlab-git-lianjia-com');
  assert.equal(repo.owner, 'ai-arch/test');
  assert.equal(repo.name, 'test1');
});

test('agentrix run args prefer parsed repo owner and name when available', () => {
  const args = agentrix.buildRunArgs(
    'build',
    {
      number: 42,
      owner: 'ai-arch/test',
      repo: 'test1',
      repoFullName: 'wrong/split/value',
      title: 'Fix parsed repo identity',
    },
    {
      gitServerId: 'gitlab-git-lianjia-com',
      responseMode: 'async',
    },
    {},
    'prompt',
    '/tmp/result.json'
  );
  const repo = JSON.parse(args[args.indexOf('--repo') + 1]);
  assert.equal(repo.owner, 'ai-arch/test');
  assert.equal(repo.name, 'test1');
});

test('agentrix-run child env strips provider tokens without rewriting connector context', () => {
  const source = {
    GITHUB_TOKEN: 'actions-token',
    GH_TOKEN: 'user-token',
    ISSUE_FLOW_GITLAB_TOKEN: 'issue-flow-gitlab-token',
    GITLAB_TOKEN: 'gitlab-token',
    GL_TOKEN: 'gl-token',
    GITLAB_PRIVATE_TOKEN: 'private-token',
    CI_JOB_TOKEN: 'ci-job-token',
    ISSUE_FLOW_GIT_TOKEN: 'git-token',
    GITLAB_BRIDGE_EVENT_NAME: 'pull_request',
    GITLAB_BRIDGE_HEAD_REF: 'feature/auth',
    AGENTRIX_API_KEY: 'agentrix-key',
    AGENTRIX_RUNNER_ID: 'runner-1',
  };
  const env = agentrix.sanitizeAgentrixRunEnv(source);

  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.ISSUE_FLOW_GITLAB_TOKEN, undefined);
  assert.equal(env.GITLAB_TOKEN, undefined);
  assert.equal(env.GL_TOKEN, undefined);
  assert.equal(env.GITLAB_PRIVATE_TOKEN, undefined);
  assert.equal(env.CI_JOB_TOKEN, undefined);
  assert.equal(env.ISSUE_FLOW_GIT_TOKEN, undefined);
  assert.equal(env.AGENTRIX_API_KEY, 'agentrix-key');
  assert.equal(env.AGENTRIX_RUNNER_ID, 'runner-1');
  assert.equal(env.GITLAB_BRIDGE_EVENT_NAME, 'pull_request');
  assert.equal(env.GITLAB_BRIDGE_HEAD_REF, 'feature/auth');
  assert.equal(env.AGENTRIX_EVENT_NAME, undefined);
  assert.equal(env.AGENTRIX_HEAD_REF, undefined);
  assert.equal(source.GITHUB_TOKEN, 'actions-token');
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

test('agentrix issue comment resume instruction stays minimal', () => {
  const prompt = agentrix.buildIssueCommentResumeInstruction(
    {
      number: 42,
      htmlUrl: 'https://github.com/example/platform/issues/42',
    },
    {
      id: '501',
      htmlUrl: 'https://github.com/example/platform/issues/42#issuecomment-501',
      body: 'Use the markdown marker path.',
    },
    {
      issueTask: {
        action: 'triage',
        taskId: 'task-triage',
      },
      instruction: 'Use the markdown marker path.',
    }
  );

  assert.equal(prompt, 'Issue 有新的 comment，请查看并继续处理。');
  assert.doesNotMatch(prompt, /https:\/\/github\.com\/example\/platform\/issues\/42/);
  assert.doesNotMatch(prompt, /Use the markdown marker path/);
  assert.doesNotMatch(prompt, /triage/);
  assert.doesNotMatch(prompt, /task-triage/);
});
