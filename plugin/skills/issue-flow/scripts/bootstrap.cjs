#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEFAULT_RUNTIME = 'agentrix';
const MANIFEST_VERSION = 1;
const ISSUE_FLOW_VERSION = readIssueFlowVersion();
const INSTALL_MANIFEST = '.issue-flow/install-manifest.json';
const MODE_MANAGED = 'managed';
const MODE_CUSTOMIZABLE = 'customizable';

const AGENTRIX_GITHUB_WORKFLOWS = [
  ['workflows/github/issue-flow-labels.yml', '.github/workflows/issue-flow-labels.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-auto.yml', '.github/workflows/issue-flow-auto.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-comment.yml', '.github/workflows/issue-flow-comment.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-review.yml', '.github/workflows/issue-flow-pr-review.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-review-comment.yml', '.github/workflows/issue-flow-pr-review-comment.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-pr-merged.yml', '.github/workflows/issue-flow-pr-merged.yml', { mode: MODE_MANAGED }],
  ['workflows/github/issue-flow-failure-intake.yml', '.github/workflows/issue-flow-failure-intake.yml', { mode: MODE_MANAGED }],
];
const GITHUB_FAILURE_INTAKE_WORKFLOW_NAME = 'Issue Flow Failure Intake';
const GITHUB_FAILURE_INTAKE_SOURCE = 'workflows/github/issue-flow-failure-intake.yml';
const GITHUB_FAILURE_INTAKE_TARGET = '.github/workflows/issue-flow-failure-intake.yml';
const GITHUB_WORKFLOWS_DIR = '.github/workflows';
const AGENTRIX_GITLAB_FILES = [
  ['workflows/gitlab/issue-flow.gitlab-ci.yml', '.gitlab/issue-flow.gitlab-ci.yml', { mode: MODE_MANAGED }],
];
const GITLAB_ROOT_CI = '.gitlab-ci.yml';
const GITLAB_PROJECT_CI = '.gitlab/issue-flow-project.gitlab-ci.yml';
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
        'scripts/bootstrap.cjs',
      ],
    },
  ],
];
const AGENTRIX_PLUGIN_SPECS = [
  AGENTRIX_PLUGIN_MANIFEST,
  ...AGENTRIX_PLUGIN_DIRS,
];
const VALUE_OPTIONS = new Set(['--runtime']);

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

function readInstallManifest(options = {}) {
  const target = manifestPath(options);
  if (!fs.existsSync(target)) {
    return {
      version: MANIFEST_VERSION,
      files: {},
    };
  }

  const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`${INSTALL_MANIFEST} is invalid.`);
  }
  return {
    version: manifest.version || MANIFEST_VERSION,
    issueFlowVersion: manifest.issueFlowVersion || '',
    provider: manifest.provider || '',
    runtime: manifest.runtime || '',
    files: manifest.files,
  };
}

function formatInstallManifest(manifest) {
  const files = {};
  for (const target of Object.keys(manifest.files).sort()) {
    files[target] = manifest.files[target];
  }
  return `${JSON.stringify({
    version: MANIFEST_VERSION,
    issueFlowVersion: manifest.issueFlowVersion || ISSUE_FLOW_VERSION,
    provider: manifest.provider || '',
    runtime: manifest.runtime || DEFAULT_RUNTIME,
    files,
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

function isGithubWorkflowPath(filePath) {
  return /\.(ya?ml)$/i.test(filePath);
}

function unquoteYamlString(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

function parseGithubWorkflowName(content) {
  const match = String(content || '').match(/^name:\s*(.+?)\s*$/m);
  if (!match) {
    return undefined;
  }
  const name = unquoteYamlString(match[1]);
  return name || undefined;
}

function githubWorkflowNameFallback(filePath, fallbackName) {
  return fallbackName || path.basename(filePath);
}

function readGithubWorkflowName(filePath, fallbackName) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseGithubWorkflowName(content) || githubWorkflowNameFallback(filePath, fallbackName);
}

function parseGithubWorkflowRunWorkflowNames(content) {
  const lines = String(content || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)workflows:\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }

    const inlineValue = unquoteYamlString(match[2]);
    if (inlineValue) {
      return [inlineValue];
    }

    const names = [];
    const parentIndent = match[1].length;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const childIndent = line.match(/^\s*/)[0].length;
      if (childIndent <= parentIndent) {
        break;
      }

      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (!itemMatch) {
        continue;
      }
      const name = unquoteYamlString(itemMatch[1]);
      if (name) {
        names.push(name);
      }
    }
    return names;
  }
  return [];
}

function discoverExistingGithubWorkflowNames(options = {}) {
  const workflowsDir = path.resolve(installCwd(options), GITHUB_WORKFLOWS_DIR);
  if (!fs.existsSync(workflowsDir) || !fs.statSync(workflowsDir).isDirectory()) {
    return [];
  }

  return fs.readdirSync(workflowsDir)
    .filter(isGithubWorkflowPath)
    .sort()
    .map((entry) => readGithubWorkflowName(path.join(workflowsDir, entry), joinRepoPath(GITHUB_WORKFLOWS_DIR, entry)));
}

function readConfiguredGithubFailureIntakeWorkflowNames(options = {}) {
  const target = path.resolve(installCwd(options), GITHUB_FAILURE_INTAKE_TARGET);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return [];
  }
  return parseGithubWorkflowRunWorkflowNames(fs.readFileSync(target, 'utf8'));
}

function discoverInstalledGithubWorkflowNames() {
  return AGENTRIX_GITHUB_WORKFLOWS
    .filter(([, target]) => target !== GITHUB_FAILURE_INTAKE_TARGET)
    .map(([source, target]) => readGithubWorkflowName(path.join(agentrixBootstrapAssetsDir(), source), target));
}

function uniqueWorkflowNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    if (!name || name === GITHUB_FAILURE_INTAKE_WORKFLOW_NAME || seen.has(name)) {
      continue;
    }
    seen.add(name);
    result.push(name);
  }
  return result;
}

function yamlSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function renderGithubFailureIntakeWorkflow(workflowNames) {
  const source = path.join(agentrixBootstrapAssetsDir(), GITHUB_FAILURE_INTAKE_SOURCE);
  const content = fs.readFileSync(source, 'utf8');
  const workflows = uniqueWorkflowNames(workflowNames);
  const workflowLines = workflows.map((name) => `      - ${yamlSingleQuoted(name)}`).join('\n');
  const rendered = content.replace(
    /^  workflow_run:\n/m,
    `  workflow_run:\n    workflows:\n${workflowLines}\n`
  );
  if (rendered === content) {
    throw new Error(`${GITHUB_FAILURE_INTAKE_SOURCE} is missing an on.workflow_run trigger.`);
  }
  return rendered;
}

function githubWorkflowInstallSpecs(options = {}) {
  const configuredWorkflowNames = hasInstallManifest(options)
    ? readConfiguredGithubFailureIntakeWorkflowNames(options)
    : discoverExistingGithubWorkflowNames(options);
  const workflowNames = uniqueWorkflowNames([
    ...configuredWorkflowNames,
    ...discoverInstalledGithubWorkflowNames(),
  ]);
  return AGENTRIX_GITHUB_WORKFLOWS.map(([source, target, specOptions = {}]) => {
    if (target !== GITHUB_FAILURE_INTAKE_TARGET) {
      return bootstrapInstallSpec(source, target, specOptions);
    }
    return {
      ...bootstrapInstallSpec(source, target, specOptions),
      content: renderGithubFailureIntakeWorkflow(workflowNames),
    };
  });
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
  return {
    source: file.sourceRelative,
    mode: file.mode,
    sha256: file.newHash,
  };
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
    return operations;
  }

  if (!isInteractive(options)) {
    throw new Error([
      'Install conflicts require an interactive terminal.',
      formatConflictList(conflicts, options),
      'Re-run install in a terminal and choose skip or overwrite, or use --force to overwrite.',
    ].join('\n'));
  }

  let allDecision;
  return operations.map((operation) => {
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
        action: 'written',
        dryAction: 'would_write',
        reason: 'overwrite',
      };
    }

    return {
      ...operation,
      operation: 'skip',
      action: 'skipped',
      reason: 'conflict',
    };
  });
}

function applyFileOperation(operation) {
  if (operation.operation === 'write') {
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
    || (result.action === 'skipped' && ['conflict', 'missing'].includes(result.reason));
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
  for (const operation of operations) {
    if (operation.kind === 'desired') {
      if (operation.operation === 'write' || (operation.operation === 'skip' && operation.reason === 'current')) {
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
  };
}

function runFileInstall(specs, options = {}) {
  const manifest = readInstallManifest(options);
  const desiredFiles = expandInstallSpecs(specs, options);
  const desiredOperations = desiredFiles.map((file) => createFileOperation(file, manifest, options));
  const staleOperations = options.pruneStale ? createStaleOperations(manifest, desiredFiles, options) : [];
  const operations = resolveConflicts([...desiredOperations, ...staleOperations], options);

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
    ], { ...options, provider: 'github', pruneStale: true }),
  ];
}

function gitlabRootCiContent(includeProjectCi = false) {
  const lines = [
    'include:',
    `  - local: ${GITLAB_ISSUE_FLOW_CI}`,
  ];
  if (includeProjectCi) {
    lines.push(`  - local: ${GITLAB_PROJECT_CI}`);
  }
  return `${lines.join('\n')}\n`;
}

function hasIssueFlowGitlabInclude(content) {
  return String(content || '').includes(GITLAB_ISSUE_FLOW_CI);
}

function installGitlabRootCi(options = {}) {
  const cwd = options.cwd || process.cwd();
  const target = path.resolve(cwd, GITLAB_ROOT_CI);
  const projectTarget = path.resolve(cwd, GITLAB_PROJECT_CI);
  if (!fs.existsSync(target)) {
    const source = path.join(agentrixBootstrapAssetsDir(), 'workflows/gitlab/root.gitlab-ci.yml');
    if (!options.dryRun) {
      fs.copyFileSync(source, target);
    }
    return {
      action: options.dryRun ? 'would_write' : 'written',
      source,
      target,
    };
  }

  const current = fs.readFileSync(target, 'utf8');
  if (hasIssueFlowGitlabInclude(current)) {
    return {
      action: 'skipped',
      reason: 'configured',
      source: target,
      target,
    };
  }

  if (fs.existsSync(projectTarget) && !options.force) {
    return {
      action: 'skipped',
      reason: 'project-ci-exists',
      source: target,
      target,
      message: `${GITLAB_PROJECT_CI} already exists; re-run with --force or add ${GITLAB_ISSUE_FLOW_CI} to ${GITLAB_ROOT_CI}.`,
    };
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(projectTarget), { recursive: true });
    fs.writeFileSync(projectTarget, current, 'utf8');
    fs.writeFileSync(target, gitlabRootCiContent(true), 'utf8');
  }

  return {
    action: options.dryRun ? 'would_wrap' : 'wrapped',
    source: target,
    target,
    projectTarget,
    message: `${GITLAB_ROOT_CI} now includes issue-flow and ${GITLAB_PROJECT_CI}.`,
  };
}

function installGitlab(options = {}) {
  resolveRuntime(options);
  removeAgentrixPluginRootForForce(options);
  const fileResults = runFileInstall([
    ...packageInstallSpecs(AGENTRIX_PLUGIN_SPECS),
    ...bootstrapInstallSpecs(AGENTRIX_GITLAB_FILES),
    ...bootstrapInstallSpecs(AGENTRIX_PROJECT_FILES),
    ...packageInstallSpecs(AGENTRIX_PROJECT_DIRS),
  ], { ...options, provider: 'gitlab', pruneStale: true });
  return [
    ...removeLegacyAgentrixProjectRoot(options),
    installGitlabRootCi(options),
    ...fileResults,
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

function main(argv = process.argv.slice(2)) {
  const { target, options } = parseArgs(argv);
  if (options.help || !target) {
    console.log(usage());
    return 0;
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
  installAgentrixPlugin,
  installAgentrixProjectScaffold,
  installGithub,
  installGitlab,
  main,
  parseArgs,
  runBootstrap,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
