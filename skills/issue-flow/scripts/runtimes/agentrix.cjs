const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProvider } = require('../providers.cjs');

const DEFAULT_AGENT = 'codex';
const DEFAULT_RESPONSE_MODE = 'async';
const DEFAULT_AGENTRIX_RUN_VERSION = '0.4.0';
const DEFAULT_MENTION = '@agentrix';
const MENTION_PATTERN = /(^|[^A-Za-z0-9._-])(?:@agentrix|\/agentrix)(?=$|[^A-Za-z0-9._-])/i;
const MENTION_REPLACE_PATTERN = /(^|[^A-Za-z0-9._-])(?:@agentrix|\/agentrix)(?=$|[^A-Za-z0-9._-])/gi;
const DEFAULT_PROJECT_CONFIG_PATH = '.issue-flow/config.json';
const DEFAULT_PROMPTS_DIR = '.issue-flow/prompts';
const DEFAULT_TEMPLATES_DIR = '.issue-flow/templates';
const DEFAULT_PLAN_ROOT_DIR = '.issue-flow/issues';
const PLAN_SUBDIR = 'plan';
const PLAN_BRANCH_SUFFIX = 'plan';
const BUILD_BRANCH_SUFFIX = 'build';
const FEATURE_PLAN_FILE = '001-implementation.md';
const BUG_PLAN_FILE = '001-root-cause-and-fix.md';
const PROMPT_CONTEXT_LABEL_SKIP_PREFIXES = ['status::', 'flow::', 'automation::'];

const PROMPT_FILES = {
  triage: 'triage.prompt.md',
  general: 'general.prompt.md',
  build: 'build.prompt.md',
  review: 'review.prompt.md',
  planBug: 'plan-bug.prompt.md',
  planImpl: 'plan-impl.prompt.md',
};

const TEMPLATE_FILES = {
  planBug: 'plan-bug.md',
  planImpl: 'plan-impl.md',
};

const SUPPORTED_ACTIONS = ['triage', 'plan', 'build', 'general', 'review'];

function skillRootDir() {
  return path.resolve(__dirname, '..', '..');
}

function agentrixAssetsDir() {
  return path.join(skillRootDir(), 'assets', 'agentrix', 'runtime');
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
  if (action === 'review') {
    return 'review';
  }
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

function formatIssueLabelsForPrompt(issue) {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label) => !PROMPT_CONTEXT_LABEL_SKIP_PREFIXES.some((prefix) => label.startsWith(prefix)))
    : [];
  return labels.length > 0 ? labels.join(', ') : '(none)';
}

function formatIssueForPrompt(issue) {
  return [
    '## Issue',
    '',
    `Number: #${issue.number}`,
    `Labels: ${formatIssueLabelsForPrompt(issue)}`,
    `Title: ${issue.title || '(untitled)'}`,
    '',
    'Body:',
    issue.body || '(empty)',
  ].join('\n');
}

function formatPullRequestForPrompt(pr) {
  return [
    '## Review Target',
    '',
    `URL: ${pr.htmlUrl || '(unknown)'}`,
  ].join('\n');
}

function formatRequiredSkill() {
  return [
    '## Required Skill',
    '',
    `Read this project-level skill file before acting: \`${normalizeRepoPath(path.join(skillRootDir(), 'SKILL.md'))}\``,
  ].join('\n');
}

function formatPrBodyFileRule() {
  return [
    'PR body: write it to a repo-external temp file (for example `mktemp`) for `submit.cjs --body-file`; do not put it in git.',
  ].join('\n');
}

function formatReviewSubmission(pr) {
  return [
    '## Review Submission',
    '',
    'Write the review body to a repo-external temp file, then submit it once:',
    '',
    '```bash',
    `node ${normalizeRepoPath(path.join(skillRootDir(), 'scripts', 'review.cjs'))} --pr-number ${pr.number} --body-file <tmp-review-body-file>`,
    '```',
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
  if (action === 'review') {
    return buildPullRequestPrompt(issue, data, options);
  }

  const prompt = readPrompt(action, issue, options);
  const blocks = [formatRequiredSkill(), '', prompt.body];

  if ((action === 'plan' || action === 'build') && !prompt.body.includes('repo-external temp file')) {
    blocks.push('', formatPrBodyFileRule());
  }

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

function extractSourceIssueNumberFromPullRequest(pr = {}) {
  const candidates = [
    pr.body,
    pr.title,
    pr.headRef,
    pr.baseRef,
  ].filter(Boolean).map(String);

  const patterns = [
    /<!--\s*issue-flow:source-issue=(\d+)\s*-->/i,
    /Source issue:\s*#(\d+)/i,
    /\b(?:Plan|Build)\s+#(\d+)/i,
    /^(\d+)-[^/]+\/(?:plan|build)$/i,
  ];

  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      if (match) {
        return Number.parseInt(match[1], 10);
      }
    }
  }
  return undefined;
}

function buildPullRequestPrompt(pr, data = {}, options = {}) {
  const prompt = readPrompt('review', pr, options);
  const blocks = [formatRequiredSkill(), '', prompt.body, '', formatPullRequestForPrompt(pr), '', formatReviewSubmission(pr)];
  if (data.instruction) {
    blocks.push('', '## Instruction', '', data.instruction);
  }
  return blocks.join('\n');
}

function extractMention(body) {
  if (typeof body !== 'string') {
    return {
      triggered: false,
      instruction: '',
    };
  }

  if (!MENTION_PATTERN.test(body)) {
    return {
      triggered: false,
      instruction: '',
    };
  }

  const instruction = body
    .replace(MENTION_REPLACE_PATTERN, ' ')
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
  if (action === 'review') {
    return `Review PR #${issue.number}: ${truncate(issue.title || 'untitled pull request', 80)}`;
  }
  const actionTitle = action === 'general' ? 'General' : action[0].toUpperCase() + action.slice(1);
  return `${actionTitle} #${issue.number}: ${truncate(issue.title || 'untitled issue', 80)}`;
}

function buildRunArgs(action, issue, options = {}, data = {}, prompt = '', resultFile = '') {
  const metadataSubject = action === 'review'
    ? ['--metadata', `issue_flow_pr=${issue.repoFullName}#${issue.number}`]
    : ['--issue-number', String(issue.number), '--metadata', `issue_flow_issue=${issue.repoFullName}#${issue.number}`];
  const sourceIssueNumber = data.sourceIssueNumber || (action === 'review' ? extractSourceIssueNumberFromPullRequest(issue) : undefined);
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
    ...metadataSubject,
    '--metadata',
    `issue_flow_action=${action}`,
  ];
  if (action === 'review' && sourceIssueNumber) {
    args.push('--issue-number', String(sourceIssueNumber));
  }
  if (sourceIssueNumber) {
    args.push('--metadata', `issue_flow_source_issue=${issue.repoFullName}#${sourceIssueNumber}`);
  }

  appendOptionalArg(args, '--base-url', options.baseUrl || process.env.AGENTRIX_BASE_URL);
  appendOptionalArg(args, '--api-key', options.apiKey || process.env.AGENTRIX_API_KEY);
  appendOptionalArg(args, '--runner-id', options.runnerId || process.env.AGENTRIX_RUNNER_ID);
  return args;
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
    console.log(JSON.stringify({ dryRun: true, runtime: 'agentrix', action, subject: issue.number, prompt }, null, 2));
    return result;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-agentrix-'));
  const resultFile = path.join(tempDir, 'result.json');
  const provider = resolveProvider(options, data.payload || {});
  const args = buildRunArgs(action, issue, options, data, prompt, resultFile);

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

function buildTaskCommentMarker(action, data = {}) {
  const pr = data.pullRequest || data;
  if (action === 'review' && pr && pr.headSha) {
    return `<!-- issue-flow:agentrix:task:${action}:${pr.headSha} -->`;
  }
  return `<!-- issue-flow:agentrix:task:${action} -->`;
}

function buildTaskComment(action, result, data = {}) {
  const lines = [buildTaskCommentMarker(action, data)];
  if (result.status === 'starting') {
    lines.push(`Agentrix task starting. This comment prevents duplicate issue-flow tasks for the same ${action === 'review' ? 'PR/MR' : 'issue'}/action.`);
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
  } else if (data.pullRequest) {
    lines.push('Trigger: PR/MR review check.');
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
  buildPullRequestPrompt,
  buildRunArgs,
  buildTaskComment,
  buildTaskCommentMarker,
  extractMention,
  extractSourceIssueNumberFromPullRequest,
  findIssuePlanFiles,
  issueDirectoryName,
  normalizeRepoPath,
  resolveAgentrixConfig,
  resolvePlanTemplate,
  run,
  shouldAcknowledgeAutoIssue,
};
