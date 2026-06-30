#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  existingPullRequestApiHead,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  normalizeLabels,
  normalizeOptionalUrl,
  resolveProvider,
} = require('./providers.cjs');
const { labelDefinitionFor, resolveIssueSizeLabel } = require('./labels.cjs');
const { buildSourceMarker } = require('./provenance.cjs');

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
const AGENTRIX_TASK_MARKER_PATTERN = /<!--\s*issue-flow:agentrix:task=([^>]+?)\s*-->/i;
const SOURCE_PROVENANCE_MARKER_PATTERN = /<!--\s*issue-flow:source\s+[^>]*-->\s*/i;

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
    '  --agentrix-task-id <id> Agentrix task id to embed in the PR/MR body. Defaults to AGENTRIX_TASK_ID.',
    '  --provider <provider>   Git hosting provider: github or gitlab. Defaults from environment/repo.',
    '  --repo <owner/repo>     Repository/project override. Defaults to provider environment or git remote origin.',
    '  --base <branch>         PR base branch. AGENTRIX_BASE_REF takes precedence when present.',
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

function normalizeBranchName(value) {
  const branch = String(value || '').trim();
  if (!branch || branch === 'null' || branch === 'undefined') {
    return '';
  }
  return branch;
}

function resolveAgentrixWorkerBaseBranch(env = process.env) {
  return normalizeBranchName(env.AGENTRIX_BASE_REF || env.GITLAB_BRIDGE_BASE_REF || env.GITLAB_BRIDGE_REF_NAME);
}

function resolveBaseBranch(options) {
  const agentrixWorkerBaseBranch = resolveAgentrixWorkerBaseBranch();
  if (agentrixWorkerBaseBranch) {
    return agentrixWorkerBaseBranch;
  }

  if (options.base) {
    return options.base;
  }

  throw new Error('Unable to resolve PR/MR base branch. Set AGENTRIX_BASE_REF/GITLAB_BRIDGE_BASE_REF in the worker environment or pass --base <branch>.');
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

function expectedBranchSuffixForKind(kind) {
  if (kind === 'plan' || kind === 'build') {
    return `/${kind}`;
  }
  return '';
}

function validateIssueFlowBranch(kind, issueNumber, headBranch, options = {}) {
  if (options.allowNonIssueFlowBranch) {
    return;
  }

  const branch = String(headBranch || '').trim();
  const suffix = expectedBranchSuffixForKind(kind);
  if (!suffix || (branch.startsWith(`${issueNumber}-`) && branch.endsWith(suffix))) {
    return;
  }

  throw new Error(
    [
      `Refusing to submit ${kind} PR/MR from branch ${branch || '<empty>'}.`,
      `Use the issue-flow branch for issue #${issueNumber}: ${issueNumber}-<issue-slug>${suffix}.`,
    ].join(' ')
  );
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

function buildAgentrixTaskMarker(taskId) {
  const normalized = String(taskId || '').trim();
  return normalized ? `<!-- issue-flow:agentrix:task=${normalized} -->` : '';
}

function resolveAgentrixTaskId(options = {}) {
  return String(options.agentrixTaskId || process.env.AGENTRIX_TASK_ID || '').trim();
}

function buildPrBodyWithMarkers(body, issueNumber, taskId = '') {
  const sourceMarker = buildSourceIssueMarker(issueNumber);
  const taskMarker = buildAgentrixTaskMarker(taskId);
  const provenanceMarker = buildSourceMarker({ sourceTaskId: taskId });
  const content = String(body || '').trimStart();
  let marked = SOURCE_ISSUE_MARKER_PATTERN.test(content)
    ? content.replace(SOURCE_ISSUE_MARKER_PATTERN, sourceMarker)
    : `${sourceMarker}\n${content}`;

  if (taskMarker) {
    if (AGENTRIX_TASK_MARKER_PATTERN.test(marked)) {
      marked = marked.replace(AGENTRIX_TASK_MARKER_PATTERN, taskMarker);
    } else if (marked.startsWith(sourceMarker)) {
      marked = `${sourceMarker}\n${taskMarker}${marked.slice(sourceMarker.length)}`;
    } else {
      marked = `${taskMarker}\n${marked}`;
    }
  }

  if (provenanceMarker) {
    if (SOURCE_PROVENANCE_MARKER_PATTERN.test(marked)) {
      marked = marked.replace(SOURCE_PROVENANCE_MARKER_PATTERN, `${provenanceMarker}\n`);
    } else if (taskMarker && marked.includes(taskMarker)) {
      marked = marked.replace(taskMarker, `${taskMarker}\n${provenanceMarker}`);
    } else if (marked.startsWith(sourceMarker)) {
      marked = `${sourceMarker}\n${provenanceMarker}${marked.slice(sourceMarker.length)}`;
    } else {
      marked = `${provenanceMarker}\n${marked}`;
    }
  }

  return marked.trimEnd();
}

function buildPrBodyWithSourceMarker(body, issueNumber) {
  return buildPrBodyWithMarkers(body, issueNumber);
}

function writePrBodyWithMarkers(bodyFile, issueNumber, taskId = '') {
  const body = fs.readFileSync(bodyFile, 'utf8');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-pr-body-'));
  const markedBodyFile = path.join(tempDir, 'body.md');
  fs.writeFileSync(markedBodyFile, `${buildPrBodyWithMarkers(body, issueNumber, taskId)}\n`, 'utf8');
  return {
    path: markedBodyFile,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function writePrBodyWithSourceMarker(bodyFile, issueNumber) {
  return writePrBodyWithMarkers(bodyFile, issueNumber);
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

async function loadSourceIssueForSubmit(provider, repo, issueNumber, options = {}) {
  const target = {
    ...repo,
    provider: provider.name,
    issueNumber,
    number: issueNumber,
  };
  const canRead = !options.dryRun || (provider.hasToken && provider.hasToken(options));
  if (!canRead) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          plannedCheck: 'source_issue_size',
          issueNumber,
          reason: 'Source issue must have exactly one size:: label before submitting a plan/build PR/MR.',
        },
        null,
        2
      )
    );
    return undefined;
  }
  const issue = provider.getIssueForApply
    ? await provider.getIssueForApply(target, options)
    : await provider.fetchCurrentIssue(target, options);
  return {
    ...issue,
    labels: normalizeLabels(issue.labels),
  };
}

function validateSourceIssueSize(issue, issueNumber) {
  if (!issue) {
    return undefined;
  }
  const result = resolveIssueSizeLabel(issue.labels || []);
  if (result.ok) {
    return result;
  }
  const command = `issue-flow issue apply --issue ${issueNumber} --size size::M`;
  if (result.code === 'multiple_size_labels') {
    throw new Error(
      [
        `Source issue #${issueNumber} has more than one size:: label: ${result.labels.join(', ')}.`,
        'Choose one size based on the issue title, body, comments, and repository context, then re-run:',
        command,
        'The apply command replaces the conflicting size labels.',
      ].join(' ')
    );
  }
  if (result.code === 'invalid_size_label') {
    throw new Error(
      [
        `Source issue #${issueNumber} has an invalid size:: label: ${result.labels.join(', ')}.`,
        'Choose size::XS, size::S, size::M, size::L, or size::XL based on the issue title, body, comments, and repository context, then re-run:',
        command,
      ].join(' ')
    );
  }
  throw new Error(
    [
      `Source issue #${issueNumber} needs exactly one size:: label before submitting a plan/build PR/MR.`,
      'Choose size::XS, size::S, size::M, size::L, or size::XL based on the issue title, body, comments, and repository context.',
      'If you are unsure, use size::M and leave a low-confidence note, then re-run:',
      command,
    ].join(' ')
  );
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
  const sourceIssue = await loadSourceIssueForSubmit(provider, repo, issueNumber, options);
  validateSourceIssueSize(sourceIssue, issueNumber);
  validateIssueFlowBranch(kind, issueNumber, headBranch, options);
  await ensureMergeRequestLabel(provider, repo, label, options);
  pushCurrentBranch(headBranch, options);

  const markedBody = writePrBodyWithMarkers(options.bodyFile, issueNumber, resolveAgentrixTaskId(options));
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
  buildAgentrixTaskMarker,
  buildPrBodyWithMarkers,
  buildPrBodyWithSourceMarker,
  buildSourceIssueMarker,
  createGitAskpassEnv,
  existingPullRequestApiHead,
  gitPushTokenForProvider,
  gitPushUsernameForProvider,
  headBranchFilterCandidates,
  isExistingPullRequestError,
  isGitTrackedFile,
  loadSourceIssueForSubmit,
  main,
  normalizeOptionalUrl,
  normalizePrTitle,
  parseArgs,
  resolveAgentrixTaskId,
  resolveAgentrixWorkerBaseBranch,
  resolveBaseBranch,
  SUBMIT_KINDS,
  validateIssueFlowBranch,
  validateSourceIssueSize,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
