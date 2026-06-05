#!/usr/bin/env node

/**
 * resolve.cjs — Pure routing decision logic for issue-flow.
 *
 * Given an issue's current state (labels, open/closed), outputs the action
 * that should be taken (triage/plan/build/skip) and the reason why.
 *
 * This script has NO side effects — it does not call provider APIs, start agents,
 * or modify any state. It only reads event payloads and outputs a JSON decision.
 */

const fs = require('node:fs');
const { resolveProvider } = require('./providers.cjs');

const FLOW_PREFIX = 'flow::';
const STATUS_PREFIX = 'status::';
const AUTOMATION_PREFIX = 'automation::';
const NON_RESUMABLE_STATUS_LABELS = new Set(['status::done', 'status::drop', 'status::suspend']);
const SUPPORTED_FLOW_COMMANDS = new Map([
  ['flow::triage', 'triage'],
  ['flow::plan', 'plan'],
  ['flow::build', 'build'],
  ['flow::review', 'review'],
]);
const AUTOMATION_LEVELS = ['off', 'triage', 'plan', 'build'];
const AUTOMATION_LEVEL_RANK = new Map(AUTOMATION_LEVELS.map((level, index) => [level, index]));

function normalizeAutomationLevel(value, name = 'automation level') {
  const normalized = String(value || 'off')
    .trim()
    .toLowerCase();
  const level = normalized.startsWith(AUTOMATION_PREFIX)
    ? normalized.slice(AUTOMATION_PREFIX.length)
    : normalized;
  if (!AUTOMATION_LEVEL_RANK.has(level)) {
    throw new Error(`${name} must be one of: ${AUTOMATION_LEVELS.join(', ')}`);
  }
  return level;
}

function maxAutomationLevel(...levels) {
  return levels.reduce((current, next) => {
    const currentLevel = normalizeAutomationLevel(current);
    const nextLevel = normalizeAutomationLevel(next);
    return AUTOMATION_LEVEL_RANK.get(nextLevel) > AUTOMATION_LEVEL_RANK.get(currentLevel)
      ? nextLevel
      : currentLevel;
  }, 'off');
}

function automationCanRunAction(effectiveLevel, action) {
  const actionLevel = action === 'review' ? 'build' : action;
  const requiredLevel = normalizeAutomationLevel(actionLevel, 'issue-flow action');
  return AUTOMATION_LEVEL_RANK.get(normalizeAutomationLevel(effectiveLevel)) >= AUTOMATION_LEVEL_RANK.get(requiredLevel);
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

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels.map(normalizeLabelName).filter(Boolean);
}

function findSingleLabel(labels, prefix) {
  const matches = labels.filter((label) => label.startsWith(prefix));
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`Expected one ${prefix} label but found: ${matches.join(', ')}`);
  }
  return matches[0];
}

function resolveRepoDefaultAutomationLevel(options = {}) {
  return normalizeAutomationLevel(
    options.autoDefault || process.env.ISSUE_FLOW_AUTO_DEFAULT || 'off',
    '--auto-default'
  );
}

function resolveIssueAutomationLabel(labels) {
  const matches = labels.filter((label) => label.startsWith(AUTOMATION_PREFIX));
  if (matches.length === 0) {
    return undefined;
  }
  return matches.reduce((current, next) => {
    const currentLevel = normalizeAutomationLevel(current, 'automation label');
    const nextLevel = normalizeAutomationLevel(next, 'automation label');
    return AUTOMATION_LEVEL_RANK.get(nextLevel) > AUTOMATION_LEVEL_RANK.get(currentLevel)
      ? next
      : current;
  });
}

function resolveIssueAutomationLevel(labels) {
  const automationLabel = resolveIssueAutomationLabel(labels);
  return automationLabel ? normalizeAutomationLevel(automationLabel, 'automation label') : 'off';
}

function resolveAutomationDecision(issue, options = {}) {
  const labels = normalizeLabels(issue.labels);
  if (issue.state && issue.state !== 'open') {
    return {
      shouldRun: false,
      reason: 'issue_not_open',
      state: issue.state,
    };
  }

  const statusLabel = findSingleLabel(labels, STATUS_PREFIX);
  if (statusLabel && NON_RESUMABLE_STATUS_LABELS.has(statusLabel)) {
    return {
      shouldRun: false,
      reason: statusLabel,
      statusLabel,
    };
  }

  const flowLabel = findSingleLabel(labels, FLOW_PREFIX);
  if (!flowLabel) {
    return {
      shouldRun: false,
      reason: 'missing_flow_label',
      automationLabel: resolveIssueAutomationLabel(labels),
    };
  }

  const action = SUPPORTED_FLOW_COMMANDS.get(flowLabel);
  if (!action) {
    return {
      shouldRun: false,
      reason: 'unsupported_flow',
      flowLabel,
      automationLabel: resolveIssueAutomationLabel(labels),
    };
  }

  const repoDefaultLevel = resolveRepoDefaultAutomationLevel(options);
  const issueAutomationLevel = resolveIssueAutomationLevel(labels);
  const effectiveLevel = maxAutomationLevel(repoDefaultLevel, issueAutomationLevel);
  const automationLabel = resolveIssueAutomationLabel(labels);
  if (!automationCanRunAction(effectiveLevel, action)) {
    return {
      shouldRun: false,
      reason: 'automation_level_too_low',
      action,
      flowLabel,
      automationLabel,
      repoDefaultLevel,
      issueAutomationLevel,
      effectiveLevel,
    };
  }

  return {
    shouldRun: true,
    action,
    flowLabel,
    automationLabel,
    repoDefaultLevel,
    issueAutomationLevel,
    effectiveLevel,
  };
}

function resolveResumeDecision(issue) {
  const labels = normalizeLabels(issue.labels);

  const statusLabel = findSingleLabel(labels, STATUS_PREFIX);
  if (statusLabel && NON_RESUMABLE_STATUS_LABELS.has(statusLabel)) {
    return {
      shouldRun: false,
      reason: statusLabel,
      statusLabel,
    };
  }

  const flowLabel = findSingleLabel(labels, FLOW_PREFIX);
  if (!flowLabel) {
    return {
      shouldRun: false,
      reason: 'missing_flow_label',
    };
  }

  const action = SUPPORTED_FLOW_COMMANDS.get(flowLabel);
  if (!action) {
    return {
      shouldRun: false,
      reason: 'unsupported_flow',
      flowLabel,
    };
  }

  return {
    shouldRun: true,
    action,
    flowLabel,
  };
}

function extractMention(body, mentionPattern) {
  if (typeof body !== 'string') {
    return { triggered: false, instruction: '' };
  }

  const pattern = mentionPattern
    ? new RegExp(`(^|\\s)${mentionPattern.replace('@', '@')}\\b`, 'i')
    : /(^|\s)@bot\b/i;

  if (!pattern.test(body)) {
    return { triggered: false, instruction: '' };
  }

  const replacePattern = mentionPattern
    ? new RegExp(`(^|\\s)${mentionPattern.replace('@', '@')}\\b`, 'gi')
    : /(^|\s)@bot\b/gi;

  const instruction = body
    .replace(replacePattern, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s:：,，;；-]+/, '')
    .trim();

  return { triggered: true, instruction };
}

function resolveCommentDecision(payload, options = {}) {
  const provider = resolveProvider(options, payload);

  if (provider.isPullRequestIssue(payload)) {
    return { action: 'ignored', reason: 'pull_request' };
  }
  if (provider.isBotComment(payload)) {
    return { action: 'ignored', reason: 'bot_comment' };
  }

  const comment = provider.getCommentContext(payload);
  const mention = extractMention(comment.body);
  if (!mention.triggered) {
    return { action: 'ignored', reason: 'no_mention' };
  }

  const issue = provider.buildIssueContext(payload, options);

  if (mention.instruction) {
    return {
      action: 'general',
      issueNumber: issue.number,
      instruction: mention.instruction,
    };
  }

  const resume = resolveResumeDecision(issue);
  if (!resume.shouldRun) {
    return {
      action: 'resume_blocked',
      issueNumber: issue.number,
      ...resume,
    };
  }

  return {
    action: resume.action,
    issueNumber: issue.number,
    flowLabel: resume.flowLabel,
  };
}

// --- CLI ---

function usage() {
  return [
    'Usage: resolve.cjs <command> [options]',
    '',
    'Commands:',
    '  auto       Resolve automatic routing decision for an issue event',
    '  resume     Resolve resume action from current flow:: label',
    '  comment    Resolve routing decision for an issue comment event',
    '',
    'Options:',
    '  --event <path>          Event JSON path',
    '  --issue-number <num>    Issue number (alternative to --event)',
    '  --auto-default <level>  Repository default automation level: off, triage, plan, build',
    '  --provider <name>       github or gitlab',
    '  --repo <owner/repo>     Repository override',
    '',
    'Output: JSON decision object to stdout',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { _: [] };

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

  return { command, options };
}

function loadEvent(options) {
  const eventPath = options.event || process.env.GITHUB_EVENT_PATH || process.env.GITLAB_EVENT_PATH;
  if (!eventPath) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    console.log(usage());
    return;
  }

  const payload = loadEvent(options);
  let decision;

  switch (command) {
    case 'auto': {
      const provider = resolveProvider(options, payload);
      if (provider.isPullRequestIssue(payload)) {
        decision = { shouldRun: false, reason: 'pull_request' };
        break;
      }
      const issue = provider.buildIssueContext(payload, options);
      decision = resolveAutomationDecision(issue, options);
      break;
    }
    case 'resume': {
      const provider = resolveProvider(options, payload);
      const issue = provider.buildIssueContext(payload, options);
      decision = resolveResumeDecision(issue);
      break;
    }
    case 'comment': {
      decision = resolveCommentDecision(payload, options);
      break;
    }
    default:
      throw new Error(`Unknown resolve command: ${command}`);
  }

  console.log(JSON.stringify(decision, null, 2));
}

module.exports = {
  AUTOMATION_LEVELS,
  AUTOMATION_LEVEL_RANK,
  FLOW_PREFIX,
  NON_RESUMABLE_STATUS_LABELS,
  STATUS_PREFIX,
  SUPPORTED_FLOW_COMMANDS,
  automationCanRunAction,
  extractMention,
  findSingleLabel,
  maxAutomationLevel,
  normalizeAutomationLevel,
  normalizeLabelName,
  normalizeLabels,
  resolveAutomationDecision,
  resolveCommentDecision,
  resolveIssueAutomationLabel,
  resolveIssueAutomationLevel,
  resolveRepoDefaultAutomationLevel,
  resolveResumeDecision,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
