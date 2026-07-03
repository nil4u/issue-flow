/**
 * [INPUT]: 依赖 package.json、SKILL.md、release-please config/manifest 与 release workflow 文件
 * [OUTPUT]: 对外提供 release-please 版本管理配置的回归测试
 * [POS]: test 套件中的发布配置契约验证，防止版本源、extra-files 标记和 workflow 入口漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function skillVersionLine() {
  const match = read('skills/issue-flow/SKILL.md').match(/^version:\s*([^\s#]+).*$/m);
  assert.ok(match, 'SKILL.md must expose a version in front matter');
  return match[0];
}

test('release manifest matches package and skill versions', () => {
  const pkg = readJson('package.json');
  const manifest = readJson('.release-please-manifest.json');
  const versionLine = skillVersionLine();

  assert.equal(manifest['.'], pkg.version);
  assert.match(versionLine, new RegExp(`^version: ${pkg.version.replaceAll('.', '\\.')}`));
  assert.match(versionLine, /x-release-please-version/);
  assert.equal(readJson('.claude-plugin/plugin.json').version, pkg.version);
});

test('release-please config updates the project package and skill file', () => {
  const config = readJson('release-please-config.json');
  const rootPackage = config.packages['.'];

  assert.equal(rootPackage['release-type'], 'node');
  assert.equal(rootPackage['package-name'], 'issue-flow');
  assert.equal(rootPackage['changelog-path'], 'CHANGELOG.md');
  assert.equal(rootPackage['include-component-in-tag'], false);
  assert.match(config['bootstrap-sha'], /^[0-9a-f]{40}$/);
  assert.deepEqual(rootPackage['extra-files'], [
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
});

test('release workflow runs release-please in manifest mode on main', () => {
  const workflow = read('.github/workflows/release-please.yml');

  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.match(workflow, /uses: googleapis\/release-please-action@v4/);
  assert.match(workflow, /group: release-please-main/);
  assert.match(workflow, /target-branch: main/);
  assert.match(workflow, /config-file: release-please-config\.json/);
  assert.match(workflow, /manifest-file: \.release-please-manifest\.json/);
});
