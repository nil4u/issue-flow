/**
 * [INPUT]: 依赖 providers.cjs 的 provider 解析、provenance.cjs 的 source marker 能力
 * [OUTPUT]: 对外提供 Agentrix prompt、agentrix-run package、run/resume args、task comment 的构造与执行函数
 * [POS]: scripts/runtimes 的 Agentrix adapter，把 issue/PR 事件转换为 agentrix-run 可消费的确定性调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveProvider } = require('../providers.cjs');
const { buildSourceMarker, parseSourceMarker } = require('../provenance.cjs');

const DEFAULT_AGENT = 'codex';
const DEFAULT_RESPONSE_MODE = 'async';
const DEFAULT_AGENTRIX_RUN_VERSION = 'latest';
const DEFAULT_MENTION = '@agentrix';
const MENTION_PATTERN = /(^|[^A-Za-z0-9._-])(?:@agentrix|\/agentrix)(?=$|[^A-Za-z0-9._-])/i;
const MENTION_REPLACE_PATTERN = /(^|[^A-Za-z0-9._-])(?:@agentrix|\/agentrix)(?=$|[^A-Za-z0-9._-])/gi;
const DEFAULT_PROJECT_CONFIG_PATH = '.issue-flow/config.json';
const DEFAULT_PROMPTS_DIR = '.issue-flow/prompts';
const DEFAULT_TEMPLATES_DIR = '.issue-flow/templates';
const DEFAULT_PLAN_ROOT_DIR = '.issue-flow/issues';
const TASK_COMMENT_RUN_PATTERN = /^(?:[-*]\s+)?Run:\s*`([^`]+)`\s*$/im;
const REVIEW_COMMENT_TASK_PATTERN = /^(?:[-*]\s+)?Review task:\s*`([^`]+)`\s*$/im;
const REVIEW_COMMENT_HEAD_PATTERN = /^(?:[-*]\s+)?Head:\s*`([^`]+)`\s*$/im;
const PLAN_SUBDIR = 'plan';
const PLAN_BRANCH_SUFFIX = 'plan';
const BUILD_BRANCH_SUFFIX = 'build';
const FEATURE_PLAN_FILE = '001-implementation.md';
const BUG_PLAN_FILE = '001-root-cause-and-fix.md';
const PROMPT_CONTEXT_LABEL_SKIP_PREFIXES = ['status::', 'flow::', 'automation::'];
const AGENTRIX_TASK_MARKER_PATTERN = /<!--\s*issue-flow:agentrix:task=([^>]+?)\s*-->/i;
const PIPELINE_FAILURE_MARKER_PATTERN = /<!--\s*issue-flow:pipeline-failure\b/i;
const PROVIDER_TOKEN_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'GL_TOKEN',
  'GITLAB_PRIVATE_TOKEN',
  'CI_JOB_TOKEN',
  'ISSUE_FLOW_GIT_TOKEN',
];

const PROMPT_FILES = {
  triage: 'triage.prompt.md',
  general: 'general.prompt.md',
  build: 'build.prompt.md',
  buildCiFailure: 'build-ci-failure.prompt.md',
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

function isPipelineFailureIssue(issue) {
  return hasLabel(issue, 'failure::ci') || PIPELINE_FAILURE_MARKER_PATTERN.test(String(issue && issue.body || ''));
}

function promptNameForAction(action, issue) {
  if (action === 'review') {
    return 'review';
  }
  if (action === 'build' && isPipelineFailureIssue(issue)) {
    return 'buildCiFailure';
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
    'PR body: write it to a repo-external temp file (for example `mktemp`) for `issue-flow pr submit ... --body-file`; do not put it in git.',
  ].join('\n');
}

function normalizeBranchName(value) {
  const branch = String(value || '').trim();
  if (!branch || branch === 'null' || branch === 'undefined') {
    return '';
  }
  return branch;
}

function resolvePromptBaseBranch(data = {}, options = {}) {
  const payload = data.payload || {};
  return normalizeBranchName(
    process.env.AGENTRIX_BASE_REF ||
    process.env.GITLAB_BRIDGE_BASE_REF ||
    process.env.GITLAB_BRIDGE_REF_NAME ||
    options.base ||
    data.baseRef ||
    data.pullRequest?.baseRef ||
    payload.pull_request?.base?.ref ||
    payload.object_attributes?.target_branch ||
    payload.project?.default_branch ||
    payload.repository?.default_branch ||
    process.env.CI_DEFAULT_BRANCH ||
    process.env.GITHUB_BASE_REF ||
    process.env.GITLAB_BRIDGE_WORKFLOW_RUN_REF ||
    process.env.AGENTRIX_REF
  );
}

function formatBaseBranchSubmissionRule(data = {}, options = {}) {
  const baseBranch = resolvePromptBaseBranch(data, options);
  if (!baseBranch) {
    return '';
  }
  return [
    `Base branch: \`${baseBranch}\`.`,
    `When publishing with \`issue-flow pr submit\`, the CLI first reads \`AGENTRIX_BASE_REF\` from the Agentrix worker environment. If that env var is absent, pass \`--base ${baseBranch}\` explicitly.`,
  ].join('\n');
}

function formatReviewSubmission(pr) {
  return [
    '## Review Submission',
    '',
    'Write the review body to a repo-external temp file.',
    'If a finding is tied to a specific changed file and line, also write inline review comments to a repo-external JSON file.',
    'The inline comments file must be a JSON array like: `[{"path":"src/file.js","line":12,"body":"Comment"}]`.',
    'Submit exactly once. Use the inline comments file when there are concrete findings; add `--as-comment` when there are no findings.',
    '',
    '```bash',
    `node ${normalizeRepoPath(path.join(skillRootDir(), 'cli.cjs'))} pr review --pr ${pr.number} --body-file <tmp-review-body-file> [--comments-file <tmp-inline-comments-json>] [--as-comment]`,
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
  const blocks = [prompt.body];

  if ((action === 'plan' || action === 'build') && !prompt.body.includes('repo-external temp file')) {
    blocks.push('', formatPrBodyFileRule());
  }
  if (action === 'plan' || action === 'build') {
    const baseBranchRule = formatBaseBranchSubmissionRule(data, options);
    if (baseBranchRule) {
      blocks.push('', baseBranchRule);
    }
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

  blocks.push('', formatRequiredSkill());

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

function extractAgentrixTaskIdFromPullRequest(pr = {}) {
  const match = String(pr.body || '').match(AGENTRIX_TASK_MARKER_PATTERN);
  return match ? match[1].trim() : '';
}

function buildReviewCommentResumeInstruction() {
  return [
    'PR/MR 有新的 review comment，请查看并处理。',
    '',
    '处理完成后，请使用 issue-flow CLI 在 PR/MR 下回复一条普通总结 comment；不要创建新的 inline review comment。',
  ].join('\n');
}

function buildReviewResumeInstruction() {
  return 'PR/MR 有新的提交，请继续 review 最新变更。';
}

function buildPullRequestPrompt(pr, data = {}, options = {}) {
  const prompt = readPrompt('review', pr, options);
  const blocks = [prompt.body, '', formatPullRequestForPrompt(pr), '', formatReviewSubmission(pr)];
  if (data.instruction) {
    blocks.push('', '## Instruction', '', data.instruction);
  }
  blocks.push('', formatRequiredSkill());
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

function buildRepoArg(issue = {}, options = {}) {
  const gitServerId = String(options.gitServerId || process.env.AGENTRIX_GIT_SERVER_ID || '').trim();
  if (!gitServerId) {
    return '';
  }
  const repoFullName = String(issue.repoFullName || options.repo || '').trim();
  const [owner, ...nameParts] = repoFullName.split('/');
  const name = nameParts.join('/');
  return JSON.stringify({
    gitServerId,
    serverRepoId: options.gitlabProject ? String(options.gitlabProject) : undefined,
    owner: owner || undefined,
    name: name || undefined,
  });
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
  appendOptionalArg(args, '--repo', buildRepoArg(issue, options));
  appendOptionalArg(args, '--base-ref', resolvePromptBaseBranch(data, options));
  appendOptionalArg(args, '--runner-id', options.runnerId || process.env.AGENTRIX_RUNNER_ID);
  return args;
}

function buildResumeTaskArgs(taskId, instruction, options = {}, data = {}, resultFile = '') {
  const args = [
    '--yes',
    resolveAgentrixRunPackage(),
    '--resume',
    String(taskId),
    '--prompt',
    instruction,
    '--response-mode',
    resolveResponseMode(options),
    '--result-file',
    resultFile,
  ];
  const pr = data.pullRequest || {};
  if (pr.repoFullName && pr.number) {
    args.push('--metadata', `issue_flow_pr=${pr.repoFullName}#${pr.number}`);
  }
  const reviewComment = data.reviewComment || {};
  if (reviewComment.id) {
    args.push('--metadata', `issue_flow_review_comment=${reviewComment.id}`);
  }
  if (data.sourceIssueNumber && pr.repoFullName) {
    args.push('--metadata', `issue_flow_source_issue=${pr.repoFullName}#${data.sourceIssueNumber}`);
  }

  appendOptionalArg(args, '--base-url', options.baseUrl || process.env.AGENTRIX_BASE_URL);
  appendOptionalArg(args, '--api-key', options.apiKey || process.env.AGENTRIX_API_KEY);
  return args;
}

function buildAgentrixRunEnv(provider, action, env = process.env, data = {}) {
  const childEnv = { ...env };
  for (const key of PROVIDER_TOKEN_ENV_KEYS) {
    delete childEnv[key];
  }
  const taskId = String(data.agentrixTaskId || data.taskId || '').trim();
  if (action === 'task_resume' && taskId) {
    childEnv.AGENTRIX_TASK_ID = taskId;
  }
  const gitServerId = String(data.gitServerId || env.AGENTRIX_GIT_SERVER_ID || '').trim();
  if (gitServerId) {
    childEnv.AGENTRIX_GIT_SERVER_ID = gitServerId;
  }
  childEnv.AGENTRIX_EVENT_NAME =
    env.AGENTRIX_EVENT_NAME ||
    env.GITLAB_BRIDGE_EVENT_NAME ||
    env[provider.envEventName] ||
    env.GITHUB_EVENT_NAME ||
    env.GITLAB_EVENT_NAME ||
    'issue_flow';
  childEnv.AGENTRIX_EVENT_ACTION = env.AGENTRIX_EVENT_ACTION || env.GITLAB_BRIDGE_EVENT_ACTION || action;
  copyBridgeEnv(childEnv, 'AGENTRIX_BASE_REF', ['GITLAB_BRIDGE_BASE_REF', 'GITLAB_BRIDGE_REF_NAME']);
  copyBridgeEnv(childEnv, 'AGENTRIX_HEAD_REF', ['GITLAB_BRIDGE_HEAD_REF']);
  copyBridgeEnv(childEnv, 'AGENTRIX_HEAD_SHA', ['GITLAB_BRIDGE_HEAD_SHA']);
  copyBridgeEnv(childEnv, 'AGENTRIX_PR_NUMBER', ['GITLAB_BRIDGE_PR_NUMBER']);
  copyBridgeEnv(childEnv, 'AGENTRIX_ISSUE_NUMBER', ['GITLAB_BRIDGE_ISSUE_NUMBER']);
  copyBridgeEnv(childEnv, 'AGENTRIX_LABELS', ['GITLAB_BRIDGE_LABELS']);
  copyBridgeEnv(childEnv, 'AGENTRIX_LABELS_JSON', ['GITLAB_BRIDGE_LABELS_JSON']);
  copyBridgeEnv(childEnv, 'AGENTRIX_PR_BODY', ['GITLAB_BRIDGE_PR_BODY']);
  copyBridgeEnv(childEnv, 'AGENTRIX_REF', ['GITLAB_BRIDGE_WORKFLOW_RUN_REF', 'GITLAB_BRIDGE_REF_NAME']);
  copyBridgeEnv(childEnv, 'AGENTRIX_SHA', ['GITLAB_BRIDGE_WORKFLOW_RUN_SHA', 'GITLAB_BRIDGE_HEAD_SHA']);
  return childEnv;
}

function copyBridgeEnv(env, target, sources) {
  if (env[target]) {
    return;
  }
  for (const source of sources) {
    if (env[source]) {
      env[target] = env[source];
      return;
    }
  }
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
    env: buildAgentrixRunEnv(provider, action, process.env, {
      gitServerId: options.gitServerId,
    }),
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

function resumeTask(taskId, instruction, options = {}, data = {}) {
  if (options.dryRun) {
    const result = {
      runId: 'dry-run',
      status: 'dry-run',
      detailUrl: '',
      result: '',
      taskId: String(taskId),
    };
    console.log(JSON.stringify({ dryRun: true, runtime: 'agentrix', action: 'task_resume', taskId: String(taskId), prompt: instruction }, null, 2));
    return result;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-agentrix-'));
  const resultFile = path.join(tempDir, 'result.json');
  const provider = resolveProvider(options, data.payload || {});
  const args = buildResumeTaskArgs(taskId, instruction, options, data, resultFile);

  const child = spawnSync('npx', args, {
    stdio: 'inherit',
    env: buildAgentrixRunEnv(provider, 'task_resume', process.env, {
      ...data,
      agentrixTaskId: taskId,
      gitServerId: options.gitServerId,
    }),
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

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
}

function buildReviewCommentResumeKey(reviewComment = {}) {
  const raw = reviewComment.raw || {};
  const reviewId = firstPresent(
    reviewComment.reviewId,
    reviewComment.pullRequestReviewId,
    reviewComment.pull_request_review_id,
    raw.pull_request_review_id,
    raw.reviewId,
    raw.pullRequestReviewId
  );
  if (reviewId) {
    return `review:${reviewId}`;
  }
  return firstPresent(reviewComment.id, reviewComment.htmlUrl, 'unknown');
}

function buildTaskCommentMarker(action, data = {}) {
  if (action === 'task_resume' && data.reviewComment) {
    const key = buildReviewCommentResumeKey(data.reviewComment);
    return `<!-- issue-flow:agentrix:task:resume-review-comment:${String(key).replace(/\s+/g, '-')} -->`;
  }
  return `<!-- issue-flow:agentrix:task:${action} -->`;
}

function buildTaskComment(action, result, data = {}) {
  const pr = data.pullRequest || data;
  const lines = [buildTaskCommentMarker(action, data)];
  const sourceMarker = buildSourceMarker({
    sourceTaskId: result.runId || data.agentrixTaskId,
    sourceAgent: data.sourceAgent || data.agent || DEFAULT_AGENT,
  });
  if (sourceMarker) {
    lines.push(sourceMarker);
  }
  if (action === 'review') {
    if (result.status === 'starting') {
      lines.push('Agentrix review starting. This comment prevents duplicate issue-flow reviews for this PR/MR.');
    } else if (result.detailUrl) {
      lines.push(`Agentrix review queued: [open task](${result.detailUrl}).`);
    } else {
      lines.push('Agentrix review queued.');
    }
    lines.push('');
    if (result.runId) {
      lines.push(`- Review task: \`${result.runId}\``);
    }
    const buildTaskId = data.agentrixTaskId || extractAgentrixTaskIdFromPullRequest(pr);
    if (buildTaskId) {
      lines.push(`- Build task: \`${buildTaskId}\``);
    }
    if (pr && pr.headSha) {
      lines.push(`- Head: \`${pr.headSha}\``);
    }
    return lines.join('\n');
  }

  if (result.status === 'starting') {
    if (action === 'task_resume') {
      lines.push('Agentrix task resume starting. This comment prevents duplicate issue-flow resumes for the same PR/MR review comment.');
    } else {
      lines.push(`Agentrix task starting. This comment prevents duplicate issue-flow tasks for the same ${action === 'review' ? 'PR/MR' : 'issue'}/action.`);
    }
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
  if (action === 'review' && pr && pr.headSha) {
    lines.push(`Head: \`${pr.headSha}\``);
  }
  if (data.comment && data.comment.htmlUrl) {
    lines.push(`Trigger: ${data.comment.htmlUrl}`);
  } else if (data.reviewComment && data.reviewComment.htmlUrl) {
    lines.push(`Trigger: ${data.reviewComment.htmlUrl}`);
  } else if (data.pullRequest) {
    lines.push('Trigger: PR/MR review check.');
  } else if (data.auto) {
    lines.push('Trigger: automatic issue-flow.');
  }
  if (data.reviewComment && data.reviewComment.id) {
    lines.push(`Review comment: \`${data.reviewComment.id}\``);
  }
  if (data.reviewComment && data.reviewComment.reviewId) {
    lines.push(`Review batch: \`${data.reviewComment.reviewId}\``);
  }
  if (data.agentrixTaskId) {
    lines.push(`Agentrix task: \`${data.agentrixTaskId}\``);
  }
  return lines.join('\n');
}

function extractRunIdFromTaskComment(comment) {
  const body = typeof comment === 'string' ? comment : (comment && comment.body) || '';
  const match = body.match(TASK_COMMENT_RUN_PATTERN);
  if (match) {
    return match[1].trim();
  }
  const reviewTaskMatch = body.match(REVIEW_COMMENT_TASK_PATTERN);
  return reviewTaskMatch ? reviewTaskMatch[1].trim() : '';
}

function extractReviewHeadShaFromTaskComment(comment) {
  const body = typeof comment === 'string' ? comment : (comment && comment.body) || '';
  const headMatch = body.match(REVIEW_COMMENT_HEAD_PATTERN);
  return headMatch ? headMatch[1].trim() : '';
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
  buildResumeTaskArgs,
  buildRunArgs,
  buildAgentrixRunEnv,
  buildReviewCommentResumeInstruction,
  buildReviewResumeInstruction,
  buildReviewCommentResumeKey,
  buildTaskComment,
  buildTaskCommentMarker,
  extractAgentrixTaskIdFromPullRequest,
  parseSourceMarker,
  extractMention,
  extractReviewHeadShaFromTaskComment,
  extractRunIdFromTaskComment,
  extractSourceIssueNumberFromPullRequest,
  findIssuePlanFiles,
  formatBaseBranchSubmissionRule,
  issueDirectoryName,
  normalizeRepoPath,
  resolveAgentrixConfig,
  resolvePlanTemplate,
  resolvePromptBaseBranch,
  run,
  resumeTask,
  shouldAcknowledgeAutoIssue,
};
