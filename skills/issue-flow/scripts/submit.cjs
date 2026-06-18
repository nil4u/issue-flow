#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  existingPullRequestApiHead,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  normalizeOptionalUrl,
  resolveProvider,
} = require('./providers.cjs');
const { labelDefinitionFor } = require('./labels.cjs');

const SUBMIT_KINDS = {
  plan: {
    label: 'mr-by::plan',
    flow: 'flow::approve',
    titlePrefix: 'Plan',
    labelDefinition: labelDefinitionFor('mr-by::plan'),
  },
  build: {
    label: 'mr-by::build',
    flow: 'flow::approve',
    titlePrefix: 'Build',
    labelDefinition: labelDefinitionFor('mr-by::build'),
  },
};
const SOURCE_ISSUE_MARKER_PATTERN = /<!--\s*issue-flow:source-issue=\d+\s*-->/i;

function usage() {
  return [
    'Usage: submit.cjs <kind> --issue-number <number> --title <title> --body-file <path> [options]',
    '',
    'Kinds:',
    '  plan    Publish a plan PR and move the issue to flow::approve',
    '  build   Publish a build PR/MR and move the issue to flow::approve',
    '',
    'Options:',
    '  --issue-number <num>    Source issue number.',
    '  --title <title>         PR title. #<issue-number> is prepended when missing.',
    '  --body-file <path>      PR body markdown file.',
    '  --provider <provider>   Git hosting provider: github or gitlab. Defaults from environment/repo.',
    '  --repo <owner/repo>     Repository/project override. Defaults to provider environment or git remote origin.',
    '  --base <branch>         PR base branch. Defaults to origin HEAD, develop, main, then master.',
    '  --head <branch>         PR head branch. Defaults to the current branch.',
    '  --label <mr-by::...>    PR/MR label override. Defaults by kind.',
    '  --draft                Create the PR as draft.',
    '  --no-push              Do not push the current branch before creating the PR.',
    '  --dry-run              Print intended behavior without changing remote state.',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv[0] === '--help') {
    return {
      kind: undefined,
      options: {
        _: [],
        help: true,
      },
    };
  }

  const kind = argv[0];
  const options = {
    _: [],
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--draft') {
      options.draft = true;
      continue;
    }
    if (arg === '--no-push') {
      options.noPush = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[key] = value;
    index += 1;
  }

  return { kind, options };
}

function runOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
  });
  if (result.error) {
    if (options.optional) {
      return '';
    }
    throw result.error;
  }
  if (result.status !== 0) {
    if (options.optional) {
      return '';
    }
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} exited with status ${result.status ?? 1}`);
  }
  return result.stdout.trim();
}

function runChecked(command, args, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, command, args }, null, 2));
    return '';
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: options.env || process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(' ')} exited with status ${result.status ?? 1}`);
  }
  return result.stdout ? result.stdout.trim() : '';
}

function getGitOriginUrl() {
  return runOutput('git', ['config', '--get', 'remote.origin.url'], { optional: true });
}

function resolveRepoHint(options) {
  return options.repo || process.env.GITHUB_REPOSITORY || process.env.GITLAB_PROJECT_PATH || process.env.CI_PROJECT_PATH || getGitOriginUrl();
}

function resolveSubmitProvider(options) {
  return resolveProvider({ ...options, repo: resolveRepoHint(options) }, {});
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveHeadBranch(options) {
  const branch = options.head || runOutput('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    throw new Error('Unable to resolve current branch. Check out a named branch before publishing.');
  }
  return branch;
}

function gitRefExists(ref) {
  return Boolean(runOutput('git', ['rev-parse', '--verify', '--quiet', ref], { optional: true }));
}

function resolveBaseBranch(options) {
  if (options.base) {
    return options.base;
  }

  const originHead = runOutput('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    optional: true,
  });
  if (originHead.startsWith('origin/')) {
    return originHead.slice('origin/'.length);
  }

  for (const candidate of ['develop', 'main', 'master']) {
    if (gitRefExists(`refs/remotes/origin/${candidate}`) || gitRefExists(candidate)) {
      return candidate;
    }
  }

  return 'main';
}

function assertCleanWorktree(options) {
  const status = runOutput('git', ['status', '--porcelain']);
  if (status) {
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, dirtyWorktree: status.split('\n') }, null, 2));
      return;
    }
    throw new Error('Working tree has uncommitted changes. Commit the plan before publishing the PR.');
  }
}

function assertPublishBranch(headBranch, baseBranch, options) {
  if (headBranch !== baseBranch) {
    return;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, sameHeadAndBase: headBranch }, null, 2));
    return;
  }
  throw new Error(`Head branch and base branch are both ${headBranch}. Create a topic branch before publishing.`);
}

function normalizePrTitle(kindConfig, issueNumber, title) {
  const trimmed = (title || '').trim() || `${kindConfig.titlePrefix} for issue`;
  const issuePattern = new RegExp(`#${issueNumber}(\\b|\\D)`);
  if (issuePattern.test(trimmed)) {
    return trimmed;
  }
  return `${kindConfig.titlePrefix} #${issueNumber}: ${trimmed}`;
}

function validateBodyFile(bodyFile) {
  if (!bodyFile) {
    throw new Error('--body-file is required');
  }
  if (!fs.existsSync(bodyFile)) {
    throw new Error(`PR body file does not exist: ${bodyFile}`);
  }
}

function isGitTrackedFile(filePath) {
  const relativePath = path.relative(process.cwd(), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return false;
  }

  return Boolean(
    runOutput('git', ['ls-files', '--error-unmatch', '--', relativePath], {
      optional: true,
    })
  );
}

function assertBodyFileNotTracked(bodyFile) {
  if (!isGitTrackedFile(bodyFile)) {
    return;
  }

  throw new Error(
    [
      `PR body file must not be committed to the repository: ${bodyFile}`,
      'Write the PR body to a temporary path outside the repo, then pass that path with --body-file.',
    ].join('\n')
  );
}

function buildSourceIssueMarker(issueNumber) {
  return `<!-- issue-flow:source-issue=${issueNumber} -->`;
}

function buildPrBodyWithSourceMarker(body, issueNumber) {
  const marker = buildSourceIssueMarker(issueNumber);
  const content = String(body || '').trimStart();
  if (SOURCE_ISSUE_MARKER_PATTERN.test(content)) {
    return content.replace(SOURCE_ISSUE_MARKER_PATTERN, marker);
  }
  return `${marker}\n${content}`.trimEnd();
}

function writePrBodyWithSourceMarker(bodyFile, issueNumber) {
  const body = fs.readFileSync(bodyFile, 'utf8');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-pr-body-'));
  const markedBodyFile = path.join(tempDir, 'body.md');
  fs.writeFileSync(markedBodyFile, `${buildPrBodyWithSourceMarker(body, issueNumber)}\n`, 'utf8');
  return {
    path: markedBodyFile,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function validateLabel(label) {
  const allowed = new Set(Object.values(SUBMIT_KINDS).map((config) => config.label));
  if (!allowed.has(label)) {
    throw new Error(`--label must be one of: ${[...allowed].join(', ')}`);
  }
}

function labelConfigFor(label) {
  return Object.values(SUBMIT_KINDS).find((config) => config.label === label);
}

async function ensureMergeRequestLabel(provider, repo, label, options) {
  const config = labelConfigFor(label);
  if (!config) {
    validateLabel(label);
  }
  if (!config.labelDefinition) {
    throw new Error(`No managed label definition found for ${label}`);
  }

  if (provider.ensurePullRequestLabel) {
    await provider.ensurePullRequestLabel(repo, label, config.labelDefinition, options);
    return;
  }

  if (!provider.ensureLabelDefinition) {
    if (options.dryRun) {
      console.log(JSON.stringify({ dryRun: true, provider: provider.name, ensureLabel: label, repo: repo.fullName }, null, 2));
    }
    return;
  }

  await provider.ensureLabelDefinition(repo, config.labelDefinition, options);
}

function gitPushTokenForProvider(providerName, env = process.env) {
  if (providerName === 'github') {
    return env.GITHUB_TOKEN || env.GH_TOKEN || '';
  }
  if (providerName === 'gitlab') {
    return env.GITLAB_TOKEN || env.GL_TOKEN || env.GITLAB_PRIVATE_TOKEN || env.CI_JOB_TOKEN || '';
  }
  return '';
}

function gitPushUsernameForProvider(providerName, token, env = process.env) {
  if (providerName === 'github') {
    return 'x-access-token';
  }
  if (providerName === 'gitlab') {
    return env.CI_JOB_TOKEN && token === env.CI_JOB_TOKEN ? 'gitlab-ci-token' : 'oauth2';
  }
  return 'git';
}

function createGitAskpassEnv(providerName, baseEnv = process.env) {
  if (baseEnv.GIT_ASKPASS) {
    return { env: baseEnv, cleanup: () => {} };
  }

  const token = gitPushTokenForProvider(providerName, baseEnv);
  if (!token) {
    return { env: baseEnv, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-git-askpass-'));
  const askpassPath = path.join(tempDir, 'askpass.sh');
  fs.writeFileSync(
    askpassPath,
    [
      '#!/bin/sh',
      'case "$1" in',
      '*Username*) printf "%s\\n" "$ISSUE_FLOW_GIT_USERNAME" ;;',
      '*) printf "%s\\n" "$ISSUE_FLOW_GIT_TOKEN" ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o700 }
  );

  return {
    env: {
      ...baseEnv,
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: '0',
      ISSUE_FLOW_GIT_USERNAME: gitPushUsernameForProvider(providerName, token, baseEnv),
      ISSUE_FLOW_GIT_TOKEN: token,
    },
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}


function pushCurrentBranch(headBranch, options) {
  if (options.noPush) {
    return;
  }

  const askpass = createGitAskpassEnv(options.provider);
  try {
    runChecked('git', ['push', '-u', 'origin', `HEAD:${headBranch}`], {
      dryRun: options.dryRun,
      inherit: true,
      env: askpass.env,
    });
  } finally {
    askpass.cleanup();
  }
}

async function createOrUpdatePullRequest({ provider, repo, title, bodyFile, label, baseBranch, headBranch, draft, options }) {
  const createOrUpdate = provider.createOrUpdatePullRequest || provider.createOrUpdateMergeRequest;
  if (!createOrUpdate) {
    throw new Error(`Provider ${provider.name} does not support PR/MR submission`);
  }
  return createOrUpdate({ repo, title, bodyFile, label, baseBranch, headBranch, draft, options });
}

function applyIssueFlow(provider, repo, issueNumber, flow, options) {
  const args = [
    path.join(__dirname, 'apply.cjs'),
    '--issue-number',
    String(issueNumber),
    '--provider',
    provider.name,
    '--repo',
    repo.fullName,
    '--flow',
    flow,
  ];
  if (options.dryRun) {
    args.push('--dry-run');
  }

  runChecked('node', args, {
    dryRun: false,
    inherit: true,
  });
}

async function main(argv = process.argv.slice(2)) {
  const { kind, options } = parseArgs(argv);
  if (options.help || !kind) {
    console.log(usage());
    return 0;
  }

  const kindConfig = SUBMIT_KINDS[kind];
  if (!kindConfig) {
    throw new Error(`Unknown submit kind: ${kind}. Expected one of: ${Object.keys(SUBMIT_KINDS).join(', ')}`);
  }

  const issueNumber = parsePositiveInteger(options.issueNumber || options.issue, '--issue-number');
  const provider = resolveSubmitProvider(options);
  const repo = provider.resolveRepo({}, { ...options, repo: resolveRepoHint(options) });
  options.provider = provider.name;
  const label = options.label || kindConfig.label;
  validateLabel(label);
  validateBodyFile(options.bodyFile);
  assertBodyFileNotTracked(options.bodyFile);

  const headBranch = resolveHeadBranch(options);
  const baseBranch = resolveBaseBranch(options);
  const title = normalizePrTitle(kindConfig, issueNumber, options.title);

  assertCleanWorktree(options);
  assertPublishBranch(headBranch, baseBranch, options);
  await ensureMergeRequestLabel(provider, repo, label, options);
  pushCurrentBranch(headBranch, options);

  const markedBody = writePrBodyWithSourceMarker(options.bodyFile, issueNumber);
  try {
    const prUrl = await createOrUpdatePullRequest({
      provider,
      repo,
      title,
      bodyFile: markedBody.path,
      label,
      baseBranch,
      headBranch,
      draft: options.draft,
      options,
    });

    applyIssueFlow(provider, repo, issueNumber, kindConfig.flow, options);
    console.log(JSON.stringify({ kind, provider: provider.name, issueNumber, prUrl, issueFlow: kindConfig.flow, label }, null, 2));
  } finally {
    markedBody.cleanup();
  }
}

module.exports = {
  assertBodyFileNotTracked,
  buildPrBodyWithSourceMarker,
  buildSourceIssueMarker,
  createGitAskpassEnv,
  existingPullRequestApiHead,
  gitPushTokenForProvider,
  gitPushUsernameForProvider,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  isGitTrackedFile,
  main,
  normalizeOptionalUrl,
  normalizePrTitle,
  parseArgs,
  resolveBaseBranch,
  SUBMIT_KINDS,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
