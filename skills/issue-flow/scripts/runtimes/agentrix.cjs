const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProvider } = require('../providers.cjs');

const DEFAULT_AGENT = 'codex';
const DEFAULT_RESPONSE_MODE = 'async';
const DEFAULT_AGENTRIX_RUN_VERSION = '0.4.0';
const DEFAULT_MENTION = '@agentrix';
const DEFAULT_PROJECT_CONFIG_PATH = '.github/agentrix/issue-flow/config.json';
const DEFAULT_PROMPTS_DIR = '.github/agentrix/issue-flow';
const DEFAULT_TEMPLATES_DIR = '.github/agentrix/issue-flow/templates';
const DEFAULT_PLAN_ROOT_DIR = '.agentrix/issues';
const PLAN_SUBDIR = 'plan';
const PLAN_BRANCH_SUFFIX = 'plan';
const BUILD_BRANCH_SUFFIX = 'build';
const FEATURE_PLAN_FILE = '001-implementation.md';
const BUG_PLAN_FILE = '001-root-cause-and-fix.md';

const PROMPT_FILES = {
  triage: 'triage.prompt.md',
  general: 'general.prompt.md',
  build: 'build.prompt.md',
  planBug: 'plan-bug.prompt.md',
  planImpl: 'plan-impl.prompt.md',
};

const TEMPLATE_FILES = {
  planBug: 'plan-bug.md',
  planImpl: 'plan-impl.md',
};

const SUPPORTED_ACTIONS = ['triage', 'plan', 'build', 'general'];

function packageRootDir() {
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function agentrixAssetsDir() {
  return path.join(packageRootDir(), 'assets', 'agentrix');
}

function readJsonFile(filePath, required = false) {
  if (!fs.existsSync(filePath)) {
    if (required) {
      throw new Error(`Config file not found: ${filePath}`);
    }
    return {};
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeConfigShape(config) {
  return config && typeof config.agentrix === 'object' && !Array.isArray(config.agentrix)
    ? config.agentrix
    : config || {};
}

function resolveProjectConfigPath(options = {}) {
  return options.config || process.env.ISSUE_FLOW_CONFIG || DEFAULT_PROJECT_CONFIG_PATH;
}

function resolveRepoPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function resolveAgentrixConfig(options = {}) {
  const explicitConfigPath = Boolean(options.config || process.env.ISSUE_FLOW_CONFIG);
  const projectConfigPath = resolveRepoPath(resolveProjectConfigPath(options));
  const projectConfig = normalizeConfigShape(readJsonFile(projectConfigPath, explicitConfigPath));

  const promptsDir = options.promptsDir || projectConfig.promptsDir || DEFAULT_PROMPTS_DIR;
  const templatesDir = options.templatesDir || projectConfig.templatesDir || DEFAULT_TEMPLATES_DIR;
  const planRootDir = options.planRootDir || projectConfig.planRootDir || DEFAULT_PLAN_ROOT_DIR;

  return {
    mention: DEFAULT_MENTION,
    projectConfigPath,
    projectPromptsDir: resolveRepoPath(promptsDir),
    projectTemplatesDir: resolveRepoPath(templatesDir),
    planRootDir: resolveRepoPath(planRootDir),
    planRootDirDisplay: normalizeRepoPath(planRootDir),
    defaultPromptsDir: path.join(agentrixAssetsDir(), 'prompts'),
    defaultTemplatesDir: path.join(agentrixAssetsDir(), 'templates'),
  };
}

function normalizeRepoPath(filePath) {
  const relative = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  return relative.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function readFirstExisting(paths, label) {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) {
      return {
        path: filePath,
        body: fs.readFileSync(filePath, 'utf8').trim(),
      };
    }
  }
  throw new Error(`Missing ${label}. Looked in: ${paths.join(', ')}`);
}

function promptNameForAction(action, issue) {
  if (action !== 'plan') {
    return action;
  }
  return hasLabel(issue, 'type::bug') ? 'planBug' : 'planImpl';
}

function templateNameForIssue(issue) {
  return hasLabel(issue, 'type::bug') ? 'planBug' : 'planImpl';
}

function planFileNameForIssue(issue) {
  return hasLabel(issue, 'type::bug') ? BUG_PLAN_FILE : FEATURE_PLAN_FILE;
}

function readPrompt(action, issue, options = {}) {
  const config = resolveAgentrixConfig(options);
  const promptName = promptNameForAction(action, issue);
  const fileName = PROMPT_FILES[promptName];
  return readFirstExisting(
    [path.join(config.projectPromptsDir, fileName), path.join(config.defaultPromptsDir, fileName)],
    `${promptName} prompt`
  );
}

function resolvePlanTemplate(issue, options = {}) {
  const config = resolveAgentrixConfig(options);
  const templateName = templateNameForIssue(issue);
  const fileName = TEMPLATE_FILES[templateName];
  return readFirstExisting(
    [path.join(config.projectTemplatesDir, fileName), path.join(config.defaultTemplatesDir, fileName)],
    `${templateName} template`
  );
}

function hasLabel(issue, label) {
  return Array.isArray(issue.labels) && issue.labels.includes(label);
}

function slugifyIssueTitle(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'issue';
}

function issueDirectoryName(issue) {
  return `${issue.number}-${slugifyIssueTitle(issue.title)}`;
}

function buildIssuePlanDir(issue, options = {}) {
  const config = resolveAgentrixConfig(options);
  return path.join(config.planRootDir, issueDirectoryName(issue), PLAN_SUBDIR);
}

function buildIssuePlanFile(issue, options = {}) {
  return path.join(buildIssuePlanDir(issue, options), planFileNameForIssue(issue));
}

function buildIssuePlanPattern(issue, options = {}) {
  return `${normalizeRepoPath(buildIssuePlanDir(issue, options))}/*.md`;
}

function buildIssuePlanBranch(issue) {
  return `${issueDirectoryName(issue)}/${PLAN_BRANCH_SUFFIX}`;
}

function buildIssueBuildBranch(issue) {
  return `${issueDirectoryName(issue)}/${BUILD_BRANCH_SUFFIX}`;
}

function findIssuePlanFiles(issue, options = {}) {
  const config = resolveAgentrixConfig(options);
  if (!fs.existsSync(config.planRootDir)) {
    return [];
  }

  const prefix = `${issue.number}-`;
  const planFiles = [];
  for (const entry of fs.readdirSync(config.planRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
      continue;
    }
    const planDir = path.join(config.planRootDir, entry.name, PLAN_SUBDIR);
    if (!fs.existsSync(planDir)) {
      continue;
    }
    for (const planEntry of fs.readdirSync(planDir, { withFileTypes: true })) {
      if (planEntry.isFile() && planEntry.name.endsWith('.md')) {
        planFiles.push(normalizeRepoPath(path.join(planDir, planEntry.name)));
      }
    }
  }
  return planFiles.sort();
}

function formatIssueForPrompt(issue) {
  return [
    '## Issue',
    '',
    `Number: #${issue.number}`,
    `State: ${issue.state || '(unknown)'}`,
    `Labels: ${Array.isArray(issue.labels) && issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`,
    `Title: ${issue.title || '(untitled)'}`,
    '',
    'Body:',
    issue.body || '(empty)',
  ].join('\n');
}

function formatPlanOutput(issue, options = {}) {
  const lines = [
    '## Plan Output',
    '',
  ];
  const template = resolvePlanTemplate(issue, options);
  lines.push(`Plan template: \`${normalizeRepoPath(template.path)}\``);
  lines.push(`Plan output file: \`${normalizeRepoPath(buildIssuePlanFile(issue, options))}\``);
  lines.push(`Plan branch: \`${buildIssuePlanBranch(issue)}\``);

  return lines.join('\n');
}

function buildPrompt(action, issue, data = {}, options = {}) {
  const prompt = readPrompt(action, issue, options);
  const blocks = [prompt.body];

  if (action === 'plan') {
    blocks.push('', formatPlanOutput(issue, options));
  }

  blocks.push('', formatIssueForPrompt(issue));

  if (action === 'build') {
    const planPattern = buildIssuePlanPattern(issue, options);
    const planFiles = findIssuePlanFiles(issue, options);
    blocks.push('', '## Branch', '', `Create or switch to this non-base branch before committing: \`${buildIssueBuildBranch(issue)}\``);
    blocks.push('', '## Plan Files', '', `Search rule: \`${planPattern}\``);
    if (planFiles.length > 0) {
      blocks.push('', 'Read every plan file below before editing:', '', ...planFiles.map((file) => `- \`${file}\``));
    } else {
      blocks.push('', 'No plan files matched in this checkout. Build directly from the issue and repository context.');
    }
  }

  if (data.instruction) {
    blocks.push('', '## Instruction', '', data.instruction);
  }

  return blocks.join('\n');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractMention(body) {
  if (typeof body !== 'string') {
    return {
      triggered: false,
      instruction: '',
    };
  }

  const mentionPattern = new RegExp(`(^|\\s)${escapeRegExp(DEFAULT_MENTION)}\\b`, 'i');
  if (!mentionPattern.test(body)) {
    return {
      triggered: false,
      instruction: '',
    };
  }

  const replacePattern = new RegExp(`(^|\\s)${escapeRegExp(DEFAULT_MENTION)}\\b`, 'gi');
  const instruction = body
    .replace(replacePattern, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s:：,，;；-]+/, '')
    .trim();

  return {
    triggered: true,
    instruction,
  };
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value || '';
  }
  return `${value.slice(0, maxLength - 3)}...`;
}

function resolveAgent(options = {}) {
  return options.agent || process.env.AGENTRIX_ISSUE_FLOW_AGENT || process.env.AGENTRIX_AGENT || DEFAULT_AGENT;
}

function resolveResponseMode(options = {}) {
  return options.responseMode || process.env.AGENTRIX_RESPONSE_MODE || DEFAULT_RESPONSE_MODE;
}

function resolveAgentrixRunPackage() {
  const version = process.env.AGENTRIX_RUN_VERSION || DEFAULT_AGENTRIX_RUN_VERSION;
  return `@agentrix/agentrix-run@${version}`;
}

function appendOptionalArg(args, flag, value) {
  if (value) {
    args.push(flag, value);
  }
}

function buildRunTitle(action, issue) {
  const actionTitle = action === 'general' ? 'General' : action[0].toUpperCase() + action.slice(1);
  return `${actionTitle} #${issue.number}: ${truncate(issue.title || 'untitled issue', 80)}`;
}

function run(action, issue, options = {}, data = {}) {
  const prompt = buildPrompt(action, issue, data, options);
  if (options.dryRun) {
    const result = {
      runId: 'dry-run',
      status: 'dry-run',
      detailUrl: '',
      result: '',
    };
    console.log(JSON.stringify({ dryRun: true, runtime: 'agentrix', action, issue: issue.number, prompt }, null, 2));
    return result;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-agentrix-'));
  const resultFile = path.join(tempDir, 'result.json');
  const provider = resolveProvider(options, data.payload || {});
  const args = [
    '--yes',
    resolveAgentrixRunPackage(),
    '--agent',
    resolveAgent(options),
    '--title',
    buildRunTitle(action, issue),
    '--prompt',
    prompt,
    '--response-mode',
    resolveResponseMode(options),
    '--result-file',
    resultFile,
    '--issue-number',
    String(issue.number),
    '--metadata',
    `issue_flow_action=${action}`,
    '--metadata',
    `issue_flow_issue=${issue.repoFullName}#${issue.number}`,
  ];

  appendOptionalArg(args, '--base-url', options.baseUrl || process.env.AGENTRIX_BASE_URL);
  appendOptionalArg(args, '--api-key', options.apiKey || process.env.AGENTRIX_API_KEY);
  appendOptionalArg(args, '--runner-id', options.runnerId || process.env.AGENTRIX_RUNNER_ID);
  appendOptionalArg(args, '--capability-profile', options.capabilityProfile || process.env.AGENTRIX_CAPABILITY_PROFILE);

  const child = spawnSync('npx', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTRIX_EVENT_NAME:
        process.env.AGENTRIX_EVENT_NAME ||
        process.env[provider.envEventName] ||
        process.env.GITHUB_EVENT_NAME ||
        process.env.GITLAB_EVENT_NAME ||
        'issue_flow',
      AGENTRIX_EVENT_ACTION: process.env.AGENTRIX_EVENT_ACTION || action,
    },
  });

  try {
    if (child.status !== 0) {
      throw new Error(`agentrix-run exited with status ${child.status ?? 1}`);
    }
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildTaskCommentMarker(action) {
  return `<!-- issue-flow:task:agentrix:${action} -->`;
}

function buildTaskComment(action, result, data = {}) {
  const lines = [buildTaskCommentMarker(action)];
  if (result.status === 'starting') {
    lines.push('Agentrix task starting. This comment prevents duplicate issue-flow tasks for the same issue/action.');
  } else if (result.detailUrl) {
    lines.push(`Agentrix task queued: [open task](${result.detailUrl}).`);
  } else {
    lines.push('Agentrix task queued.');
  }
  lines.push('');
  lines.push(`Action: \`${action}\``);
  if (result.runId) {
    lines.push(`Run: \`${result.runId}\``);
  }
  if (data.comment && data.comment.htmlUrl) {
    lines.push(`Trigger: ${data.comment.htmlUrl}`);
  } else if (data.auto) {
    lines.push('Trigger: automatic issue-flow.');
  }
  return lines.join('\n');
}

function shouldAcknowledgeAutoIssue(action, data = {}) {
  return action === 'triage' && data.auto === true;
}

module.exports = {
  DEFAULT_MENTION,
  SUPPORTED_ACTIONS,
  buildIssueBuildBranch,
  buildIssuePlanBranch,
  buildIssuePlanFile,
  buildIssuePlanPattern,
  buildPrompt,
  buildTaskComment,
  buildTaskCommentMarker,
  extractMention,
  findIssuePlanFiles,
  issueDirectoryName,
  normalizeRepoPath,
  resolveAgentrixConfig,
  resolvePlanTemplate,
  run,
  shouldAcknowledgeAutoIssue,
};
