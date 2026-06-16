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

test('agentrix review prompt uses PR/MR context instead of issue flow instructions', () => {
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

  assert.match(prompt, /## Pull Request/);
  assert.match(prompt, /Number: #9/);
  assert.match(prompt, /Possible source issue: #42/);
  assert.match(prompt, /不要修改 source issue label/);
  assert.doesNotMatch(prompt, /## Issue/);
  assert.doesNotMatch(prompt, /flow::triage/);
  assert.doesNotMatch(prompt, /automation::build/);
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

test('agentrix task marker uses issue-flow namespace', () => {
  assert.equal(agentrix.buildTaskCommentMarker('build'), '<!-- issue-flow:task:agentrix:build -->');
  assert.equal(
    agentrix.buildTaskCommentMarker('pr-review', { headSha: 'abc123' }),
    '<!-- issue-flow:task:agentrix:pr-review:abc123 -->'
  );
});
