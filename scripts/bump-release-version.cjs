#!/usr/bin/env node
/**
 * [INPUT]: package target 与 major/minor/patch bump 类型
 * [OUTPUT]: 更新对应 package 与发布元数据版本
 * [POS]: label 驱动发布 workflow 的唯一版本修改入口
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = {
  plugin: {
    package: 'plugin/package.json',
    metadata: ['plugin/.claude-plugin/plugin.json'],
    skill: 'plugin/skills/issue-flow/SKILL.md',
  },
  console: {
    package: 'console/api/package.json',
    metadata: [],
  },
};

function bumpVersion(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || !['major', 'minor', 'patch'].includes(type)) return undefined;

  let [major, minor, patch] = match.slice(1).map(Number);
  if (type === 'major') [major, minor, patch] = [major + 1, 0, 0];
  if (type === 'minor') [major, minor, patch] = [major, minor + 1, 0];
  if (type === 'patch') patch += 1;
  return `${major}.${minor}.${patch}`;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  fs.writeFileSync(path.join(ROOT, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function updateSkill(relativePath, version) {
  const filePath = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  const updated = source.replace(/^(version:\s*)[^\s#]+(.*)$/m, `$1${version}$2`);
  if (updated === source) throw new Error(`Missing version front matter in ${relativePath}`);
  fs.writeFileSync(filePath, updated);
}

function writeVersion(target, version) {
  const definition = TARGETS[target];
  if (!definition) throw new Error(`Unknown target: ${target}`);

  const packageJson = readJson(definition.package);
  packageJson.version = version;
  writeJson(definition.package, packageJson);
  for (const metadata of definition.metadata) {
    const value = readJson(metadata);
    value.version = version;
    writeJson(metadata, value);
  }
  if (definition.skill) updateSkill(definition.skill, version);
  return version;
}

function bump(target, type, baseVersion) {
  const definition = TARGETS[target];
  if (!definition) throw new Error(`Unknown target: ${target}`);
  const currentVersion = baseVersion || readJson(definition.package).version;
  const version = bumpVersion(currentVersion, type);
  if (!version) throw new Error(`Invalid version or bump type: ${currentVersion}/${type}`);
  return writeVersion(target, version);
}

function setVersion(target, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${version}`);
  return writeVersion(target, version);
}

function main() {
  const [, , target, operation, option, value] = process.argv;
  if (!target || !operation) {
    throw new Error('Usage: bump-release-version.cjs <plugin|console> <set|major|minor|patch> [--from-version <version>]');
  }
  if (operation === 'set') console.log(`${target}=${setVersion(target, option)}`);
  else if (option === '--from-version') console.log(`${target}=${bump(target, operation, value)}`);
  else console.log(`${target}=${bump(target, operation)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { bumpVersion, bump, setVersion, TARGETS };
