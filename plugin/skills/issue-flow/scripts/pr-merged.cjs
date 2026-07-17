#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProvider } = require('./providers.cjs');
const { loadEventPayload } = require('./events.cjs');

const MERGED_PR_TRANSITIONS = {
  plan: {
    label: 'mr-by::plan',
    flow: 'flow::build',
    plan: 'plan::approved',
  },
  build: {
    label: 'mr-by::build',
    status: 'status::done',
    clearFlow: true,
  },
};
const SOURCE_ISSUE_MARKER_PATTERN = /<!--\s*issue-flow:source-issue=(\d+)\s*-->/i;
const AGENTRIX_TASK_MARKER_PATTERN = /<!--\s*issue-flow:agentrix:task=([^>]+?)\s*-->/i;
const PLAN_ARTIFACT_MARKER_PATTERN = /<!--\s*issue-flow:plan-artifact\s+artifact=(decision|plan)\s+format=(json|markdown)\b[^>]*-->/i;

function usage() {
  return [
    'Usage: pr-merged.cjs --event <path> [options]',
    '',
    'Applies the source issue transition for merged plan/build PRs.',
    '',
    'Options:',
    '  --event <path>       Merge event JSON path. Defaults to GITHUB_EVENT_PATH or GITLAB_EVENT_PATH.',
    '  --provider <name>    Git hosting provider: github or gitlab. Defaults from event/environment.',
    '  --repo <owner/repo>  Repository/project override. Defaults from provider environment or event repository.',
    '  --dry-run           Print intended behavior without changing remote state.',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help') {
      options.help = true;
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

    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[key] = value;
    index += 1;
  }

  return options;
}

function loadEvent(options) {
  const loaded = loadEventPayload(options);
  if (loaded.source === 'empty') {
    throw new Error('Missing event payload. Pass --event, set GITHUB_EVENT_PATH/GITLAB_EVENT_PATH, or run from an Agentrix GitLab bridge pipeline.');
  }
  return loaded.payload;
}

function resolveRepo(payload, options) {
  const provider = resolveProvider(options, payload);
  const repo =
    options.repo ||
    process.env.GITHUB_REPOSITORY ||
    process.env.GITLAB_PROJECT_PATH ||
    process.env.CI_PROJECT_PATH ||
    (payload.repository && payload.repository.full_name) ||
    (payload.project && payload.project.path_with_namespace);
  return provider.resolveRepo(payload, { ...options, repo });
}

function normalizeLabelName(label) {
  if (typeof label === 'string') {
    return label;
  }
  if (label && typeof label.name === 'string') {
    return label.name;
  }
  if (label && typeof label.title === 'string') {
    return label.title;
  }
  return '';
}

function pullRequestLabels(pullRequest) {
  return Array.isArray(pullRequest.labels) ? pullRequest.labels.map(normalizeLabelName).filter(Boolean) : [];
}

function parsePlanArtifact(body = '') {
  const match = String(body || '').match(PLAN_ARTIFACT_MARKER_PATTERN);
  return match ? { artifact: match[1].toLowerCase(), format: match[2].toLowerCase() } : undefined;
}

function parseAgentrixTaskId(body = '') {
  const match = String(body || '').match(AGENTRIX_TASK_MARKER_PATTERN);
  return match ? match[1].trim() : '';
}

function resolveMergedPrTransition(labels, pullRequest = {}) {
  const matches = Object.entries(MERGED_PR_TRANSITIONS).filter(([, transition]) => labels.includes(transition.label));
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`Pull request has multiple issue-flow source labels: ${matches.map(([, transition]) => transition.label).join(', ')}`);
  }
  const [kind, transition] = matches[0];
  const planArtifact = kind === 'plan' ? parsePlanArtifact(pullRequest.body) : undefined;
  if (planArtifact && planArtifact.artifact === 'decision') {
    return {
      kind: 'decision',
      label: transition.label,
      flow: 'flow::plan',
      artifact: planArtifact.artifact,
      format: planArtifact.format,
    };
  }
  return {
    kind,
    ...transition,
    ...(planArtifact ? {
      artifact: planArtifact.artifact,
      format: planArtifact.format,
    } : {}),
  };
}

function firstIssueReference(value, patterns) {
  if (typeof value !== 'string') {
    return undefined;
  }

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function parseSourceIssueNumber(pullRequest) {
  const markerIssue = firstIssueReference(pullRequest.body, [SOURCE_ISSUE_MARKER_PATTERN]);
  if (markerIssue) {
    return markerIssue;
  }

  const bodyIssue = firstIssueReference(pullRequest.body, [
    /^\s*source issue\s*:\s*(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)?#?(\d+)\b/im,
    /^\s*source issue\s*:\s*(?:https:\/\/gitlab\.com\/.+?\/-\/issues\/)?#?(\d+)\b/im,
    /^\s*source\s*:\s*(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/)?#?(\d+)\b/im,
    /^\s*source\s*:\s*(?:https:\/\/gitlab\.com\/.+?\/-\/issues\/)?#?(\d+)\b/im,
  ]);
  if (bodyIssue) {
    return bodyIssue;
  }

  const titleIssue = firstIssueReference(pullRequest.title, [
    /^\s*(?:plan|build)\s+#(\d+)\b/i,
    /\b(?:plan|build)\s+(?:for\s+)?#(\d+)\b/i,
  ]);
  if (titleIssue) {
    return titleIssue;
  }

  const branch = pullRequest.head && typeof pullRequest.head.ref === 'string' ? pullRequest.head.ref : '';
  const branchIssue = firstIssueReference(branch, [
    /^(\d+)-[^/]+\/(?:plan|build)$/i,
    /^issue\/(\d+)\/(?:plan|build)$/i,
    /(?:^|\/)(\d+)-[^/]+\/(?:plan|build)$/i,
  ]);
  if (branchIssue) {
    return branchIssue;
  }

  return undefined;
}

function normalizeMergeRequestPayload(payload, options = {}) {
  const provider = resolveProvider(options, payload);
  if (provider.name === 'github') {
    const pullRequest = payload.pull_request || {};
    return {
      ...pullRequest,
      number: pullRequest.number,
      url: pullRequest.html_url || '',
    };
  }

  const attrs = payload.object_attributes || {};
  return {
    merged: attrs.action === 'merge' || attrs.state === 'merged',
    labels: payload.labels || attrs.labels || [],
    body: typeof attrs.description === 'string' ? attrs.description : '',
    title: typeof attrs.title === 'string' ? attrs.title : '',
    number: attrs.iid,
    url: attrs.url || '',
    head: {
      ref: typeof attrs.source_branch === 'string' ? attrs.source_branch : '',
    },
  };
}

function runChecked(command, args, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, command, args }, null, 2));
    return '';
  }

  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${command} ${args.join(' ')} exited with status ${result.status ?? 1}`);
  }
  return result.stdout ? result.stdout.trim() : '';
}

function applyIssueTransition(provider, repo, issueNumber, transition, options) {
  const args = [
    path.join(__dirname, 'apply.cjs'),
    '--issue-number',
    String(issueNumber),
    '--provider',
    provider.name,
    '--repo',
    repo.fullName,
  ];
  if (transition.flow) {
    args.push('--flow', transition.flow);
  }
  if (options.dryRun && (transition.flow === 'flow::plan' || transition.flow === 'flow::build')) {
    args.push('--size', 'size::M');
  }
  if (transition.status) {
    args.push('--status', transition.status);
  }
  if (transition.plan) {
    args.push('--plan', transition.plan);
  }
  if (transition.clearFlow) {
    args.push('--clear-flow');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }

  runChecked('node', args, {
    inherit: true,
  });
}

function buildSourceIssueContext(provider, repo, issueNumber, transition) {
  const status = transition.status || (transition.flow ? 'status::active' : undefined);
  return {
    provider: provider.name,
    owner: repo.owner,
    repo: repo.repo,
    repoFullName: repo.fullName,
    projectId: repo.projectId,
    number: issueNumber,
    state: 'open',
    labels: [status, transition.flow, transition.plan].filter(Boolean),
  };
}

async function runPrMerged(options) {
  const payload = loadEvent(options);
  const provider = resolveProvider(options, payload);
  const pullRequest = normalizeMergeRequestPayload(payload, options);

  if (!pullRequest.merged) {
    console.log('Merge request was closed without merge; ignored.');
    return {
      action: 'ignored',
      reason: 'not_merged',
    };
  }

  const labels = pullRequestLabels(pullRequest);
  const transition = resolveMergedPrTransition(labels, pullRequest);
  if (!transition) {
    console.log('Merge request does not have an issue-flow source label; ignored.');
    return {
      action: 'ignored',
      reason: 'missing_source_label',
    };
  }

  const issueNumber = parseSourceIssueNumber(pullRequest);
  if (!issueNumber) {
    throw new Error('Unable to resolve source issue number from PR body, title, or head branch.');
  }

  const repo = resolveRepo(payload, options);
  applyIssueTransition(provider, repo, issueNumber, transition, options);
  const sourceIssue = buildSourceIssueContext(provider, repo, issueNumber, transition);

  const result = {
    action: 'applied',
    provider: provider.name,
    kind: transition.kind,
    issueNumber,
    sourceIssue,
    flow: transition.flow,
    status: transition.status,
    clearFlow: Boolean(transition.clearFlow),
    label: transition.label,
    artifact: transition.artifact,
    format: transition.format,
    taskId: parseAgentrixTaskId(pullRequest.body),
    pullRequestNumber: pullRequest.number,
    pullRequestUrl: pullRequest.url || '',
    pullRequestBody: pullRequest.body || '',
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  await runPrMerged(options);
  return 0;
}

module.exports = {
  applyIssueTransition,
  buildSourceIssueContext,
  main,
  normalizeMergeRequestPayload,
  parseArgs,
  parseAgentrixTaskId,
  parsePlanArtifact,
  parseSourceIssueNumber,
  pullRequestLabels,
  resolveMergedPrTransition,
  runPrMerged,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
