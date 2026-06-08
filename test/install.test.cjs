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
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-auto.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
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
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script wraps existing GitLab root ci from checkout source', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const result = runInstall(['gitlab'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /wrapped \.gitlab-ci\.yml/);
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow-project\.gitlab-ci\.yml/
    );
    assert.equal(
      fs.readFileSync(path.join(root, '.gitlab/issue-flow-project.gitlab-ci.yml'), 'utf8'),
      'build:\n  script: echo build\n'
    );
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
