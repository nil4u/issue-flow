#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  addLocalInclude,
  hasLocalInclude,
} = require('./gitlab-ci-include.cjs');
const {
  MANAGED_SYMLINKS,
  applySymlinkOperation,
  createStaleSymlinkOperations,
  createSymlinkOperation,
  desiredLinkManifestEntry,
  managedSymlinkSpecs,
} = require('./bootstrap-links.cjs');

const DEFAULT_RUNTIME = 'agentrix';
const MANIFEST_VERSION = 2;
const ISSUE_FLOW_VERSION = readIssueFlowVersion();
const INSTALL_MANIFEST = '.issue-flow/install-manifest.json';
const MODE_MANAGED = 'managed';
const MODE_CUSTOMIZABLE = 'customizable';

const AGENTRIX_GITHUB_WORKFLOWS = [
  ['workflows/github/issue-flow-labels.yml', '.github/workflows/issue-flow-labels.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-auto.yml', '.github/workflows/issue-flow-auto.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-comment.yml', '.github/workflows/issue-flow-comment.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-milestones.yml', '.github/workflows/issue-flow-milestones.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-review.yml', '.github/workflows/issue-flow-pr-review.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-review-comment.yml', '.github/workflows/issue-flow-pr-review-comment.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-merged.yml', '.github/workflows/issue-flow-pr-merged.yml', { mode: MODE_MANAGED }],
];
const AGENTRIX_GITLAB_FILES = [
  ['workflows/gitlab/issue-flow.gitlab-ci.yml', '.gitlab/issue-flow.gitlab-ci.yml', { mode: MODE_MANAGED }],
];
const GITLAB_ROOT_CI = '.gitlab-ci.yml';
const GITLAB_ISSUE_FLOW_CI = '.gitlab/issue-flow.gitlab-ci.yml';
const AGENTRIX_CONFIG = ['config.json', '.issue-flow/config.json', { mode: MODE_CUSTOMIZABLE }];
const AGENTRIX_PROJECT_FILES = [
  AGENTRIX_CONFIG,
  ['issue-flow/issues/README.md', '.issue-flow/issues/README.md', { mode: MODE_MANAGED }],
];
const AGENTRIX_PROJECT_DIRS = [
  ['skills/issue-flow/assets/agentrix/runtime/prompts', '.issue-flow/prompts', { mode: MODE_CUSTOMIZABLE }],
  ['skills/issue-flow/assets/agentrix/runtime/templates', '.issue-flow/templates', { mode: MODE_CUSTOMIZABLE }],
];
const AGENTRIX_PLUGIN_ROOT = '.agentrix/plugins/issue-flow';
const LEGACY_AGENTRIX_PROJECT_ROOT = '.agentrix/issue-flow';
const AGENTRIX_PLUGIN_MANIFEST = [
  '.claude-plugin/plugin.json',
  `${AGENTRIX_PLUGIN_ROOT}/.claude-plugin/plugin.json`,
  { mode: MODE_MANAGED },
];
const AGENTRIX_PLUGIN_DIRS = [
  [
    'skills/issue-flow',
    `${AGENTRIX_PLUGIN_ROOT}/skills/issue-flow`,
    {
      mode: MODE_MANAGED,
      exclude: [
        'assets/agentrix/bootstrap',
        'scripts/bootstrap-links.cjs',
        'scripts/bootstrap.cjs',
      ],
    },
  ],
  [
    'skills/vision-plan',
    `${AGENTRIX_PLUGIN_ROOT}/skills/vision-plan`,
    { mode: MODE_MANAGED },
  ],
];
const AGENTRIX_PLUGIN_SPECS = [
  AGENTRIX_PLUGIN_MANIFEST,
  ...AGENTRIX_PLUGIN_DIRS,
];
const VALUE_OPTIONS = new Set(['--runtime', '--decision-file']);

function packageRootDir() {
  return path.resolve(__dirname, '..', '..', '..');
}

function readIssueFlowVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRootDir(), 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function skillRootDir() {
  return path.resolve(__dirname, '..');
}

function agentrixBootstrapAssetsDir() {
  return path.join(skillRootDir(), 'assets', 'agentrix', 'bootstrap');
}

function usage() {
  return [
    'Usage: bootstrap.cjs <github|gitlab> [options]',
    '',
    'Installs issue-flow runtime files and workflows using the selected runtime conventions.',
    '',
    'Options:',
    '  --runtime <name>  Runtime preset. Defaults to agentrix.',
    '  --force           Overwrite existing generated files.',
    '  --dry-run         Print files that would be written.',
    '  --plan-json       Print install conflict plan JSON without writing files.',
    '  --decision-file   Apply conflict decisions from a JSON file.',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv[0] === '--help') {
    return {
      target: undefined,
      options: {
        _: [],
        help: true,
      },
    };
  }

  const target = argv[0];
  const options = {
    _: [],
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--plan-json') {
      options.planJson = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[key] = value;
    index += 1;
  }

  return { target, options };
}

function resolveRuntime(options = {}) {
  const runtime = options.runtime || process.env.ISSUE_FLOW_RUNTIME || DEFAULT_RUNTIME;
  if (runtime !== 'agentrix') {
    throw new Error(`Unsupported bootstrap runtime: ${runtime}`);
  }
  return runtime;
}

function installCwd(options = {}) {
  return path.resolve(options.cwd || process.cwd());
}

function manifestPath(options = {}) {
  return path.join(installCwd(options), INSTALL_MANIFEST);
}

function hasInstallManifest(options = {}) {
  return fs.existsSync(manifestPath(options));
}

function normalizeRepoPath(value) {
  return String(value).split(path.sep).join('/');
}

function joinRepoPath(...parts) {
  return parts
    .filter(Boolean)
    .map((part) => normalizeRepoPath(part).replace(/^\/+|\/+$/g, ''))
    .join('/');
}

function repoRelative(cwd, target) {
  return normalizeRepoPath(path.relative(cwd, target));
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function textSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function conflictCategory(operation) {
  if (operation.category) {
    return operation.category;
  }
  if (operation.targetRelative === GITLAB_ROOT_CI) {
    return 'gitlab_ci';
  }
  if (operation.kind === 'stale') {
    return 'stale';
  }
  if (operation.mode === MODE_CUSTOMIZABLE) {
    return 'user_customizations';
  }
  return 'managed';
}

function defaultConflictAction(operation) {
  if (conflictCategory(operation) === 'gitlab_ci') {
    return operation.reason === 'complex_include' ? 'keep_current' : 'use_proposed';
  }
  if (operation.kind === 'stale') {
    return operation.mode === MODE_MANAGED ? 'remove' : 'forget';
  }
  return operation.mode === MODE_CUSTOMIZABLE ? 'keep' : 'overwrite';
}

function allowedConflictActions(operation) {
  if (conflictCategory(operation) === 'gitlab_ci') {
    return operation.reason === 'complex_include' ? ['keep_current'] : ['use_proposed', 'keep_current'];
  }
  if (operation.kind === 'stale') {
    return ['remove', 'forget'];
  }
  return ['overwrite', 'keep'];
}

function conflictPayload(operation) {
  const conflict = {
    id: operation.targetRelative,
    category: conflictCategory(operation),
    path: operation.targetRelative,
    mode: operation.mode,
    kind: operation.kind,
    reason: operation.reason,
    defaultAction: defaultConflictAction(operation),
    allowedActions: allowedConflictActions(operation),
    currentHash: operation.currentHash || '',
    newHash: operation.newHash || '',
  };
  if (operation.entryType === 'symlink') {
    conflict.entryType = 'symlink';
    conflict.currentTarget = operation.currentLinkTarget || '';
    conflict.proposedTarget = operation.newLinkTarget || operation.previous?.target || '';
    conflict.targetKind = operation.targetKind || '';
  }
  if (conflictCategory(operation) === 'gitlab_ci') {
    if (Object.prototype.hasOwnProperty.call(operation, 'currentContent')) {
      conflict.currentContent = operation.currentContent;
    }
    if (Object.prototype.hasOwnProperty.call(operation, 'proposedContent')) {
      conflict.proposedContent = operation.proposedContent;
    }
    if (operation.message) {
      conflict.message = operation.message;
    }
  }
  return conflict;
}

function conflictFingerprint(conflicts) {
  const shape = conflicts
    .map((conflict) => ({
      id: conflict.id,
      category: conflict.category,
      kind: conflict.kind,
      mode: conflict.mode,
      reason: conflict.reason,
      currentHash: conflict.currentHash || '',
      newHash: conflict.newHash || '',
      entryType: conflict.entryType || 'file',
      currentTarget: conflict.currentTarget || '',
      proposedTarget: conflict.proposedTarget || '',
      targetKind: conflict.targetKind || '',
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return textSha256(canonicalJson(shape));
}

function installPlanFromConflicts(conflicts) {
  const sorted = conflicts.slice().sort((left, right) => left.id.localeCompare(right.id));
  return {
    fingerprint: conflictFingerprint(sorted),
    conflicts: sorted,
  };
}

function collectConflict(operation, options = {}) {
  if (typeof options.conflictCollector === 'function') {
    options.conflictCollector(conflictPayload(operation));
  }
}

function readDecisionFile(filePath) {
  const body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    fingerprint: String(body.fingerprint || ''),
    actions: body.actions && typeof body.actions === 'object' ? body.actions : {},
  };
}

function decisionAction(operation, options = {}) {
  const decisions = options.decisions || {};
  const actions = decisions.actions || {};
  return actions[operation.targetRelative] || defaultConflictAction(operation);
}

function validateDecisionFile(plan, decisions) {
  if (!decisions) {
    return;
  }
  if (decisions.fingerprint !== plan.fingerprint) {
    return;
  }
  const byId = new Map(plan.conflicts.map((conflict) => [conflict.id, conflict]));
  for (const [id, action] of Object.entries(decisions.actions || {})) {
    const conflict = byId.get(id);
    if (!conflict) {
      throw new Error(`Decision file references unknown conflict: ${id}`);
    }
    if (!conflict.allowedActions.includes(action)) {
      throw new Error(`Decision file action ${action} is not allowed for ${id}.`);
    }
  }
}

function readInstallManifest(options = {}) {
  const target = manifestPath(options);
  if (!fs.existsSync(target)) {
    return {
      version: MANIFEST_VERSION,
      files: {},
      links: {},
    };
  }

  const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`${INSTALL_MANIFEST} is invalid.`);
  }
  if (manifest.links !== undefined && (!manifest.links || typeof manifest.links !== 'object' || Array.isArray(manifest.links))) {
    throw new Error(`${INSTALL_MANIFEST} is invalid.`);
  }
  for (const link of Object.values(manifest.links || {})) {
    if (!link || typeof link !== 'object' || typeof link.target !== 'string' || !link.target) {
      throw new Error(`${INSTALL_MANIFEST} is invalid.`);
    }
  }
  return {
    version: manifest.version || MANIFEST_VERSION,
    issueFlowVersion: manifest.issueFlowVersion || '',
    provider: manifest.provider || '',
    runtime: manifest.runtime || '',
    files: manifest.files,
    links: manifest.links || {},
  };
}

function formatInstallManifest(manifest) {
  const files = {};
  for (const target of Object.keys(manifest.files).sort()) {
    files[target] = manifest.files[target];
  }
  const links = {};
  for (const target of Object.keys(manifest.links || {}).sort()) {
    links[target] = manifest.links[target];
  }
  return `${JSON.stringify({
    version: MANIFEST_VERSION,
    issueFlowVersion: manifest.issueFlowVersion || ISSUE_FLOW_VERSION,
    provider: manifest.provider || '',
    runtime: manifest.runtime || DEFAULT_RUNTIME,
    files,
    links,
  }, null, 2)}\n`;
}

function writeInstallManifest(manifest, options = {}) {
  const target = manifestPath(options);
  const content = formatInstallManifest(manifest);
  const exists = fs.existsSync(target);
  const current = exists ? fs.readFileSync(target, 'utf8') : '';
  if (current === content) {
    return {
      action: 'skipped',
      reason: 'current',
      source: target,
      target,
    };
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return {
    action: options.dryRun ? (exists ? 'would_update' : 'would_write') : (exists ? 'updated' : 'written'),
    source: target,
    target,
  };
}

function bootstrapInstallSpec(sourceRelative, targetRelative, specOptions = {}) {
  return {
    source: path.join(agentrixBootstrapAssetsDir(), sourceRelative),
    sourceKey: joinRepoPath('skills/issue-flow/assets/agentrix/bootstrap', sourceRelative),
    targetRelative: normalizeRepoPath(targetRelative),
    mode: specOptions.mode || MODE_MANAGED,
    exclude: specOptions.exclude || [],
  };
}

function packageInstallSpec(sourceRelative, targetRelative, specOptions = {}) {
  return {
    source: path.join(packageRootDir(), sourceRelative),
    sourceKey: normalizeRepoPath(sourceRelative),
    targetRelative: normalizeRepoPath(targetRelative),
    mode: specOptions.mode || MODE_MANAGED,
    exclude: specOptions.exclude || [],
  };
}

function bootstrapInstallSpecs(specs) {
  return specs.map(([source, target, specOptions = {}]) => bootstrapInstallSpec(source, target, specOptions));
}

function packageInstallSpecs(specs) {
  return specs.map(([source, target, specOptions = {}]) => packageInstallSpec(source, target, specOptions));
}

function githubWorkflowInstallSpecs() {
  return bootstrapInstallSpecs(AGENTRIX_GITHUB_WORKFLOWS);
}

function copySpec(sourceRelative, targetRelative, options = {}, specOptions = {}) {
  return runFileInstall([bootstrapInstallSpec(sourceRelative, targetRelative, specOptions)], options)[0];
}

function copyPackageSpec(sourceRelative, targetRelative, specOptions = {}, options = {}) {
  return runFileInstall([packageInstallSpec(sourceRelative, targetRelative, specOptions)], options)[0];
}

function isExcluded(sourceRoot, excludes, candidate) {
  if (!Array.isArray(excludes) || excludes.length === 0) {
    return false;
  }
  const excludeRoots = excludes.map((entry) => path.resolve(sourceRoot, entry));
  return excludeRoots.some((excludeRoot) => candidate === excludeRoot || candidate.startsWith(`${excludeRoot}${path.sep}`));
}

function listSourceFiles(sourceRoot, excludes = []) {
  const stats = fs.statSync(sourceRoot);
  if (stats.isFile()) {
    return [sourceRoot];
  }
  if (!stats.isDirectory()) {
    throw new Error(`Bootstrap source is neither a file nor a directory: ${sourceRoot}`);
  }

  const files = [];
  const visit = (current) => {
    if (isExcluded(sourceRoot, excludes, current)) {
      return;
    }
    const currentStats = fs.statSync(current);
    if (currentStats.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort()) {
        visit(path.join(current, entry));
      }
      return;
    }
    if (currentStats.isFile()) {
      files.push(current);
    }
  };
  visit(sourceRoot);
  return files;
}

function expandInstallSpec(spec, options = {}) {
  if (!fs.existsSync(spec.source)) {
    throw new Error(`Bootstrap source file is missing: ${spec.source}`);
  }

  const cwd = installCwd(options);
  const targetRoot = path.resolve(cwd, spec.targetRelative);
  if (Object.prototype.hasOwnProperty.call(spec, 'content')) {
    return [{
      source: spec.source,
      sourceRelative: spec.sourceKey,
      target: targetRoot,
      targetRelative: spec.targetRelative,
      groupSource: spec.source,
      groupTarget: targetRoot,
      groupTargetRelative: spec.targetRelative,
      mode: spec.mode,
      content: spec.content,
    }];
  }

  const sourceStats = fs.statSync(spec.source);
  const sourceFiles = listSourceFiles(spec.source, spec.exclude);

  return sourceFiles.map((sourceFile) => {
    const nestedRelative = sourceStats.isDirectory() ? normalizeRepoPath(path.relative(spec.source, sourceFile)) : '';
    return {
      source: sourceFile,
      sourceRelative: nestedRelative ? joinRepoPath(spec.sourceKey, nestedRelative) : spec.sourceKey,
      target: nestedRelative ? path.join(targetRoot, nestedRelative) : targetRoot,
      targetRelative: nestedRelative ? joinRepoPath(spec.targetRelative, nestedRelative) : spec.targetRelative,
      groupSource: spec.source,
      groupTarget: targetRoot,
      groupTargetRelative: spec.targetRelative,
      mode: spec.mode,
    };
  });
}

function expandInstallSpecs(specs, options = {}) {
  return specs.flatMap((spec) => expandInstallSpec(spec, options));
}

function currentTargetHash(target) {
  if (!fs.existsSync(target)) {
    return undefined;
  }
  const stats = fs.statSync(target);
  if (!stats.isFile()) {
    return null;
  }
  return fileSha256(target);
}

function desiredManifestEntry(file) {
  const entry = {
    source: file.sourceRelative,
    mode: file.mode,
    sha256: file.newHash,
  };
  if (file.operation === 'skip' && ['keep', 'keep_current'].includes(file.reason)) {
    entry.acknowledged = true;
  }
  if (file.operation === 'skip' && file.reason === 'customized' && file.previous && file.previous.acknowledged) {
    entry.acknowledged = true;
  }
  return entry;
}

function createFileOperation(file, manifest, options = {}) {
  const newHash = Object.prototype.hasOwnProperty.call(file, 'content')
    ? textSha256(file.content)
    : fileSha256(file.source);
  const previous = manifest.files[file.targetRelative];
  const targetExists = fs.existsSync(file.target);
  const currentHash = currentTargetHash(file.target);
  const base = {
    kind: 'desired',
    source: file.source,
    sourceRelative: file.sourceRelative,
    target: file.target,
    targetRelative: file.targetRelative,
    groupSource: file.groupSource,
    groupTarget: file.groupTarget,
    groupTargetRelative: file.groupTargetRelative,
    mode: file.mode,
    newHash,
    previous,
    currentHash,
    targetExists,
  };
  if (Object.prototype.hasOwnProperty.call(file, 'content')) {
    base.content = file.content;
  }

  if (path.resolve(file.source) === path.resolve(file.target)) {
    return {
      ...base,
      operation: 'skip',
      action: 'skipped',
      reason: 'source',
    };
  }

  if (options.force) {
    return {
      ...base,
      operation: 'write',
      action: 'written',
      dryAction: 'would_write',
      reason: 'force',
    };
  }

  if (!targetExists) {
    return {
      ...base,
      operation: 'write',
      action: 'written',
      dryAction: 'would_write',
      reason: 'missing',
    };
  }

  if (currentHash === newHash) {
    return {
      ...base,
      operation: 'skip',
      action: 'skipped',
      reason: 'current',
    };
  }

  if (previous && currentHash === previous.sha256) {
    return {
      ...base,
      operation: 'write',
      action: 'updated',
      dryAction: 'would_update',
      reason: 'tracked',
    };
  }

  if (previous && (file.mode === MODE_CUSTOMIZABLE || previous.acknowledged) && newHash === previous.sha256) {
    return {
      ...base,
      operation: 'skip',
      action: 'skipped',
      reason: 'customized',
    };
  }

  if (!previous && file.mode === MODE_MANAGED) {
    return {
      ...base,
      operation: 'write',
      action: 'updated',
      dryAction: 'would_update',
      reason: 'legacy-managed',
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

function createStaleOperations(manifest, desiredFiles, options = {}) {
  const cwd = installCwd(options);
  const desiredTargets = new Set(desiredFiles.map((file) => file.targetRelative));
  const operations = [];

  for (const [targetRelative, previous] of Object.entries(manifest.files)) {
    if (desiredTargets.has(targetRelative)) {
      continue;
    }
    // The root CI file is manifest-tracked but installed outside the desired
    // specs (gitlabRootCiOperation owns it); the stale sweep must never touch it.
    if (targetRelative === GITLAB_ROOT_CI) {
      continue;
    }

    const target = path.resolve(cwd, targetRelative);
    const targetExists = fs.existsSync(target);
    const currentHash = currentTargetHash(target);
    const base = {
      kind: 'stale',
      source: previous.source || target,
      sourceRelative: previous.source || targetRelative,
      target,
      targetRelative,
      groupSource: previous.source || target,
      groupTarget: target,
      groupTargetRelative: targetRelative,
      mode: previous.mode || MODE_MANAGED,
      previous,
      currentHash,
      targetExists,
    };

    if (!targetExists) {
      operations.push({
        ...base,
        operation: 'forget',
        action: 'skipped',
        reason: 'missing',
      });
      continue;
    }

    if (options.force || currentHash === previous.sha256) {
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

function isInteractive(options = {}) {
  if (options.conflictResolver) {
    return true;
  }
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

function formatConflictList(conflicts, options = {}) {
  const cwd = installCwd(options);
  return conflicts.map((conflict) => `- ${repoRelative(cwd, conflict.target)} (${conflict.reason})`).join('\n');
}

function normalizeConflictDecision(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['s', 'skip'].includes(normalized)) {
    return 'skip';
  }
  if (['o', 'overwrite'].includes(normalized)) {
    return 'overwrite';
  }
  if (['sa', 'skip all', 'skip-all', 'skipall'].includes(normalized)) {
    return 'skip-all';
  }
  if (['oa', 'overwrite all', 'overwrite-all', 'overwriteall'].includes(normalized)) {
    return 'overwrite-all';
  }
  return undefined;
}

function readPromptLine(prompt) {
  fs.writeSync(2, prompt);
  const result = spawnSync('sh', ['-c', 'IFS= read -r line; printf "%s" "$line"'], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== null) {
    return '';
  }
  return result.stdout || '';
}

function promptConflict(conflict, options = {}) {
  const cwd = installCwd(options);
  const relativeTarget = repoRelative(cwd, conflict.target);
  while (true) {
    const answer = readPromptLine(
      `issue-flow install conflict: ${relativeTarget} was modified. Choose skip, overwrite, skip all, or overwrite all [skip]: `
    );
    const decision = normalizeConflictDecision(answer) || (answer.trim() === '' ? 'skip' : undefined);
    if (decision) {
      return decision;
    }
    fs.writeSync(2, 'Please enter skip, overwrite, skip all, or overwrite all.\n');
  }
}

function resolveConflicts(operations, options = {}) {
  const conflicts = operations.filter((operation) => operation.operation === 'conflict');
  if (conflicts.length === 0 || options.dryRun) {
    if (options.planMode) {
      for (const conflict of conflicts) {
        collectConflict(conflict, options);
      }
    }
    return operations;
  }

  // complex_include 只允许 keep_current，没有可做的决策——在此直接落定，
  // 避免非交互安装为它中止，或交互场景弹出无法执行的 overwrite 选项。
  const settled = operations.map((operation) => (
    operation.operation === 'conflict' && operation.reason === 'complex_include'
      ? { ...operation, operation: 'skip', action: 'skipped', reason: 'keep_current' }
      : operation
  ));
  const remaining = settled.filter((operation) => operation.operation === 'conflict');
  if (remaining.length === 0) {
    return settled;
  }

  if (options.decisions) {
    return settled.map((operation) => {
      if (operation.operation !== 'conflict') {
        return operation;
      }

      const action = decisionAction(operation, options);
      if (conflictCategory(operation) === 'gitlab_ci') {
        if (action === 'use_proposed') {
          return {
            ...operation,
            operation: 'write',
            action: 'updated',
            dryAction: 'would_update',
            reason: 'use_proposed',
          };
        }
        return {
          ...operation,
          operation: 'skip',
          action: 'skipped',
          reason: 'keep_current',
        };
      }

      if (operation.kind === 'stale') {
        if (action === 'remove') {
          return {
            ...operation,
            operation: 'remove',
            action: 'removed',
            dryAction: 'would_remove',
            reason: 'remove',
          };
        }
        return {
          ...operation,
          operation: 'forget',
          action: 'skipped',
          reason: 'forget',
        };
      }

      if (action === 'overwrite') {
        return {
          ...operation,
          operation: 'write',
          action: 'written',
          dryAction: 'would_write',
          reason: 'overwrite',
        };
      }

      return {
        ...operation,
        operation: 'skip',
        action: 'skipped',
        reason: 'keep',
      };
    });
  }

  if (!isInteractive(options)) {
    throw new Error([
      'Install conflicts require an interactive terminal.',
      formatConflictList(remaining, options),
      'Re-run install in a terminal and choose skip or overwrite, or use --force to overwrite.',
    ].join('\n'));
  }

  let allDecision;
  return settled.map((operation) => {
    if (operation.operation !== 'conflict') {
      return operation;
    }

    const decision = allDecision || normalizeConflictDecision(
      options.conflictResolver ? options.conflictResolver(operation) : promptConflict(operation, options)
    );
    if (decision === 'skip-all' || decision === 'overwrite-all') {
      allDecision = decision;
    }

    if (decision === 'overwrite' || decision === 'overwrite-all') {
      if (operation.kind === 'stale') {
        return {
          ...operation,
          operation: 'remove',
          action: 'removed',
          dryAction: 'would_remove',
          reason: 'overwrite',
        };
      }
      return {
        ...operation,
        operation: 'write',
        action: conflictCategory(operation) === 'gitlab_ci' ? 'updated' : 'written',
        dryAction: 'would_write',
        reason: 'overwrite',
      };
    }

    return {
      ...operation,
      operation: 'skip',
      action: 'skipped',
      reason: conflictCategory(operation) === 'gitlab_ci' ? 'keep_current' : 'keep',
    };
  });
}

function applyFileOperation(operation) {
  if (operation.operation === 'write') {
    if (operation.entryType === 'symlink') {
      applySymlinkOperation(operation);
      return;
    }
    if (fs.existsSync(operation.target) && !fs.statSync(operation.target).isFile()) {
      fs.rmSync(operation.target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(operation.target), { recursive: true });
    if (Object.prototype.hasOwnProperty.call(operation, 'content')) {
      fs.writeFileSync(operation.target, operation.content, 'utf8');
    } else {
      fs.copyFileSync(operation.source, operation.target);
    }
    return;
  }

  if (operation.operation === 'remove') {
    if (operation.entryType === 'symlink') {
      applySymlinkOperation(operation);
      return;
    }
    fs.rmSync(operation.target, { recursive: true, force: true });
  }
}

function applyFileOperations(operations, options = {}) {
  if (options.dryRun) {
    return;
  }
  for (const operation of operations) {
    applyFileOperation(operation);
  }
}

function operationResult(operation, options = {}) {
  const action = options.dryRun ? (operation.dryAction || operation.action) : operation.action;
  return {
    action,
    reason: action === 'skipped' ? operation.reason : undefined,
    source: operation.source,
    target: operation.target,
  };
}

function shouldReportIndividually(operation, options = {}) {
  const result = operationResult(operation, options);
  return ['would_conflict', 'removed', 'would_remove'].includes(result.action)
    || (result.action === 'skipped' && ['conflict', 'keep', 'forget', 'missing'].includes(result.reason));
}

function summarizeGroupOperations(operations, options = {}) {
  const results = [];
  const grouped = new Map();
  const groupsWithIndividualResults = new Set();

  for (const operation of operations) {
    if (shouldReportIndividually(operation, options)) {
      results.push(operationResult(operation, options));
      groupsWithIndividualResults.add(operation.groupTargetRelative);
      continue;
    }

    const key = operation.groupTargetRelative;
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(operation);
  }

  for (const groupOperations of grouped.values()) {
    const first = groupOperations[0];
    const groupResults = groupOperations.map((operation) => operationResult(operation, options));
    const nonSkipped = groupResults.filter((result) => result.action !== 'skipped');
    if (nonSkipped.length === 0) {
      if (groupsWithIndividualResults.has(first.groupTargetRelative)) {
        continue;
      }
      results.push({
        action: 'skipped',
        reason: groupResults[0].reason,
        source: first.groupSource,
        target: first.groupTarget,
      });
      continue;
    }

    const action = nonSkipped.some((result) => ['written', 'would_write'].includes(result.action))
      ? (options.dryRun ? 'would_write' : 'written')
      : nonSkipped[0].action;
    results.push({
      action,
      source: first.groupSource,
      target: first.groupTarget,
    });
  }

  return results;
}

function nextManifestFromOperations(manifest, operations, options = {}) {
  const files = { ...manifest.files };
  const links = { ...manifest.links };
  for (const operation of operations) {
    if (operation.entryType === 'symlink') {
      if (operation.kind === 'desired') {
        if (
          operation.operation === 'write'
          || (operation.operation === 'skip' && ['current', 'keep', 'customized'].includes(operation.reason))
        ) {
          links[operation.targetRelative] = desiredLinkManifestEntry(operation);
        } else if (!operation.previous) {
          delete links[operation.targetRelative];
        }
      } else if (operation.kind === 'stale' && ['remove', 'forget'].includes(operation.operation)) {
        delete links[operation.targetRelative];
      }
      continue;
    }

    if (operation.kind === 'desired') {
      if (
        operation.operation === 'write'
        || (operation.operation === 'skip' && ['current', 'configured', 'keep', 'keep_current', 'customized'].includes(operation.reason))
      ) {
        files[operation.targetRelative] = desiredManifestEntry(operation);
      } else if (!operation.previous) {
        delete files[operation.targetRelative];
      }
      continue;
    }

    if (operation.kind === 'stale') {
      if (operation.operation === 'remove' || operation.operation === 'forget') {
        delete files[operation.targetRelative];
      }
    }
  }

  return {
    version: MANIFEST_VERSION,
    issueFlowVersion: ISSUE_FLOW_VERSION,
    provider: options.provider || manifest.provider || '',
    runtime: resolveRuntime(options),
    files,
    links,
  };
}

function runFileInstall(specs, options = {}, extraOperations = []) {
  const manifest = readInstallManifest(options);
  const desiredFiles = expandInstallSpecs(specs, options);
  const desiredOperations = desiredFiles.map((file) => createFileOperation(file, manifest, options));
  const staleOperations = options.pruneStale ? createStaleOperations(manifest, desiredFiles, options) : [];
  const desiredLinks = options.installManagedSymlinks ? managedSymlinkSpecs() : [];
  const desiredLinkOperations = desiredLinks.map((link) => createSymlinkOperation(link, manifest, options));
  const staleLinkOperations = options.pruneStale
    ? createStaleSymlinkOperations(manifest, desiredLinks, options)
    : [];
  const operations = resolveConflicts([
    ...desiredOperations,
    ...staleOperations,
    ...extraOperations,
    ...desiredLinkOperations,
    ...staleLinkOperations,
  ], options);

  applyFileOperations(operations, options);
  const nextManifest = nextManifestFromOperations(manifest, operations, options);
  return [
    ...summarizeGroupOperations(operations, options),
    writeInstallManifest(nextManifest, options),
  ];
}

function installSpecs(specs, options = {}) {
  return runFileInstall(bootstrapInstallSpecs(specs), options);
}

function installPackageSpecs(specs, options = {}) {
  return runFileInstall(packageInstallSpecs(specs), options);
}

function removeAgentrixPluginRootForForce(options = {}) {
  const targetRoot = path.resolve(installCwd(options), AGENTRIX_PLUGIN_ROOT);
  if (options.force && !options.dryRun && path.resolve(packageRootDir()) !== targetRoot && fs.existsSync(targetRoot)) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
}

function installAgentrixPlugin(options = {}) {
  resolveRuntime(options);
  removeAgentrixPluginRootForForce(options);
  return runFileInstall(packageInstallSpecs(AGENTRIX_PLUGIN_SPECS), options);
}

function removeLegacyAgentrixProjectRoot(options = {}) {
  const cwd = options.cwd || process.cwd();
  const target = path.resolve(cwd, LEGACY_AGENTRIX_PROJECT_ROOT);
  if (!options.force || !fs.existsSync(target)) {
    return [];
  }

  if (!options.dryRun) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  return [{
    action: options.dryRun ? 'would_remove' : 'removed',
    source: target,
    target,
  }];
}

function installAgentrixProjectScaffold(options = {}) {
  return runFileInstall([
    ...bootstrapInstallSpecs(AGENTRIX_PROJECT_FILES),
    ...packageInstallSpecs(AGENTRIX_PROJECT_DIRS),
  ], options);
}

function installGithub(options = {}) {
  resolveRuntime(options);
  removeAgentrixPluginRootForForce(options);
  return [
    ...removeLegacyAgentrixProjectRoot(options),
    ...runFileInstall([
      ...packageInstallSpecs(AGENTRIX_PLUGIN_SPECS),
      ...githubWorkflowInstallSpecs(options),
      ...bootstrapInstallSpecs(AGENTRIX_PROJECT_FILES),
      ...packageInstallSpecs(AGENTRIX_PROJECT_DIRS),
    ], { ...options, provider: 'github', pruneStale: true, installManagedSymlinks: true }),
  ];
}

function hasIssueFlowGitlabInclude(content) {
  return hasLocalInclude(content, GITLAB_ISSUE_FLOW_CI);
}

// 只读地推导根 CI 的安装 operation（不写文件、不写 manifest），由
// installGitlab 并入 runFileInstall 的统一「解冲突 → 写入 → manifest」流水线，
// 保证任何冲突都在写入任何文件之前被发现。
function gitlabRootCiOperation(options = {}) {
  const cwd = options.cwd || process.cwd();
  const target = path.resolve(cwd, GITLAB_ROOT_CI);
  const manifest = readInstallManifest(options);
  const previous = manifest.files[GITLAB_ROOT_CI];
  const source = path.join(agentrixBootstrapAssetsDir(), 'workflows/gitlab/root.gitlab-ci.yml');
  const base = {
    kind: 'desired',
    source: target,
    sourceRelative: GITLAB_ROOT_CI,
    target,
    targetRelative: GITLAB_ROOT_CI,
    groupSource: target,
    groupTarget: target,
    groupTargetRelative: GITLAB_ROOT_CI,
    mode: MODE_MANAGED,
    previous,
    targetExists: true,
  };

  if (!fs.existsSync(target)) {
    return {
      operation: {
        ...base,
        source,
        sourceRelative: joinRepoPath('skills/issue-flow/assets/agentrix/bootstrap', 'workflows/gitlab/root.gitlab-ci.yml'),
        groupSource: source,
        currentHash: undefined,
        newHash: fileSha256(source),
        targetExists: false,
        operation: 'write',
        action: 'written',
        dryAction: 'would_write',
        reason: 'missing',
      },
    };
  }

  const current = fs.readFileSync(target, 'utf8');
  const currentHash = textSha256(current);
  if (hasIssueFlowGitlabInclude(current)) {
    return {
      operation: {
        ...base,
        currentHash,
        newHash: currentHash,
        operation: 'skip',
        action: 'skipped',
        reason: 'configured',
      },
    };
  }

  if (previous && currentHash === previous.sha256) {
    return {
      operation: {
        ...base,
        currentHash,
        newHash: previous.sha256,
        operation: 'skip',
        action: 'skipped',
        reason: 'keep_current',
      },
    };
  }

  const transformed = addLocalInclude(current, GITLAB_ISSUE_FLOW_CI);
  const manualMessage = `Add "- local: ${GITLAB_ISSUE_FLOW_CI}" to the top-level include list in ${GITLAB_ROOT_CI} manually.`;
  const newHash = transformed.needsReview ? currentHash : textSha256(transformed.content);
  if (previous && newHash === previous.sha256) {
    return {
      operation: {
        ...base,
        currentHash,
        newHash,
        operation: 'skip',
        action: 'skipped',
        reason: 'keep_current',
      },
    };
  }
  if (options.force && transformed.needsReview) {
    throw new Error(`${GITLAB_ROOT_CI} has a complex include block; ${manualMessage}`);
  }

  const forceWrite = options.force && !transformed.needsReview;
  const operation = {
    ...base,
    category: 'gitlab_ci',
    currentHash,
    newHash,
    operation: forceWrite ? 'write' : 'conflict',
    action: forceWrite ? 'updated' : 'conflict',
    dryAction: forceWrite ? 'would_update' : 'would_conflict',
    reason: forceWrite ? 'force' : transformed.needsReview ? 'complex_include' : 'missing_issue_flow_include',
    currentContent: current,
    proposedContent: transformed.needsReview ? undefined : transformed.content,
    message: transformed.needsReview ? manualMessage : undefined,
  };
  if (!transformed.needsReview) {
    operation.content = transformed.content;
  }
  return {
    operation,
    needsReview: Boolean(transformed.needsReview),
    message: transformed.needsReview ? manualMessage : `${GITLAB_ROOT_CI} now includes ${GITLAB_ISSUE_FLOW_CI}.`,
  };
}

function installGitlab(options = {}) {
  resolveRuntime(options);
  const rootCi = gitlabRootCiOperation(options);
  removeAgentrixPluginRootForForce(options);
  const fileResults = runFileInstall([
    ...packageInstallSpecs(AGENTRIX_PLUGIN_SPECS),
    ...bootstrapInstallSpecs(AGENTRIX_GITLAB_FILES),
    ...bootstrapInstallSpecs(AGENTRIX_PROJECT_FILES),
    ...packageInstallSpecs(AGENTRIX_PROJECT_DIRS),
  ], {
    ...options,
    provider: 'gitlab',
    pruneStale: true,
    installManagedSymlinks: true,
  }, [rootCi.operation]);
  const results = fileResults.map((result) => {
    if (result.target !== rootCi.operation.target || !rootCi.message) {
      return result;
    }
    if (!rootCi.needsReview && result.action === 'skipped') {
      return result;
    }
    return { ...result, message: rootCi.message };
  });
  return [
    ...removeLegacyAgentrixProjectRoot(options),
    ...results,
  ];
}

function printResults(results) {
  for (const result of results) {
    const relativeTarget = path.relative(process.cwd(), result.target) || '.';
    const suffix = result.message ? ` - ${result.message}` : '';
    if (result.action === 'skipped') {
      console.log(`skip ${relativeTarget} (${result.reason})${suffix}`);
    } else {
      console.log(`${result.action} ${relativeTarget}${suffix}`);
    }
  }
}

function runBootstrap(target, options = {}) {
  if (target === 'github') {
    return installGithub(options);
  }
  if (target === 'gitlab') {
    return installGitlab(options);
  }
  throw new Error('bootstrap target must be github or gitlab');
}

function createInstallPlan(target, options = {}) {
  const conflicts = [];
  runBootstrap(target, {
    ...options,
    dryRun: true,
    planMode: true,
    conflictCollector: (conflict) => conflicts.push(conflict),
  });
  return installPlanFromConflicts(conflicts);
}

function main(argv = process.argv.slice(2)) {
  const { target, options } = parseArgs(argv);
  if (options.help || !target) {
    console.log(usage());
    return 0;
  }

  if (options.planJson) {
    const plan = createInstallPlan(target, options);
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return 0;
  }

  if (options.decisionFile) {
    const decisions = readDecisionFile(options.decisionFile);
    const plan = createInstallPlan(target, options);
    if (decisions.fingerprint !== plan.fingerprint) {
      process.stdout.write(`${JSON.stringify({
        error: 'install_plan_changed',
        fingerprint: plan.fingerprint,
        conflicts: plan.conflicts,
      })}\n`);
      return 4;
    }
    validateDecisionFile(plan, decisions);
    options.decisions = decisions;
  }

  const results = runBootstrap(target, options);
  printResults(results);
  return 0;
}

module.exports = {
  AGENTRIX_CONFIG,
  AGENTRIX_GITHUB_WORKFLOWS,
  AGENTRIX_GITLAB_FILES,
  AGENTRIX_PROJECT_DIRS,
  AGENTRIX_PROJECT_FILES,
  AGENTRIX_PLUGIN_DIRS,
  AGENTRIX_PLUGIN_MANIFEST,
  AGENTRIX_PLUGIN_ROOT,
  AGENTRIX_PLUGIN_SPECS,
  LEGACY_AGENTRIX_PROJECT_ROOT,
  MANAGED_SYMLINKS,
  installAgentrixPlugin,
  installAgentrixProjectScaffold,
  installGithub,
  installGitlab,
  main,
  parseArgs,
  createInstallPlan,
  runBootstrap,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
