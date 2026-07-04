const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'install.sh');

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-install-test-'));
}

function runInstall(args, options = {}) {
  return spawnSync('sh', [installScript, ...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
    },
  });
}

test('install script installs GitHub runtime from checkout source', () => {
  const root = makeTempRoot();
  try {
    const result = runInstall(['github', '--force'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /written \.agentrix\/plugins\/issue-flow\/\.claude-plugin\/plugin\.json/);
    assert.match(result.stdout, /written \.agentrix\/plugins\/issue-flow\/skills\/issue-flow/);
    assert.match(result.stdout, /written \.issue-flow\/config\.json/);
    assert.match(result.stdout, /written \.issue-flow\/issues\/README\.md/);
    assert.match(result.stdout, /written \.issue-flow\/prompts/);
    assert.match(result.stdout, /written \.issue-flow\/templates/);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-labels.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-auto.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/create-issue.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/bootstrap.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/package.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script dry-run does not write target files', () => {
  const root = makeTempRoot();
  try {
    const result = runInstall(['github', '--dry-run'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /would_write \.agentrix\/plugins\/issue-flow\/\.claude-plugin\/plugin\.json/);
    assert.match(result.stdout, /would_write \.agentrix\/plugins\/issue-flow\/skills\/issue-flow/);
    assert.equal(fs.existsSync(path.join(root, '.agentrix')), false);
    assert.equal(fs.existsSync(path.join(root, '.github')), false);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script uses checkout source when invoked without slash from checkout cwd', () => {
  const result = spawnSync('sh', ['install.sh', 'github', '--dry-run'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ISSUE_FLOW_REPO: 'https://invalid.invalid/nil4u/issue-flow.git',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /\(exists\)/);
  assert.match(result.stdout, /\.issue-flow\/install-manifest\.json/);
});

test('install script installs GitLab root include from checkout source', () => {
  const root = makeTempRoot();
  try {
    const result = runInstall(['gitlab', '--force'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /written \.gitlab-ci\.yml/);
    assert.match(result.stdout, /written \.gitlab\/issue-flow\.gitlab-ci\.yml/);
    assert.match(result.stdout, /written \.issue-flow\/prompts/);
    assert.match(result.stdout, /written \.issue-flow\/templates/);
    assert.equal(fs.existsSync(path.join(root, '.gitlab-ci.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script appends GitLab root ci include from checkout source', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const result = runInstall(['gitlab'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /updated \.gitlab-ci\.yml/);
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/
    );
    assert.match(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), /build:\n  script: echo build/);
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script plan-json reports conflicts and writes nothing', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const result = runInstall(['gitlab', '--plan-json'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0].id, '.gitlab-ci.yml');
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), false);
    assert.equal(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), 'build:\n  script: echo build\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script decision-file exits 4 when fingerprint is stale', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');
    const decisionPath = path.join(root, 'decisions.json');
    fs.writeFileSync(decisionPath, JSON.stringify({
      fingerprint: 'stale',
      actions: {
        '.gitlab-ci.yml': 'use_proposed',
      },
    }));

    const result = runInstall(['gitlab', '--decision-file', decisionPath], { cwd: root });
    assert.equal(result.status, 4, result.stderr || result.stdout);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error, 'install_plan_changed');
    assert.equal(body.conflicts[0].id, '.gitlab-ci.yml');
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script decision-file applies defaults for missing decisions', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const planResult = runInstall(['gitlab', '--plan-json'], { cwd: root });
    assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);
    const plan = JSON.parse(planResult.stdout);

    const decisionPath = path.join(root, 'decisions.json');
    fs.writeFileSync(decisionPath, JSON.stringify({ fingerprint: plan.fingerprint, actions: {} }));

    const result = runInstall(['gitlab', '--decision-file', decisionPath], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/
    );
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script decision-file rejects unknown ids and disallowed actions', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const planResult = runInstall(['gitlab', '--plan-json'], { cwd: root });
    assert.equal(planResult.status, 0, planResult.stderr || planResult.stdout);
    const plan = JSON.parse(planResult.stdout);

    const unknownPath = path.join(root, 'unknown.json');
    fs.writeFileSync(unknownPath, JSON.stringify({
      fingerprint: plan.fingerprint,
      actions: { 'nope.txt': 'keep' },
    }));
    const unknown = runInstall(['gitlab', '--decision-file', unknownPath], { cwd: root });
    assert.equal(unknown.status, 1, unknown.stderr || unknown.stdout);
    assert.match(unknown.stderr, /unknown conflict: nope\.txt/);

    const disallowedPath = path.join(root, 'disallowed.json');
    fs.writeFileSync(disallowedPath, JSON.stringify({
      fingerprint: plan.fingerprint,
      actions: { '.gitlab-ci.yml': 'remove' },
    }));
    const disallowed = runInstall(['gitlab', '--decision-file', disallowedPath], { cwd: root });
    assert.equal(disallowed.status, 1, disallowed.stderr || disallowed.stdout);
    assert.match(disallowed.stderr, /not allowed for \.gitlab-ci\.yml/);

    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), false);
    assert.equal(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), 'build:\n  script: echo build\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script auto target dry-runs without explicit provider', () => {
  const root = makeTempRoot();
  try {
    const result = runInstall(['auto', '--dry-run'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /would_write \.github\/workflows\/issue-flow-auto\.yml/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script auto target treats non-GitHub remotes as GitLab', () => {
  const root = makeTempRoot();
  try {
    assert.equal(spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' }).status, 0);
    assert.equal(
      spawnSync('git', ['remote', 'add', 'origin', 'git@git.ke.com:wuling/test.git'], {
        cwd: root,
        encoding: 'utf8',
      }).status,
      0
    );

    const result = runInstall(['auto', '--dry-run'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /would_write \.gitlab-ci\.yml/);
    assert.match(result.stdout, /would_write \.gitlab\/issue-flow\.gitlab-ci\.yml/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
