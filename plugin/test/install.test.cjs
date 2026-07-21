const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const installScript = path.join(repoRoot, 'install.sh');
const { MANAGED_SYMLINKS } = require('../skills/issue-flow/scripts/bootstrap.cjs');

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

function assertInstalledSymlinks(root) {
  for (const [target, linkTarget] of MANAGED_SYMLINKS) {
    const absoluteTarget = path.join(root, target);
    assert.equal(fs.lstatSync(absoluteTarget).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(absoluteTarget), linkTarget);
  }
}

test('vision-plan skill links a manual covering every supported Engine section type', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'skills/vision-plan/SKILL.md'), 'utf8');
  const manual = fs.readFileSync(path.join(repoRoot, 'skills/vision-plan/references/engine-json-contract.md'), 'utf8');
  const submitSource = fs.readFileSync(path.join(repoRoot, 'skills/issue-flow/scripts/submit.cjs'), 'utf8');
  const sectionTypesSource = submitSource.match(/const VISUAL_SECTION_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(sectionTypesSource, 'VISUAL_SECTION_TYPES must be readable');
  const sectionTypes = [...sectionTypesSource[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);

  assert.match(skill, /references\/engine-json-contract\.md/);
  assert.doesNotMatch(skill, /schemaVersion|sourceId|destinationId|recommendedOptionId|Component Data Rules|Plan JSON Contract/);
  for (const sectionType of sectionTypes) {
    assert.ok(manual.includes(`\`${sectionType}\``), `manual must document ${sectionType}`);
  }
});

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
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/plan-visual-impl.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/plan-visual-bug.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/.claude-plugin/plugin.json')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/dispatch.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/create-issue.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/sync-labels.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/references/engine-json-contract.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/plan-kit/check.mjs')), true);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/vision-plan/plan-kit/kit.css')), false);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/plan-kit/kit.css')), false);
    assert.match(fs.readFileSync(path.join(root, '.issue-flow/prompts/plan-impl.prompt.md'), 'utf8'), /提交方案(?:的)? PR\/MR/);
    assert.match(fs.readFileSync(path.join(root, '.issue-flow/prompts/plan-visual-impl.prompt.md'), 'utf8'), /Decision 或 Visual Plan/);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/bootstrap-links.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/skills/issue-flow/scripts/bootstrap.cjs')), false);
    assert.equal(fs.existsSync(path.join(root, '.agentrix/plugins/issue-flow/package.json')), false);
    assertInstalledSymlinks(root);
    const cli = spawnSync(process.execPath, ['.issue-flow/cli.cjs', '--help'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.match(cli.stdout, /Usage: issue-flow/);
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
    assert.equal(fs.existsSync(path.join(root, '.agents')), false);
    assert.equal(fs.existsSync(path.join(root, '.claude')), false);
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
    assert.doesNotMatch(fs.readFileSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml'), 'utf8'), /issue-flow-labels:/);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/prompts/build.prompt.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/templates/plan-impl.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/issues/README.md')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
    assertInstalledSymlinks(root);
    assert.match(
      fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'),
      /local: \.gitlab\/issue-flow\.gitlab-ci\.yml/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script treats existing GitLab root ci as a conflict without --force', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const result = runInstall(['gitlab'], { cwd: root });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Install conflicts require an interactive terminal/);
    assert.match(result.stderr, /\.gitlab-ci\.yml/);
    assert.equal(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), 'build:\n  script: echo build\n');
    // 冲突在任何写入之前中止，不留部分安装状态。
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script keeps complex GitLab root ci and still installs the rest', () => {
  const root = makeTempRoot();
  try {
    const complexCi = 'include:\n  rules:\n    - if: $CI_COMMIT_BRANCH\n      local: ci/base.yml\n';
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), complexCi);

    const result = runInstall(['gitlab'], { cwd: root });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'), complexCi);
    assert.equal(fs.existsSync(path.join(root, '.gitlab/issue-flow.gitlab-ci.yml')), true);
    assert.equal(fs.existsSync(path.join(root, '.issue-flow/install-manifest.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install script appends GitLab root ci include from checkout source with --force', () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), 'build:\n  script: echo build\n');

    const result = runInstall(['gitlab', '--force'], { cwd: root });
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
      spawnSync('git', ['remote', 'add', 'origin', 'git@git.internal.example:team/project.git'], {
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
