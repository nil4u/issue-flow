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
    assert.equal(fs.existsSync(path.join(root, '.github/workflows/issue-flow-auto.yml')), true);
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
