#!/usr/bin/env node

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolveProvider } = require('./providers.cjs');
const { labelGroupsForScope } = require('./labels.cjs');

const MANAGED_LABELS = labelGroupsForScope('issue');

function usage() {
  return [
    'Usage: apply.cjs --issue-number <number> [options]',
    '',
    'Label options:',
    '  --type <type::...>',
    '  --status <status::...>',
    '  --flow <flow::...>',
    '  --clear-flow         Remove any existing flow:: label without adding a new one.',
    '  --automation <automation::...>',
    '  --clear-automation   Remove any existing automation:: label without adding a new one.',
    '  --priority <priority::...>',
    '',
    'Issue body options:',
    '  --normalized-body <markdown>',
    '  --normalized-body-file <path>',
    '',
    'Provider options:',
    '  --provider <provider>   Git hosting provider: github or gitlab. Defaults from environment/repo.',
    '  --repo <owner/repo>     Repository/project override. Defaults to provider environment or git remote origin.',
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
    if (arg === '--clear-flow') {
      options.clearFlow = true;
      continue;
    }
    if (arg === '--clear-automation') {
      options.clearAutomation = true;
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

function getGitOriginUrl() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
  });
  if (result.error) {
    return '';
  }
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

function resolveRepoHint(options) {
  return options.repo || process.env.GITHUB_REPOSITORY || process.env.GITLAB_PROJECT_PATH || process.env.CI_PROJECT_PATH || getGitOriginUrl();
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeLabelName(label) {
  if (typeof label === 'string') {
    return label;
  }
  if (label && typeof label.name === 'string') {
    return label.name;
  }
  return '';
}

function collectDesiredLabels(options) {
  const desired = {};
  for (const [key, config] of Object.entries(MANAGED_LABELS)) {
    const label = options[key];
    if (!label) {
      continue;
    }
    if (!config.values.includes(label)) {
      throw new Error(`${key} must be one of: ${config.values.join(', ')}`);
    }
    desired[key] = label;
  }
  return desired;
}

function collectClearKeys(options) {
  const clearKeys = [];
  if (options.clearFlow) {
    clearKeys.push('flow');
  }
  if (options.clearAutomation) {
    clearKeys.push('automation');
  }
  return clearKeys;
}

function computeLabelChanges(currentLabels, desiredByKey, clearKeys = []) {
  const desiredLabels = Object.values(desiredByKey);
  const managedKeys = [...new Set([...Object.keys(desiredByKey), ...clearKeys])];
  const managedPrefixes = managedKeys.map((key) => MANAGED_LABELS[key].prefix);
  const labelsToRemove = currentLabels.filter((label) => managedPrefixes.some((prefix) => label.startsWith(prefix)));
  const labelsToAdd = desiredLabels.filter((label) => !currentLabels.includes(label));

  return {
    labelsToAdd: [...new Set(labelsToAdd)],
    labelsToRemove: [...new Set(labelsToRemove.filter((label) => !desiredLabels.includes(label)))],
  };
}

function hasBodySection(options) {
  return Boolean(options.normalizedBody || options.normalizedBodyFile);
}

function readNormalizedBody(options) {
  if (options.normalizedBodyFile) {
    return fs.readFileSync(options.normalizedBodyFile, 'utf8').trim();
  }
  if (options.normalizedBody) {
    return options.normalizedBody.trim();
  }
  return '';
}

function shouldSkipIssueBodyUpdate(desiredByKey) {
  return desiredByKey.flow === 'flow::clarify';
}

async function applyLabels(target, currentLabels, desiredByKey, clearKeys, options) {
  const { labelsToAdd, labelsToRemove } = computeLabelChanges(currentLabels, desiredByKey, clearKeys);

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, labelsToAdd, labelsToRemove }, null, 2));
    return;
  }

  const provider = resolveProvider(options, {});
  await provider.applyLabels(target, labelsToAdd, labelsToRemove, options);
}

async function applyIssueBody(target, issue, desiredByKey, options) {
  if (!hasBodySection(options)) {
    return;
  }

  if (shouldSkipIssueBodyUpdate(desiredByKey)) {
    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            bodySkipped: true,
            reason: 'flow::clarify does not edit issue body',
          },
          null,
          2
        )
      );
    }
    return;
  }

  const body = readNormalizedBody(options);

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, body }, null, 2));
    return;
  }

  const provider = resolveProvider(options, {});
  await provider.updateIssueBody(target, body, options);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.plan) {
    throw new Error('--plan is no longer supported. Use --flow flow::plan or --flow flow::build.');
  }

  const issueNumber = parsePositiveInteger(options.issueNumber || options.issue, '--issue-number');
  const repoHint = resolveRepoHint(options);
  const provider = resolveProvider({ ...options, repo: repoHint }, {});
  const repo = provider.resolveRepo({}, { ...options, repo: repoHint });
  options.provider = provider.name;
  const target = {
    ...repo,
    provider: provider.name,
    issueNumber,
    number: issueNumber,
  };
  const desiredByKey = collectDesiredLabels(options);
  const clearKeys = collectClearKeys(options);
  if (Object.keys(desiredByKey).length === 0 && clearKeys.length === 0 && !hasBodySection(options)) {
    throw new Error('Nothing to apply. Pass at least one managed label or triage body option.');
  }

  const issue = options.dryRun
    ? { body: '', labels: [] }
    : await provider.getIssueForApply(target, options);
  const currentLabels = Array.isArray(issue.labels) ? issue.labels.map(normalizeLabelName).filter(Boolean) : [];

  await applyLabels(target, currentLabels, desiredByKey, clearKeys, options);
  await applyIssueBody(target, issue, desiredByKey, options);
}

module.exports = {
  collectClearKeys,
  collectDesiredLabels,
  computeLabelChanges,
  readNormalizedBody,
  shouldSkipIssueBodyUpdate,
  main,
  parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
