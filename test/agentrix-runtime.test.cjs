const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

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
  assert.match(prompt, /do not put it in git/);
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
  assert.match(prompt, /do not put it in git/);
  assert.match(prompt, /Read this project-level skill file before acting: `skills\/issue-flow\/SKILL\.md`/);
  assert.doesNotMatch(prompt, /## Plan Output/);
  assert.doesNotMatch(prompt, /Agentrix Issue-Flow Paths/);
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
    body: '<!-- issue-flow:source-issue=42 -->\nAdds export support.',
  });

  assert.match(prompt, /## Review Target/);
  assert.match(prompt, /URL: https:\/\/github\.com\/example\/platform\/pull\/9/);
  assert.match(prompt, /## Review Submission/);
  assert.match(prompt, /scripts\/review\.cjs --pr-number 9 --body-file <tmp-review-body-file>/);
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

  assert.match(prompt, /创建标准化 issue/);
  assert.match(prompt, /automation::off/);
});

test('agentrix task marker uses issue-flow namespace', () => {
  assert.equal(agentrix.buildTaskCommentMarker('build'), '<!-- issue-flow:agentrix:task:build -->');
  assert.equal(
    agentrix.buildTaskCommentMarker('review', { headSha: 'abc123' }),
    '<!-- issue-flow:agentrix:task:review:abc123 -->'
  );
  assert.doesNotMatch(agentrix.buildTaskComment('build', { status: 'starting' }), /issue-flow:task:agentrix/);
});
