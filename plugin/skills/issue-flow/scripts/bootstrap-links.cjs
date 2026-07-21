const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MODE_MANAGED = 'managed';
const MANAGED_SYMLINKS = [
  ['.agents/skills/issue-flow', '../../.agentrix/plugins/issue-flow/skills/issue-flow'],
  ['.agents/skills/vision-plan', '../../.agentrix/plugins/issue-flow/skills/vision-plan'],
  ['.claude/skills/issue-flow', '../../.agentrix/plugins/issue-flow/skills/issue-flow'],
  ['.claude/skills/vision-plan', '../../.agentrix/plugins/issue-flow/skills/vision-plan'],
  ['.issue-flow/cli.cjs', '../.agentrix/plugins/issue-flow/skills/issue-flow/cli.cjs'],
];

function textSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeRepoPath(value) {
  return String(value).split(path.sep).join('/');
}

function installCwd(options = {}) {
  return path.resolve(options.cwd || process.cwd());
}

function managedSymlinkSpecs() {
  return MANAGED_SYMLINKS.map(([targetRelative, linkTarget]) => ({
    targetRelative,
    linkTarget,
    mode: MODE_MANAGED,
  }));
}

function readSymlinkState(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }

  if (!stats.isSymbolicLink()) {
    return {
      exists: true,
      kind: stats.isDirectory() ? 'directory' : 'file',
    };
  }

  const linkTarget = normalizeRepoPath(fs.readlinkSync(target));
  return {
    exists: true,
    kind: 'symlink',
    linkTarget,
    hash: textSha256(linkTarget),
  };
}

function desiredLinkManifestEntry(operation) {
  const entry = {
    target: operation.newLinkTarget,
    mode: operation.mode,
  };
  if (operation.operation === 'skip' && operation.reason === 'keep') {
    entry.acknowledged = true;
  }
  if (operation.operation === 'skip' && operation.reason === 'customized' && operation.previous?.acknowledged) {
    entry.acknowledged = true;
  }
  return entry;
}

function createSymlinkOperation(spec, manifest, options = {}) {
  const cwd = installCwd(options);
  const target = path.resolve(cwd, spec.targetRelative);
  const state = readSymlinkState(target);
  const previous = manifest.links[spec.targetRelative];
  const newHash = textSha256(spec.linkTarget);
  const source = path.resolve(path.dirname(target), spec.linkTarget);
  const base = {
    kind: 'desired',
    entryType: 'symlink',
    source,
    sourceRelative: spec.linkTarget,
    target,
    targetRelative: spec.targetRelative,
    groupSource: source,
    groupTarget: target,
    groupTargetRelative: spec.targetRelative,
    mode: spec.mode,
    previous,
    currentHash: state.hash,
    newHash,
    currentLinkTarget: state.linkTarget,
    newLinkTarget: spec.linkTarget,
    targetKind: state.kind,
    targetExists: state.exists,
  };

  if (options.force) {
    return {
      ...base,
      operation: 'write',
      action: 'written',
      dryAction: 'would_write',
      reason: 'force',
    };
  }
  if (!state.exists) {
    return {
      ...base,
      operation: 'write',
      action: 'written',
      dryAction: 'would_write',
      reason: 'missing',
    };
  }
  if (state.kind === 'symlink' && state.linkTarget === spec.linkTarget) {
    return {
      ...base,
      operation: 'skip',
      action: 'skipped',
      reason: 'current',
    };
  }
  if (previous && state.kind === 'symlink' && state.linkTarget === previous.target) {
    return {
      ...base,
      operation: 'write',
      action: 'updated',
      dryAction: 'would_update',
      reason: 'tracked',
    };
  }
  if (previous?.acknowledged && previous.target === spec.linkTarget) {
    return {
      ...base,
      operation: 'skip',
      action: 'skipped',
      reason: 'customized',
    };
  }
  return {
    ...base,
    operation: 'conflict',
    action: 'conflict',
    dryAction: 'would_conflict',
    reason: previous ? 'modified' : 'untracked',
  };
}

function createStaleSymlinkOperations(manifest, desiredLinks, options = {}) {
  const cwd = installCwd(options);
  const desiredTargets = new Set(desiredLinks.map((link) => link.targetRelative));
  const operations = [];

  for (const [targetRelative, previous] of Object.entries(manifest.links)) {
    if (desiredTargets.has(targetRelative)) {
      continue;
    }

    const target = path.resolve(cwd, targetRelative);
    const state = readSymlinkState(target);
    const source = path.resolve(path.dirname(target), previous.target);
    const base = {
      kind: 'stale',
      entryType: 'symlink',
      source,
      sourceRelative: previous.target,
      target,
      targetRelative,
      groupSource: source,
      groupTarget: target,
      groupTargetRelative: targetRelative,
      mode: previous.mode || MODE_MANAGED,
      previous,
      currentHash: state.hash,
      currentLinkTarget: state.linkTarget,
      targetKind: state.kind,
      targetExists: state.exists,
    };

    if (!state.exists) {
      operations.push({
        ...base,
        operation: 'forget',
        action: 'skipped',
        reason: 'missing',
      });
      continue;
    }

    if (options.force || (state.kind === 'symlink' && state.linkTarget === previous.target)) {
      operations.push({
        ...base,
        operation: 'remove',
        action: 'removed',
        dryAction: 'would_remove',
        reason: options.force ? 'force' : 'stale',
      });
      continue;
    }

    operations.push({
      ...base,
      operation: 'conflict',
      action: 'conflict',
      dryAction: 'would_conflict',
      reason: 'stale-modified',
    });
  }

  return operations;
}

function removeTarget(target) {
  const state = readSymlinkState(target);
  if (!state.exists) {
    return;
  }
  if (state.kind === 'symlink') {
    fs.unlinkSync(target);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function applySymlinkOperation(operation) {
  if (operation.operation === 'write') {
    removeTarget(operation.target);
    fs.mkdirSync(path.dirname(operation.target), { recursive: true });
    fs.symlinkSync(operation.newLinkTarget, operation.target);
    return;
  }
  if (operation.operation === 'remove') {
    removeTarget(operation.target);
  }
}

module.exports = {
  MANAGED_SYMLINKS,
  applySymlinkOperation,
  createStaleSymlinkOperations,
  createSymlinkOperation,
  desiredLinkManifestEntry,
  managedSymlinkSpecs,
};
