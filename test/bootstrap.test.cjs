const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AGENTRIX_PLUGIN_SPECS,
  AGENTRIX_PROJECT_DIRS,
  AGENTRIX_PROJECT_FILES,
  LEGACY_AGENTRIX_PROJECT_ROOT,
  installGithub,
  installGitlab,
  parseArgs,
  runBootstrap,
} = require('../skills/issue-flow/scripts/bootstrap.cjs');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-bootstrap-test-'));
}

test('bootstrap parser accepts runtime, force, and dry-run only as behavior options', () => {
  assert.deepEqual(parseArgs(['github', '--runtime', 'agentrix', '--force', '--dry-run']), {
    target: 'github',
    options: {
      _: [],
      runtime: 'agentrix',
      force: true,
      dryRun: true,
    },
  });
});

test('bootstrap parser accepts top-level help', () => {
  assert.deepEqual(parseArgs(['--help']), {
    target: undefined,
    options: {
      _: [],
      help: true,
    },
  });
});

test('bootstrap rejects workflow and plugin directory overrides', () => {
  assert.throws(
    () => parseArgs(['github', '--workflow-dir', '.github/workflows/custom']),
    /Unknown option: --workflow-dir/
  );
  assert.throws(
    () => parseArgs(['github', '--plugin-dir', '.agentrix/plugins/custom']),
    /Unknown option: --plugin-dir/
  );
});

test('github bootstrap writes workflow and Agentrix config convention paths', () => {
  const root = makeTempRoot();
  try {
    const results = installGithub({ cwd: root });
    const written = results.map((result) => path.relative(root, result.target)).sort();
    assert.deepEqual(written, [
      ...AGENTRIX_PLUGIN_SPECS.map(([, target]) => target),
      ...AGENTRIX_PROJECT_FILES.map(([, target]) => target),
      ...AGENTRIX_PROJECT_DIRS.map(([, target]) => target),
      '.github/workflows/issue-flow-auto.yml',
      '.github/workflows/issue-flow-comment.yml',
      '.github/workflows/issue-flow-pr-merged.yml',
    ].sort());
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-auto.yml')), true);
    const autoWorkflow = fs.readFileSync(path.join(root, '.github/workflows/issue-flow-auto.yml'), 'utf8');
    assert.match(autoWorkflow, /- opened/);
    assert.match(autoWorkflow, /- labeled/);
    assert.doesNotMatch(autoWorkflow, /- edited/);
    assert.doesNotMatch(autoWorkflow, /- reopened/);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/config.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/assets/agentrix/runtime/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/package.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/CLAUDE.md')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/bootstrap.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/assets/agentrix/bootstrap/workflows/github/issue-flow-auto.yml')), false);
    assert.doesNotMatch(autoWorkflow, /\.github\/agentrix/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap skips existing files unless force is set', () => {
  const root = makeTempRoot();
  try {
    const workflowPath = path.join(root, '.github/workflows/issue-flow-auto.yml');
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, 'custom');

    const skipped = installGithub({ cwd: root }).find((result) => result.target === workflowPath);
    assert.equal(skipped.action, 'skipped');
    assert.equal(fs.readFileSync(workflowPath, 'utf8'), 'custom');

    const overwritten = installGithub({ cwd: root, force: true }).find((result) => result.target === workflowPath);
    assert.equal(overwritten.action, 'written');
    assert.match(fs.readFileSync(workflowPath, 'utf8'), /Issue Flow Auto/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap force removes stale plugin files when installing from source', () => {
  const root = makeTempRoot();
  try {
    const stalePackage = path.join(root, '.agentrix/plugins/issue-flow/package.json');
    fs.mkdirSync(path.dirname(stalePackage), { recursive: true });
    fs.writeFileSync(stalePackage, '{}');

    installGithub({ cwd: root, force: true });
    assert.equal(fs.existsSync(stalePackage), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap force removes legacy Agentrix project config root', () => {
  const root = makeTempRoot();
  try {
    const legacyConfig = path.join(root, LEGACY_AGENTRIX_PROJECT_ROOT, 'config.json');
    fs.mkdirSync(path.dirname(legacyConfig), { recursive: true });
    fs.writeFileSync(legacyConfig, '{}');

    const results = installGitlab({ cwd: root, force: true });
    const removed = results.find((result) => path.relative(root, result.target) === LEGACY_AGENTRIX_PROJECT_ROOT);
    assert.equal(removed.action, 'removed');
    assert.equal(fs.existsSync(path.join(root, LEGACY_AGENTRIX_PROJECT_ROOT)), false);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/config.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap writes include snippet and Agentrix config convention paths', () => {
  const root = makeTempRoot();
  try {
    const results = installGitlab({ cwd: root });
    const written = results.map((result) => path.relative(root, result.target)).sort();
    assert.deepEqual(written, [
      ...AGENTRIX_PLUGIN_SPECS.map(([, target]) => target),
      ...AGENTRIX_PROJECT_FILES.map(([, target]) => target),
      ...AGENTRIX_PROJECT_DIRS.map(([, target]) => target),
      '.gitlab-ci.yml',
      '.gitlab/issue-flow.gitlab-ci.yml',
    ].sort());
    assert.match(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    const gitlabWorkflow = fs.readFileSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml'), 'utf8');
    assert.match(gitlabWorkflow, /AGENTRIX_TRIGGER_SOURCE == "agentrix_daemon_webhook"/);
    assert.match(gitlabWorkflow, /AGENTRIX_EVENT_NAME == "pull_request"/);
    assert.match(gitlabWorkflow, /\$\{AGENTRIX_EVENT_ACTION:-\}" = "opened"/);
    assert.match(gitlabWorkflow, /intake\.cjs --issue-number "\$AGENTRIX_ISSUE_NUMBER"/);
    assert.match(gitlabWorkflow, /dispatch\.cjs auto/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap wraps existing root ci without discarding it', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'stages:\n  - test\n\nunit:\n  script: echo ok\n');

    const results = installGitlab({ cwd: root });
    const wrapped = results.find((result) => result.target === rootCi);
    assert.equal(wrapped.action, 'wrapped');
    assert.match(fs.readFileSync(rootCi, 'utf8'), /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    assert.match(fs.readFileSync(rootCi, 'utf8'), /local: \.gitlab\/issue-flow-project\.gitlab-ci\.yml/);
    assert.equal(
      fs.readFileSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml'), 'utf8'),
      'stages:\n  - test\n\nunit:\n  script: echo ok\n'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitlab bootstrap leaves already configured root ci alone', () => {
  const root = makeTempRoot();
  try {
    const rootCi = path.join(root, '.gitlab-ci.yml');
    fs.writeFileSync(rootCi, 'include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n');

    const results = installGitlab({ cwd: root });
    const skipped = results.find((result) => result.target === rootCi);
    assert.equal(skipped.action, 'skipped');
    assert.equal(skipped.reason, 'configured');
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap rejects unsupported runtimes', () => {
  assert.throws(
    () => runBootstrap('github', { runtime: 'other' }),
    /Unsupported bootstrap runtime/
  );
});
