/**
 * [INPUT]: 依赖 plugin/console 两个 package.json、SKILL.md、release-please config/manifest 与 release workflow 文件
 * [OUTPUT]: 对外提供 release-please 双包版本管理配置的回归测试
 * [POS]: 根 test 套件中的发布配置契约验证，防止版本源、extra-files 标记和 workflow 入口漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const releaseCommitValidator = require('../scripts/validate-release-commits.cjs');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function skillVersionLine() {
  const match = read('plugin/skills/issue-flow/SKILL.md').match(/^version:\s*([^\s#]+).*$/m);
  assert.ok(match, 'SKILL.md must expose a version in front matter');
  return match[0];
}

test('release manifest matches plugin and console package versions', () => {
  const pluginPkg = readJson('plugin/package.json');
  const consolePkg = readJson('console/api/package.json');
  const manifest = readJson('.release-please-manifest.json');
  const versionLine = skillVersionLine();

  assert.equal(manifest['plugin'], pluginPkg.version);
  assert.equal(manifest['console/api'], consolePkg.version);
  assert.match(versionLine, new RegExp(`^version: ${pluginPkg.version.replaceAll('.', '\\.')}`));
  assert.match(versionLine, /x-release-please-version/);
  assert.equal(readJson('plugin/.claude-plugin/plugin.json').version, pluginPkg.version);
});

test('release-please config releases plugin and console independently', () => {
  const config = readJson('release-please-config.json');
  const pluginPackage = config.packages['plugin'];
  const consolePackage = config.packages['console/api'];

  assert.equal(pluginPackage['release-type'], 'node');
  assert.equal(pluginPackage['package-name'], 'issue-flow');
  assert.equal(pluginPackage['changelog-path'], 'CHANGELOG.md');
  assert.equal(pluginPackage['include-component-in-tag'], false);
  assert.deepEqual(pluginPackage['extra-files'], [
    {
      type: 'generic',
      path: 'skills/issue-flow/SKILL.md',
    },
    {
      type: 'json',
      path: '.claude-plugin/plugin.json',
      jsonpath: '$.version',
    },
  ]);

  assert.equal(consolePackage['release-type'], 'node');
  assert.equal(consolePackage['package-name'], 'issue-flow-console');
  assert.equal(consolePackage['component'], 'console');
  assert.notEqual(consolePackage['include-component-in-tag'], false);
});

test('workspace packages agree with release manifest layout', () => {
  const rootPkg = readJson('package.json');

  assert.equal(rootPkg.private, true);
  assert.deepEqual(rootPkg.workspaces, ['plugin', 'console/api', 'console/web']);
  assert.equal(readJson('plugin/package.json').name, 'issue-flow');
  assert.equal(readJson('console/api/package.json').name, 'issue-flow-console');
  assert.equal(readJson('console/api/package.json').private, true);
});

test('release workflow runs release-please in manifest mode on main', () => {
  const workflow = read('.github/workflows/release-please.yml');

  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node scripts\/validate-release-commits\.cjs/);
  assert.match(workflow, /uses: googleapis\/release-please-action@v4/);
  assert.match(workflow, /group: release-please-main/);
  assert.match(workflow, /target-branch: main/);
  assert.match(workflow, /config-file: release-please-config\.json/);
  assert.match(workflow, /manifest-file: \.release-please-manifest\.json/);
});

test('release commit validator follows release-please tag and commit conventions', () => {
  assert.equal(releaseCommitValidator.versionTag('1.2.3'), 'v1.2.3');
  assert.equal(releaseCommitValidator.versionTag('v1.2.3'), 'v1.2.3');
  assert.equal(
    releaseCommitValidator.packageTag('plugin', { 'include-component-in-tag': false }, '0.3.1'),
    'v0.3.1',
  );
  assert.equal(
    releaseCommitValidator.packageTag('console/api', { component: 'console' }, '0.2.0'),
    'console-v0.2.0',
  );

  assert.deepEqual(releaseCommitValidator.parseConventionalSubject('fix(plugin): repair release guard'), {
    type: 'fix',
    breaking: false,
  });
  assert.deepEqual(releaseCommitValidator.parseConventionalSubject('feat!: drop legacy flow'), {
    type: 'feat',
    breaking: true,
  });
  assert.equal(releaseCommitValidator.parseConventionalSubject('Add GitLab token automation'), undefined);
  assert.equal(
    releaseCommitValidator.hasBreakingFooter('feat: update\n\nBREAKING CHANGE: reset config'),
    true,
  );
  assert.equal(
    releaseCommitValidator.isReleaseCommit({ type: 'deps', breaking: false }, 'deps: update runtime'),
    true,
  );
});

test('console image workflows build arm64 without qemu emulation', () => {
  const releaseWorkflow = read('.github/workflows/release-please.yml');
  const imageWorkflow = read('.github/workflows/docker-image.yml');
  const publishWorkflow = read('.github/workflows/console-image-publish.yml');
  const workflows = `${releaseWorkflow}\n${imageWorkflow}\n${publishWorkflow}`;

  assert.doesNotMatch(workflows, /platforms:\s*linux\/amd64,linux\/arm64/);
  assert.match(workflows, /runner:\s+ubuntu-24\.04-arm/);
  assert.match(workflows, /push-by-digest=true/);
  assert.match(workflows, /docker buildx imagetools create/);
});

test('console image workflows share one publish implementation', () => {
  const releaseWorkflow = read('.github/workflows/release-please.yml');
  const imageWorkflow = read('.github/workflows/docker-image.yml');
  const publishWorkflow = read('.github/workflows/console-image-publish.yml');

  assert.match(releaseWorkflow, /uses: \.\/\.github\/workflows\/console-image-publish\.yml/);
  assert.match(imageWorkflow, /uses: \.\/\.github\/workflows\/console-image-publish\.yml/);
  assert.match(publishWorkflow, /workflow_call:/);
  assert.doesNotMatch(`${releaseWorkflow}\n${imageWorkflow}`, /docker\/build-push-action@v6/);
  assert.doesNotMatch(`${releaseWorkflow}\n${imageWorkflow}`, /docker buildx imagetools create/);
});
