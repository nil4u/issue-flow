#!/usr/bin/env node

const { providers, resolveProvider } = require('./providers.cjs');
const { loadEventPayload } = require('./events.cjs');
const {
  resolveAutomationDecision: resolveCoreAutomationDecision,
  resolveResumeDecision,
} = require('./resolve.cjs');
const prMerged = require('./pr-merged.cjs');

const DEFAULT_RUNTIME = 'agentrix';
const TRIGGER_COMMENT_REACTION = 'eyes';
const VALUE_OPTIONS = new Set([
  '--event',
  '--provider',
  '--repo',
  '--runtime',
  '--issue-number',
  '--instruction',
  '--auto-default',
  '--config',
  '--prompts-dir',
  '--templates-dir',
  '--plan-root-dir',
  '--gitlab-url',
  '--gitlab-api-url',
  '--gitlab-project',
  '--gitlab-token',
]);

function logIssueFlow(message, details = {}) {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`);
  console.log(`[issue-flow] ${message}${entries.length > 0 ? ` ${entries.join(' ')}` : ''}`);
}

function usage() {
  return [
    'Usage: dispatch.cjs <command> [options]',
    '',
    'Commands:',
    '  auto       Run the current flow:: action when automation policy allows it',
    '  comment    Route an issue comment for the selected runtime mention',
    '  pr-merged  Apply merged plan/build PR transition',
    '  resume     Run the action selected by the current flow:: label',
    '  general    Start a broad runtime action from a manual instruction',
    '  triage     Start triage action',
    '  plan       Start plan action',
    '  build      Start build action',
    '',
    'Common options:',
    '  --event <path>          Event JSON path. Defaults to GITHUB_EVENT_PATH or GITLAB_EVENT_PATH.',
    '  --provider <provider>   Git hosting provider: github or gitlab. Defaults from event/environment.',
    '  --repo <owner/repo>     Repository/project override.',
    '  --runtime <name>        Runtime preset. Defaults to agentrix.',
    '  --issue-number <num>    Issue number override.',
    '  --instruction <text>    Manual instruction for the general command.',
    '  --auto-default <level>  Repository default automation level: off, triage, plan, or build.',
    '  --config <path>         Runtime config path.',
    '  --prompts-dir <path>    Agentrix prompt override directory.',
    '  --templates-dir <path>  Agentrix template override directory.',
    '  --plan-root-dir <path>  Agentrix plan root directory.',
    '  --dry-run              Print intended behavior without calling external APIs.',
    '  --help',
  ].join('\n');
}

function parseArgs(argv) {
  if (argv[0] === '--help') {
    return {
      command: undefined,
      options: {
        _: [],
        help: true,
      },
    };
  }

  const command = argv[0];
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

  return { command, options };
}

function loadEvent(options = {}) {
  const loaded = loadEventPayload(options);
  if (loaded.source === 'empty') {
    logIssueFlow('No event path provided; using empty payload');
    return {};
  }

  if (loaded.source === 'file') {
    logIssueFlow('Loading event payload', { eventPath: loaded.eventPath });
  } else {
    logIssueFlow('Loading event payload from Agentrix GitLab bridge');
  }

  const payload = loaded.payload;
  const provider = resolveProvider(options, payload);
  logIssueFlow('Loaded event payload', {
    provider: provider.name,
    event: process.env[provider.envEventName] || process.env.GITHUB_EVENT_NAME || process.env.GITLAB_EVENT_NAME,
    action: payload.action,
  });
  return payload;
}

function loadRuntime(options = {}) {
  const runtimeName = options.runtime || process.env.ISSUE_FLOW_RUNTIME || DEFAULT_RUNTIME;
  if (runtimeName !== 'agentrix') {
    throw new Error(`Unsupported issue-flow runtime: ${runtimeName}`);
  }
  return require('./runtimes/agentrix.cjs');
}

function buildIssueContext(payload, options = {}) {
  return resolveProvider(options, payload).buildIssueContext(payload, options);
}

function isPullRequestIssue(payload, options = {}) {
  return resolveProvider(options, payload).isPullRequestIssue(payload);
}

function isBotComment(payload, options = {}) {
  return resolveProvider(options, payload).isBotComment(payload);
}

function getCommentContext(payload, options = {}) {
  return resolveProvider(options, payload).getCommentContext(payload);
}

async function fetchCurrentIssue(issue, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  if (options.dryRun || !provider.hasToken(options)) {
    logIssueFlow('Using payload issue state', {
      issue: `#${issue.number}`,
      dryRun: Boolean(options.dryRun),
      provider: provider.name,
      hasToken: Boolean(provider.hasToken(options)),
    });
    return issue;
  }

  logIssueFlow('Fetching current issue state', { issue: `#${issue.number}`, provider: provider.name });
  const currentIssue = await provider.fetchCurrentIssue(issue, options);
  logIssueFlow('Fetched current issue state', {
    issue: `#${currentIssue.number}`,
    state: currentIssue.state,
    labels: currentIssue.labels.join(',') || '(none)',
  });
  return currentIssue;
}

async function listIssueComments(issue, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  return provider.listIssueComments(issue, options);
}

async function createIssueComment(issue, body, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  return provider.createIssueComment(issue, body, options);
}

async function updateIssueComment(issue, commentId, body, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  await provider.updateIssueComment(issue, commentId, body, options);
}

async function deleteIssueComment(issue, commentId, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  await provider.deleteIssueComment(issue, commentId, options);
}

async function addTriggerCommentReaction(issue, comment, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  await provider.addTriggerCommentReaction(issue, comment, TRIGGER_COMMENT_REACTION, options);
}

async function addIssueReaction(issue, options = {}) {
  const provider = providers[issue.provider] || resolveProvider(options);
  await provider.addIssueReaction(issue, TRIGGER_COMMENT_REACTION, options);
}

function findActionTaskComment(comments, action, runtime) {
  const marker = runtime.buildTaskCommentMarker(action);
  return Array.isArray(comments)
    ? comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(marker))
    : undefined;
}

function normalizeCommentId(comment) {
  return comment && comment.id !== undefined ? String(comment.id) : '';
}

async function claimActionTask(issue, action, runtime, data, options = {}) {
  const existing = findActionTaskComment(await listIssueComments(issue, options), action, runtime);
  if (existing) {
    return {
      claimed: false,
      comment: existing,
    };
  }

  const created = await createIssueComment(issue, runtime.buildTaskComment(action, { status: 'starting' }, data), options);
  if (options.dryRun) {
    return {
      claimed: true,
      comment: created,
    };
  }

  const winner = findActionTaskComment(await listIssueComments(issue, options), action, runtime);
  if (winner && normalizeCommentId(winner) !== normalizeCommentId(created)) {
    try {
      await deleteIssueComment(issue, created.id, options);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`Unable to delete duplicate issue-flow task lock comment; continuing. ${detail}`);
    }
    return {
      claimed: false,
      comment: winner,
    };
  }

  return {
    claimed: true,
    comment: created,
  };
}

async function acknowledgeAutoIssue(issue, action, runtime, data, options = {}) {
  if (!runtime.shouldAcknowledgeAutoIssue(action, data)) {
    return;
  }

  try {
    await addIssueReaction(issue, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to add reaction to automatic issue-flow issue; continuing. ${detail}`);
  }
}

async function acknowledgeTriggerComment(issue, comment, options = {}) {
  try {
    await addTriggerCommentReaction(issue, comment, options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Unable to add reaction to trigger comment; continuing. ${detail}`);
  }
}

function runtimeCanRunAction(runtime, action) {
  return Array.isArray(runtime.SUPPORTED_ACTIONS) && runtime.SUPPORTED_ACTIONS.includes(action);
}

function resolveRepoDefaultAutomationLevel(options = {}) {
  return options.autoDefault || process.env.ISSUE_FLOW_AUTO_DEFAULT || 'off';
}

function resolveAutomationDecision(issue, runtime, options = {}) {
  const decision = resolveCoreAutomationDecision(issue, {
    ...options,
    autoDefault: resolveRepoDefaultAutomationLevel(options),
  });
  if (decision.shouldRun && !runtimeCanRunAction(runtime, decision.action)) {
    return {
      ...decision,
      shouldRun: false,
      reason: 'unsupported_flow',
    };
  }
  return decision;
}

function resolveRuntimeResumeDecision(issue, runtime) {
  const decision = resolveResumeDecision(issue);
  if (decision.shouldRun && !runtimeCanRunAction(runtime, decision.action)) {
    return {
      ...decision,
      shouldRun: false,
      reason: 'unsupported_flow',
    };
  }
  return decision;
}

async function startAction(action, issue, options = {}, data = {}) {
  const runtime = loadRuntime(options);
  if (!runtimeCanRunAction(runtime, action)) {
    throw new Error(`Runtime does not support issue-flow action: ${action}`);
  }

  logIssueFlow('Starting action', {
    action,
    issue: `#${issue.number}`,
    dryRun: Boolean(options.dryRun),
  });
  const currentIssue = await fetchCurrentIssue(issue, options);
  const taskClaim = await claimActionTask(currentIssue, action, runtime, data, options);
  if (!taskClaim.claimed) {
    logIssueFlow('Skipping duplicate action task', {
      action,
      issue: `#${currentIssue.number}`,
      comment: taskClaim.comment && taskClaim.comment.id,
    });
    return {
      action,
      skipped: true,
      reason: 'duplicate_task',
      existingCommentId: taskClaim.comment && taskClaim.comment.id,
      existingCommentUrl: taskClaim.comment && (taskClaim.comment.html_url || taskClaim.comment.htmlUrl || taskClaim.comment.web_url),
    };
  }

  let result;
  try {
    result = runtime.run(action, currentIssue, options, data);
  } catch (error) {
    if (taskClaim.comment && taskClaim.comment.id) {
      try {
        await deleteIssueComment(currentIssue, taskClaim.comment.id, options);
      } catch (deleteError) {
        const detail = deleteError instanceof Error ? deleteError.message : String(deleteError);
        console.warn(`Unable to delete failed issue-flow task lock comment; continuing. ${detail}`);
      }
    }
    throw error;
  }

  await acknowledgeAutoIssue(currentIssue, action, runtime, data, options);
  if (taskClaim.comment && taskClaim.comment.id) {
    await updateIssueComment(currentIssue, taskClaim.comment.id, runtime.buildTaskComment(action, result, data), options);
  }
  logIssueFlow('Finished action', {
    action,
    issue: `#${currentIssue.number}`,
    runId: result.runId,
  });
  return {
    action,
    result,
  };
}

async function runAuto(options = {}, provided = {}) {
  const runtime = loadRuntime(options);
  const payload = provided.payload || loadEvent(options);
  logIssueFlow('Handling automatic issue-flow event');
  if (isPullRequestIssue(payload, options)) {
    logIssueFlow('Issue event belongs to a pull request; auto ignored');
    return {
      action: 'ignored',
      reason: 'pull_request',
    };
  }

  let issue = provided.issue || buildIssueContext(payload, options);
  issue = await fetchCurrentIssue(issue, options);
  const decision = resolveAutomationDecision(issue, runtime, options);
  if (!decision.shouldRun) {
    logIssueFlow('Automatic issue-flow skipped', {
      issue: `#${issue.number}`,
      reason: decision.reason,
      flow: decision.flowLabel,
      automation: decision.automationLabel,
      effective: decision.effectiveLevel,
    });
    return {
      action: 'skipped',
      ...decision,
    };
  }

  logIssueFlow('Automatic issue-flow allowed', {
    issue: `#${issue.number}`,
    action: decision.action,
    flow: decision.flowLabel,
    automation: decision.automationLabel,
    default: decision.repoDefaultLevel,
    effective: decision.effectiveLevel,
  });

  return startAction(decision.action, issue, options, {
    ...provided,
    payload,
    issue,
    auto: true,
    automationDecision: decision,
  });
}

async function runResume(options = {}, provided = {}) {
  const runtime = loadRuntime(options);
  const payload = provided.payload || loadEvent(options);
  let issue = provided.issue || buildIssueContext(payload, options);
  logIssueFlow('Starting resume', { issue: `#${issue.number}` });
  issue = await fetchCurrentIssue(issue, options);

  const decision = resolveRuntimeResumeDecision(issue, runtime);
  if (!decision.shouldRun) {
    return {
      action: 'skipped',
      ...decision,
    };
  }

  return startAction(decision.action, issue, options, {
    ...provided,
    payload,
    issue,
    flowLabel: decision.flowLabel,
  });
}

async function runComment(options = {}) {
  const runtime = loadRuntime(options);
  const payload = loadEvent(options);
  logIssueFlow('Handling issue comment event');
  if (isPullRequestIssue(payload, options)) {
    logIssueFlow('Issue comment belongs to a pull request; ignored');
    return {
      action: 'ignored',
      reason: 'pull_request',
    };
  }
  if (isBotComment(payload, options)) {
    logIssueFlow('Bot comment ignored');
    return {
      action: 'ignored',
      reason: 'bot_comment',
    };
  }

  const comment = getCommentContext(payload, options);
  const route = runtime.extractMention(comment.body, options);
  if (!route.triggered) {
    logIssueFlow('No runtime mention found; ignored');
    return {
      action: 'ignored',
      reason: 'no_mention',
    };
  }

  const issue = buildIssueContext(payload, options);
  await acknowledgeTriggerComment(issue, comment, options);

  if (route.instruction) {
    return startAction('general', issue, options, {
      payload,
      issue,
      comment,
      instruction: route.instruction,
    });
  }

  return runResume(options, {
    payload,
    issue,
    comment,
  });
}

async function runPrMerged(options = {}) {
  const transition = await prMerged.runPrMerged(options);
  if (transition.action !== 'applied' || !transition.sourceIssue) {
    return transition;
  }

  logIssueFlow('Auto-resuming after merged PR transition', {
    issue: `#${transition.sourceIssue.number}`,
    kind: transition.kind,
    flow: transition.flow,
    status: transition.status,
  });
  const autoResume = await runAuto(options, {
    payload: {},
    issue: transition.sourceIssue,
    prMerged: transition,
  });
  return {
    transition,
    autoResume,
  };
}

async function runDirectAction(action, options = {}, provided = {}) {
  const payload = provided.payload || loadEvent(options);
  const issue = provided.issue || buildIssueContext(payload, options);
  const instruction = action === 'general'
    ? provided.instruction || options.instruction || options._.join(' ').trim()
    : undefined;
  if (action === 'general' && !instruction) {
    throw new Error('general requires --instruction or positional instruction text');
  }
  return startAction(action, issue, options, {
    ...provided,
    payload,
    issue,
    instruction,
  });
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    console.log(usage());
    return 0;
  }

  logIssueFlow('Command started', {
    command,
    runtime: options.runtime || process.env.ISSUE_FLOW_RUNTIME || DEFAULT_RUNTIME,
    dryRun: Boolean(options.dryRun),
  });
  switch (command) {
    case 'auto':
      await runAuto(options);
      break;
    case 'comment':
      await runComment(options);
      break;
    case 'pr-merged':
      await runPrMerged(options);
      break;
    case 'resume':
      await runResume(options);
      break;
    case 'general':
    case 'triage':
    case 'plan':
    case 'build':
      await runDirectAction(command, options);
      break;
    default:
      throw new Error(`Unknown issue-flow dispatch command: ${command}`);
  }
  logIssueFlow('Command finished', { command });
  return 0;
}

module.exports = {
  buildIssueContext,
  findActionTaskComment,
  loadRuntime,
  main,
  parseArgs,
  resolveAutomationDecision,
  resolveRepoDefaultAutomationLevel,
  resolveRuntimeResumeDecision,
  runAuto,
  runComment,
  runDirectAction,
  runPrMerged,
  runResume,
  startAction,
};

if (require.main === module) {
  main().catch((error) => {
    logIssueFlow('Command failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
