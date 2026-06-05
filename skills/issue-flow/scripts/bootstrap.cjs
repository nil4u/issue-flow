#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RUNTIME = 'agentrix';

const AGENTRIX_GITHUB_WORKFLOWS = [
  ['workflows/github/issue-flow-auto.yml', '.github/workflows/issue-flow-auto.yml'],
  ['workflows/github/issue-flow-comment.yml', '.github/workflows/issue-flow-comment.yml'],
  ['workflows/github/issue-flow-pr-merged.yml', '.github/workflows/issue-flow-pr-merged.yml'],
];
const AGENTRIX_GITLAB_FILES = [
  ['workflows/gitlab/issue-flow.gitlab-ci.yml', '.gitlab/issue-flow.gitlab-ci.yml'],
];
const AGENTRIX_CONFIG = ['config.json', '.github/agentrix/issue-flow/config.json'];
const AGENTRIX_PLUGIN_ROOT = '.agentrix/plugins/issue-flow';
const AGENTRIX_PLUGIN_DIRS = [
  [
    'skills/issue-flow',
    `${AGENTRIX_PLUGIN_ROOT}/skills/issue-flow`,
    {
      exclude: [
        'assets/agentrix/bootstrap',
        'scripts/bootstrap.cjs',
      ],
    },
  ],
];
const VALUE_OPTIONS = new Set(['--runtime']);

function packageRootDir() {
  return path.resolve(__dirname, '..', '..', '..');
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

function copySpec(sourceRelative, targetRelative, options = {}) {
  const source = path.join(agentrixBootstrapAssetsDir(), sourceRelative);
  const target = path.resolve(options.cwd || process.cwd(), targetRelative);
  return copyPath(source, target, options);
}

function copyPackageSpec(sourceRelative, targetRelative, specOptions = {}, options = {}) {
  const source = path.join(packageRootDir(), sourceRelative);
  const target = path.resolve(options.cwd || process.cwd(), targetRelative);
  return copyPath(source, target, options, specOptions);
}

function copyPath(source, target, options = {}, specOptions = {}) {
  if (!fs.existsSync(source)) {
    throw new Error(`Bootstrap source file is missing: ${source}`);
  }
  if (path.resolve(source) === path.resolve(target)) {
    return {
      action: 'skipped',
      reason: 'source',
      source,
      target,
    };
  }
  if (fs.existsSync(target) && !options.force) {
    return {
      action: 'skipped',
      reason: 'exists',
      source,
      target,
    };
  }

  if (!options.dryRun) {
    const sourceStats = fs.statSync(source);
    if (fs.existsSync(target) && options.force && sourceStats.isDirectory()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (sourceStats.isDirectory()) {
      fs.cpSync(source, target, {
        recursive: true,
        force: true,
        filter: buildCopyFilter(source, specOptions.exclude),
      });
    } else {
      fs.copyFileSync(source, target);
    }
  }
  return {
    action: options.dryRun ? 'would_write' : 'written',
    source,
    target,
  };
}

function buildCopyFilter(sourceRoot, excludes = []) {
  if (!Array.isArray(excludes) || excludes.length === 0) {
    return undefined;
  }
  const excludeRoots = excludes.map((entry) => path.resolve(sourceRoot, entry));
  return (source) => !excludeRoots.some((excludeRoot) => source === excludeRoot || source.startsWith(`${excludeRoot}${path.sep}`));
}

function installSpecs(specs, options = {}) {
  return specs.map(([source, target]) => copySpec(source, target, options));
}

function installPackageSpecs(specs, options = {}) {
  return specs.map(([source, target, specOptions]) => copyPackageSpec(source, target, specOptions, options));
}

function installAgentrixPlugin(options = {}) {
  resolveRuntime(options);
  const targetRoot = path.resolve(options.cwd || process.cwd(), AGENTRIX_PLUGIN_ROOT);
  if (options.force && !options.dryRun && path.resolve(packageRootDir()) !== targetRoot && fs.existsSync(targetRoot)) {
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
  return installPackageSpecs(AGENTRIX_PLUGIN_DIRS, options);
}

function installGithub(options = {}) {
  resolveRuntime(options);
  return [
    ...installAgentrixPlugin(options),
    ...installSpecs([...AGENTRIX_GITHUB_WORKFLOWS, AGENTRIX_CONFIG], options),
  ];
}

function installGitlab(options = {}) {
  resolveRuntime(options);
  return [
    ...installAgentrixPlugin(options),
    ...installSpecs([...AGENTRIX_GITLAB_FILES, AGENTRIX_CONFIG], options),
  ];
}

function printResults(results) {
  for (const result of results) {
    const relativeTarget = path.relative(process.cwd(), result.target) || result.target;
    if (result.action === 'skipped') {
      console.log(`skip ${relativeTarget} (${result.reason})`);
    } else {
      console.log(`${result.action} ${relativeTarget}`);
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
  AGENTRIX_PLUGIN_DIRS,
  AGENTRIX_PLUGIN_ROOT,
  installAgentrixPlugin,
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
