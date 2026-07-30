/**
 * [INPUT]: plugin/console package metadata 与 label-driven release workflows
 * [OUTPUT]: 对外提供单一发布 PR 与版本 bump 入口的回归测试
 * [POS]: 根 test 套件中的发布流程契约验证
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { bumpVersion, TARGETS } = require('../scripts/bump-release-version.cjs');

const ROOT = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

test('release metadata stays in sync', () => {
  const pluginVersion = readJson('plugin/package.json').version;
  const consoleVersion = readJson('console/api/package.json').version;
  const skill = read('plugin/skills/issue-flow/SKILL.md');

  assert.equal(readJson('plugin/.claude-plugin/plugin.json').version, pluginVersion);
  assert.match(skill, new RegExp(`^version: ${pluginVersion.replaceAll('.', '\\.')}$`, 'm'));
  assert.equal(TARGETS.plugin.package, 'plugin/package.json');
  assert.equal(TARGETS.console.package, 'console/api/package.json');
  assert.match(consoleVersion, /^\d+\.\d+\.\d+$/);
});

test('label bump follows semver rules', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(bumpVersion('1.2.3', 'invalid'), undefined);
});

test('auto version bump only handles develop to main release PR labels', () => {
  const workflow = read('.github/workflows/auto-version-bump.yml');

  assert.match(workflow, /pull_request:\n\s+types: \[labeled, unlabeled\]/);
  assert.match(workflow, /github\.event\.pull_request\.base\.ref == 'main'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.ref == 'develop'/);
  for (const label of [
    'plugin:patch',
    'plugin:minor',
    'plugin:major',
    'console:patch',
    'console:minor',
    'console:major',
  ]) {
    assert.match(workflow, new RegExp(label.replace(':', '\\:')));
  }
  assert.match(workflow, /origin\/main/);
  assert.match(workflow, /--from-version/);
  assert.match(workflow, /scripts\/bump-release-version\.cjs plugin set/);
  assert.doesNotMatch(workflow, /plugin_done|console_done/);
  assert.match(workflow, /scripts\/bump-release-version\.cjs/);
  assert.match(workflow, /git push origin/);
});

test('version label workflow defines every release label', () => {
  const workflow = read('.github/workflows/sync-version-labels.yml');
  for (const label of [
    'plugin:patch',
    'plugin:minor',
    'plugin:major',
    'console:patch',
    'console:minor',
    'console:major',
    'plugin-version-bumped',
    'console-version-bumped',
  ]) {
    assert.match(workflow, new RegExp(label.replace(':', '\\:')));
  }
});

test('main workflow creates version tags and builds only a new console tag', () => {
  const workflow = read('.github/workflows/docker-image.yml');
  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /git tag/);
  assert.match(workflow, /git push origin "\$plugin_tag"/);
  assert.match(workflow, /git push origin "\$console_tag"/);
  assert.match(workflow, /console_tag="console-v\$\{console_version\}"/);
  assert.match(workflow, /console_tag_created/);
  assert.match(workflow, /console_tag_created == 'true'/);
  assert.match(workflow, /needs\.tag\.outputs\.console_tag/);
  assert.match(workflow, /console_tag="console-v\$\{console_version\}"/);
  assert.match(workflow, /printf 'version=%s\\n' "\$\{\{ needs\.tag\.outputs\.console_tag \}\}"/);
  assert.match(workflow, /type=sha/);
  assert.match(workflow, /type=raw,value=latest/);
  assert.match(workflow, /console-image-publish\.yml/);
});
