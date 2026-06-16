#!/usr/bin/env node

const fs = require('node:fs');
const { loadEventPayload } = require('./events.cjs');
const { providers, resolveProvider } = require('./providers.cjs');

const VALUE_OPTIONS = new Set([
  '--event',
  '--provider',
  '--repo',
  '--pr-number',
  '--body-file',
  '--commit-id',
  '--gitlab-url',
  '--gitlab-api-url',
  '--gitlab-project',
  '--gitlab-token',
]);

function usage() {
  return [
    'Usage: review.cjs --pr-number <num> --body-file <path> [options]',
    '',
    'Submits a PR/MR review result. GitHub uses the Pull Request Review API; GitLab posts an MR note.',
    '',
    'Options:',
    '  --event <path>          Event JSON path. Defaults to GITHUB_EVENT_PATH or GITLAB_EVENT_PATH.',
    '  --provider <provider>   Git hosting provider: github or gitlab. Defaults from event/environment.',
    '  --repo <owner/repo>     Repository/project override.',
    '  --pr-number <num>       PR/MR number.',
    '  --body-file <path>      Markdown review body.',
    '  --commit-id <sha>       Commit SHA for GitHub review submission. Defaults to PR head SHA.',
    '  --dry-run',
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

  return options;
}

function loadPayload(options = {}) {
  const loaded = loadEventPayload(options);
  return loaded.source === 'empty' ? {} : loaded.payload;
}

function readBodyFile(bodyFile) {
  if (!bodyFile) {
    throw new Error('--body-file is required');
  }
  return fs.readFileSync(bodyFile, 'utf8').trim();
}

async function buildReviewPullRequest(options = {}) {
  const payload = loadPayload(options);
  const provider = resolveProvider(options, payload);
  const pr = provider.buildPullRequestContext(payload, options);
  if (options.dryRun) {
    return { provider, pr };
  }
  return {
    provider,
    pr: await provider.fetchCurrentPullRequest(pr, options),
  };
}

async function submitReview(options = {}) {
  const body = readBodyFile(options.bodyFile);
  const { provider, pr } = await buildReviewPullRequest(options);
  const review = await provider.submitPullRequestReview(pr, body, options);
  return {
    action: 'submitted',
    provider: provider.name,
    pullRequest: pr.number,
    reviewUrl: review && (review.html_url || review.htmlUrl || review.web_url || ''),
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const result = await submitReview(options);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

module.exports = {
  buildReviewPullRequest,
  main,
  parseArgs,
  submitReview,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
