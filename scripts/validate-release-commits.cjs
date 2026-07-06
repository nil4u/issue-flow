#!/usr/bin/env node
/**
 * [INPUT]: 依赖 release-please-config.json、.release-please-manifest.json 与 git tag/history
 * [OUTPUT]: 在 release-please 前诊断非规范提交导致的无发布信号状态
 * [POS]: release workflow 的前置守门脚本,把“无提交被发布”变成可诊断错误
 * [PROTOCOL]: 变更时更新此头部,然后检查 CLAUDE.md
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_TYPES = new Set(['deps', 'feat', 'fix']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function versionTag(version) {
  return version.startsWith('v') ? version : `v${version}`;
}

function packageTag(packagePath, packageConfig, version) {
  const tag = versionTag(version);
  if (packageConfig['include-component-in-tag'] === false) return tag;

  const component = packageConfig.component || packagePath;
  return `${component}-${tag}`;
}

function parseConventionalSubject(subject) {
  const match = subject.match(/^([a-z][a-z0-9-]*)(\([^)()\r\n]+\))?(!)?: .+$/);
  if (!match) return undefined;

  return {
    type: match[1],
    breaking: Boolean(match[3]),
  };
}

function hasBreakingFooter(body) {
  return /^BREAKING[ -]CHANGE: .+/m.test(body);
}

function isReleaseCommit(parsed, body) {
  return parsed.breaking || hasBreakingFooter(body) || RELEASE_TYPES.has(parsed.type);
}

function git(args, cwd) {
  return childProcess.execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tagExists(tag, cwd) {
  try {
    git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function commitsForPackage(packagePath, tag, cwd) {
  const range = tagExists(tag, cwd) ? [`${tag}..HEAD`] : [];
  const output = git(
    ['log', '--format=%H%x1f%s%x1f%B%x1e', '--no-merges', ...range, '--', packagePath],
    cwd,
  );

  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, body = ''] = record.split('\x1f');
      return { sha, subject, body };
    });
}

function shortSha(sha) {
  return sha.slice(0, 12);
}

function validatePackage(packagePath, packageConfig, manifest, cwd) {
  const version = manifest[packagePath];
  if (!version) throw new Error(`Missing manifest version for package: ${packagePath}`);

  const tag = packageTag(packagePath, packageConfig, version);
  const commits = commitsForPackage(packagePath, tag, cwd);
  if (commits.length === 0) return undefined;

  const inspected = commits.map((commit) => {
    const parsed = parseConventionalSubject(commit.subject);
    return {
      ...commit,
      parsed,
      releasable: parsed ? isReleaseCommit(parsed, commit.body) : false,
    };
  });
  const releasable = inspected.filter((commit) => commit.releasable);
  const unparsable = inspected.filter((commit) => !commit.parsed);

  if (unparsable.length === 0 || releasable.length > 0) return undefined;

  return {
    packagePath,
    tag,
    commits: unparsable,
  };
}

function failureText(failures) {
  const lines = [
    'Release Please found path changes but no releasable Conventional Commit.',
    'Use a subject like "fix(plugin): ..." or "feat(console): ..." on a commit that touches the package path.',
    '',
  ];

  for (const failure of failures) {
    lines.push(`${failure.packagePath} since ${failure.tag}:`);
    for (const commit of failure.commits) {
      lines.push(`  - ${shortSha(commit.sha)} ${commit.subject}`);
    }
    lines.push('');
  }

  lines.push('Recovery: amend before merging, or make the next real package-path commit use fix/feat/deps.');
  return lines.join('\n');
}

function validate(cwd) {
  const config = readJson(path.join(cwd, 'release-please-config.json'));
  const manifest = readJson(path.join(cwd, '.release-please-manifest.json'));
  const failures = [];

  for (const [packagePath, packageConfig] of Object.entries(config.packages || {})) {
    const failure = validatePackage(packagePath, packageConfig, manifest, cwd);
    if (failure) failures.push(failure);
  }

  return failures;
}

function main() {
  const cwd = process.cwd();
  const failures = validate(cwd);
  if (failures.length === 0) return;

  const message = failureText(failures);
  console.error(`::error title=Missing release commit::${message.split('\n')[0]}`);
  console.error(message);
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  failureText,
  hasBreakingFooter,
  isReleaseCommit,
  packageTag,
  parseConventionalSubject,
  validate,
  versionTag,
};
