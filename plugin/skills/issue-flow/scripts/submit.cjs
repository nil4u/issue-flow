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
const LEGACY_AGENTRIX_TASK_MARKER_PATTERN = /<!--\s*issue-flow:agentrix:task=([^>]+?)\s*-->\s*/i;
const SOURCE_PROVENANCE_MARKER_PATTERN = /<!--\s*issue-flow:source\s+[^>]*-->\s*/i;
const VISUAL_ARTIFACT_TYPES = new Set(['decision', 'plan']);
const VISUAL_PLAN_FEATURE_ON = 'feature:visual-plan:on';
const VISUAL_PLAN_FEATURE_OFF = 'feature:visual-plan:off';
const PLAN_ARTIFACT_FORMATS = new Set(['json', 'markdown']);
const VISUAL_SECTION_TYPES = new Set([
  'summary', 'solution-summary', 'architecture', 'dependency-graph', 'deployment',
  'runtime-flow', 'sequence', 'state-machine', 'data-flow', 'swimlane', 'user-journey',
  'tree', 'component-tree', 'erd', 'matrix', 'path-matrix', 'permission-matrix',
  'compatibility-matrix', 'option-comparison', 'risk-control', 'validation-matrix',
  'traceability', 'responsibility-matrix', 'state-action', 'failure-handling',
  'timeline', 'implementation-steps', 'implementation-dag', 'rollout', 'screen-flow',
  'wireframe', 'chart', 'change-set', 'contract', 'risk-register', 'validation',
  'evidence', 'cards', 'diagram',
]);
const VISUAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;
const VISUAL_CHART_VARIANTS = new Set(['bar', 'horizontal-bar', 'column', 'line', 'area', 'donut', 'pie']);

function usage() {
  return [
    'Usage: submit.cjs <kind> --issue-number <number> --title <title> --body-file <path> [options]',
    '',
    'Kinds:',
    '  plan    Submit a Decision or Plan PR/MR for Engine review',
    '  build   Publish a build PR/MR and move the issue to flow::approve',
    '',
    'Options:',
    '  --issue-number <num>    Source issue number.',
    '  --title <title>         PR title. #<issue-number> is prepended when missing.',
    '  --body-file <path>      Markdown Plan or Build PR/MR body file.',
    '  --artifact <type>       Visual mode artifact: decision or plan.',
    '  --artifact-path <path>  Artifact entry file. Auto-detected when omitted.',
    '  --repo-id <id>          Issue Flow repository id.',
    '  --git-server-id <id>    Issue Flow Git server id used in the visual URL.',
    '  --project-id <id>       Provider repository/project id used in the visual URL.',
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

function readIssueFlowProjectConfig() {
  const configPath = path.resolve(process.cwd(), '.issue-flow/config.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function resolveIssueFlowRepositoryId(options = {}) {
  const config = readIssueFlowProjectConfig();
  const visualPlan = config.visionPlan || config.visualPlan || {};
  const repositoryId = String(
    options.repoId
    || process.env.ISSUE_FLOW_REPOSITORY_ID
    || process.env.ISSUE_FLOW_REPO_ID
    || visualPlan.repositoryId
    || visualPlan.repoId
    || ''
  ).trim();
  if (!repositoryId) {
    throw new Error('Issue Flow repository id is required. Set ISSUE_FLOW_REPOSITORY_ID, pass --repo-id, or configure visionPlan.repositoryId in .issue-flow/config.json.');
  }
  return repositoryId;
}

function resolveIssueFlowBaseUrl() {
  const config = readIssueFlowProjectConfig();
  const visualPlan = config.visionPlan || config.visualPlan || {};
  const baseUrl = String(process.env.ISSUE_FLOW_BASE_URL || visualPlan.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('ISSUE_FLOW_BASE_URL is required to publish a visual decision or plan. It may also be configured as visionPlan.baseUrl in .issue-flow/config.json.');
  return baseUrl;
}

function resolveVisualRouteRepository(options = {}, repo = {}) {
  const config = readIssueFlowProjectConfig();
  const visualPlan = config.visionPlan || config.visualPlan || {};
  const gitServerId = String(
    options.gitServerId
    || process.env.ISSUE_FLOW_GIT_SERVER_ID
    || visualPlan.gitServerId
    || ''
  ).trim();
  const projectId = String(
    options.projectId
    || process.env.ISSUE_FLOW_PROJECT_ID
    || process.env.CI_PROJECT_ID
    || process.env.GITHUB_REPOSITORY_ID
    || visualPlan.projectId
    || repo.projectId
    || ''
  ).trim();
  if (!gitServerId) {
    throw new Error('Issue Flow Git server id is required. Set ISSUE_FLOW_GIT_SERVER_ID, pass --git-server-id, or configure visionPlan.gitServerId in .issue-flow/config.json.');
  }
  if (!projectId) {
    throw new Error('Provider project id is required. Set ISSUE_FLOW_PROJECT_ID, pass --project-id, or configure visionPlan.projectId in .issue-flow/config.json.');
  }
  return { gitServerId, projectId };
}

function resolveVisualArtifactType(options = {}) {
  const artifact = String(options.artifact || 'plan').trim().toLowerCase();
  if (!VISUAL_ARTIFACT_TYPES.has(artifact)) throw new Error('--artifact must be decision or plan');
  return artifact;
}

function resolveVisualPlanFeatureMode(issue = {}) {
  const labels = normalizeLabels(issue.labels || []).filter((label) => label === VISUAL_PLAN_FEATURE_ON || label === VISUAL_PLAN_FEATURE_OFF);
  if (labels.length > 1) {
    throw new Error(`Source issue has conflicting Visual Plan feature labels: ${labels.join(', ')}`);
  }
  return labels[0] === VISUAL_PLAN_FEATURE_ON ? 'on' : 'off';
}

function findVisualIssueDirectory(issueNumber) {
  const root = path.resolve(process.cwd(), '.issue-flow/issues');
  if (!fs.existsSync(root)) return '';
  const issueDir = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${issueNumber}-`))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  return issueDir ? path.join(root, issueDir) : '';
}

function findIssueArtifactPath(issueNumber, artifact, options = {}) {
  if (options.artifactPath) {
    const explicitPath = path.resolve(process.cwd(), options.artifactPath);
    if (!fs.existsSync(explicitPath)) throw new Error(`Visual artifact does not exist: ${options.artifactPath}`);
    return path.relative(process.cwd(), explicitPath).replace(/\\/g, '/');
  }
  const issueRoot = findVisualIssueDirectory(issueNumber);
  if (!issueRoot) throw new Error(`No visual artifact directory found for issue #${issueNumber}`);
  const issueDir = path.basename(issueRoot);
  const relativePath = artifact === 'decision'
    ? path.join('.issue-flow', 'issues', issueDir, 'decision', 'data', 'decision-data.json')
    : path.join('.issue-flow', 'issues', issueDir, 'plan', 'data', 'plan-data.json');
  if (!fs.existsSync(path.resolve(process.cwd(), relativePath))) throw new Error(`Visual ${artifact} artifact does not exist: ${relativePath}`);
  return relativePath.replace(/\\/g, '/');
}

function assertDecisionArtifactsRemoved(issueNumber) {
  const issueRoot = findVisualIssueDirectory(issueNumber);
  if (!issueRoot) return;
  const decisionPaths = [path.join(issueRoot, 'decision')]
    .filter((candidate) => fs.existsSync(candidate));
  if (!decisionPaths.length) return;
  const relativePaths = decisionPaths.map((candidate) => path.relative(process.cwd(), candidate).replace(/\\/g, '/'));
  throw new Error([
    `Visual Plan cannot be published while Decision artifacts remain: ${relativePaths.join(', ')}.`,
    'Delete the completed Decision artifacts, commit the deletion with the Plan, then publish again.',
  ].join(' '));
}

function assertVisualBriefNotInIssueArtifacts(issueNumber) {
  const issueRoot = findVisualIssueDirectory(issueNumber);
  if (!issueRoot) return;
  const pendingDirectories = [issueRoot];
  const briefPaths = [];
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pendingDirectories.push(candidate);
      else if (entry.isFile() && entry.name === 'visual-brief.md') briefPaths.push(candidate);
    }
  }
  if (!briefPaths.length) return;
  const relativePaths = briefPaths.map((candidate) => path.relative(process.cwd(), candidate).replace(/\\/g, '/'));
  throw new Error([
    `Visual Plan cannot publish temporary visual briefs from the repository: ${relativePaths.join(', ')}.`,
    'Delete them and use the system temporary path injected in the Plan prompt.',
  ].join(' '));
}

function assertVisualArtifactData(artifactPath, artifact) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), artifactPath), 'utf8'));
  } catch (error) {
    throw new Error(`Visual ${artifact} artifact must be valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Visual ${artifact} artifact must contain a JSON object`);
  if (data.schemaVersion !== 1) throw new Error(`Visual ${artifact} artifact schemaVersion must be 1`);
  if (data.artifact !== artifact) throw new Error(`Visual ${artifact} artifact field must equal "${artifact}"`);
  if (!data.meta || typeof data.meta !== 'object' || !String(data.meta.title || '').trim()) throw new Error(`Visual ${artifact} artifact must contain meta.title`);
  const forbidden = [];
  const invalidIds = [];
  const visit = (value, location = '') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((entry, index) => visit(entry, `${location}[${index}]`));
    for (const [key, entry] of Object.entries(value)) {
      const next = location ? `${location}.${key}` : key;
      if (['html', 'css', 'js', 'script', 'style'].includes(key.toLowerCase())) forbidden.push(next);
      if (key === 'id' && (!String(entry || '').trim() || !VISUAL_ID_PATTERN.test(String(entry).trim()))) invalidIds.push(next);
      visit(entry, next);
    }
  };
  visit(data);
  if (forbidden.length) throw new Error(`Visual ${artifact} JSON cannot contain presentation code fields: ${forbidden.join(', ')}`);
  if (invalidIds.length) throw new Error(`Visual ${artifact} JSON contains invalid path-safe ids: ${invalidIds.join(', ')}`);
  const collectIds = (items, location) => {
    const ids = new Set();
    for (const [index, item] of items.entries()) {
      const id = String(item && item.id || '').trim();
      if (!id) throw new Error(`${location}[${index}] must have an id`);
      if (!VISUAL_ID_PATTERN.test(id)) throw new Error(`${location}[${index}] has an invalid id: ${id}`);
      if (ids.has(id)) throw new Error(`${location} contains duplicate id: ${id}`);
      ids.add(id);
    }
    return ids;
  };
  if (artifact === 'decision') {
    if (!Array.isArray(data.decisions) || !data.decisions.length) throw new Error('Decision JSON must contain at least one decisions[] item');
    collectIds(data.decisions, 'decisions');
    for (const [index, decision] of data.decisions.entries()) {
      const id = String(decision && decision.id || '').trim();
      if (!String(decision.question || decision.title || '').trim()) throw new Error(`Decision ${id} must contain a question`);
      const options = Array.isArray(decision.options) ? decision.options : [];
      if (decision.type === 'choice' && options.length < 2) throw new Error(`Decision ${id} choice must contain at least two options`);
      if (decision.type === 'choice') {
        const optionIds = collectIds(options, `decisions.${id}.options`);
        const recommended = String(decision.recommendedOptionId || decision.recommended || '').trim();
        if (!recommended) throw new Error(`Decision ${id} choice must contain recommendedOptionId`);
        if (!optionIds.has(recommended)) throw new Error(`Decision ${id} recommendedOptionId does not match an option: ${recommended}`);
      }
    }
    return data;
  }
  if (!Array.isArray(data.sections) || !data.sections.length) throw new Error('Plan JSON must contain at least one sections[] item');
  if (!data.core || typeof data.core !== 'object' || Array.isArray(data.core)) throw new Error('Plan JSON must contain a core object');
  if (!String(data.core.outcome || data.core.goal || data.core.summary || '').trim()) throw new Error('Plan core must describe the outcome');
  collectIds(data.sections, 'sections');
  let hasSummary = false;
  let hasValidation = false;
  for (const [index, section] of data.sections.entries()) {
    const id = String(section && section.id || '').trim();
    const type = String(section && section.type || '').trim();
    if (!VISUAL_SECTION_TYPES.has(type)) throw new Error(`Plan section ${id} uses unsupported type: ${type || '(empty)'}`);
    if (type === 'summary' || type === 'solution-summary') hasSummary = true;
    if (type === 'validation' || type === 'validation-matrix') hasValidation = true;
    const graph = ['architecture', 'dependency-graph', 'deployment', 'runtime-flow', 'state-machine', 'data-flow', 'rollout', 'screen-flow', 'component-tree', 'implementation-dag'].includes(type)
      || type === 'diagram' && String(section.variant || '').trim() !== 'sequence';
    if (graph) {
      const nodes = section.nodes || section.elements || section.states || section.screens || section.tasks || [];
      const edges = section.edges || section.relationships || section.transitions || section.connections || [];
      if (!Array.isArray(nodes) || !nodes.length) throw new Error(`Graph section ${id} must contain nodes`);
      const nodeIds = collectIds(nodes, `sections.${id}.nodes`);
      if (!Array.isArray(edges)) throw new Error(`Graph section ${id} edges must be an array`);
      for (const [edgeIndex, edge] of edges.entries()) {
        const source = String(edge && (edge.sourceId || edge.from || edge.source) || '').trim();
        const target = String(edge && (edge.destinationId || edge.to || edge.target) || '').trim();
        if (!source || !nodeIds.has(source)) throw new Error(`sections.${id}.edges[${edgeIndex}] has unknown source: ${source || '(empty)'}`);
        if (!target || !nodeIds.has(target)) throw new Error(`sections.${id}.edges[${edgeIndex}] has unknown target: ${target || '(empty)'}`);
      }
      collectIds(edges, `sections.${id}.edges`);
    }
    const sequence = type === 'sequence' || type === 'diagram' && String(section.variant || '').trim() === 'sequence';
    if (sequence) {
      const participants = Array.isArray(section.participants || section.actors) ? section.participants || section.actors : [];
      const messages = Array.isArray(section.messages || section.steps) ? section.messages || section.steps : [];
      if (participants.length < 2) throw new Error(`Sequence section ${id} must contain at least two participants`);
      if (!messages.length) throw new Error(`Sequence section ${id} must contain messages`);
      const participantIds = collectIds(participants, `sections.${id}.participants`);
      collectIds(messages, `sections.${id}.messages`);
      for (const [messageIndex, message] of messages.entries()) {
        const source = String(message && (message.sourceId || message.from || message.source) || '').trim();
        const target = String(message && (message.destinationId || message.to || message.target) || '').trim();
        if (!participantIds.has(source)) throw new Error(`sections.${id}.messages[${messageIndex}] has unknown source: ${source || '(empty)'}`);
        if (!participantIds.has(target)) throw new Error(`sections.${id}.messages[${messageIndex}] has unknown target: ${target || '(empty)'}`);
      }
    }
    if (type === 'chart') {
      const variant = String(section.variant || 'bar').trim();
      if (!VISUAL_CHART_VARIANTS.has(variant)) throw new Error(`Chart section ${id} uses unsupported variant: ${variant}`);
      if (!Array.isArray(section.items) || !section.items.length) throw new Error(`Chart section ${id} must contain items`);
      collectIds(section.items, `sections.${id}.items`);
      for (const [itemIndex, item] of section.items.entries()) {
        if (!Number.isFinite(Number(item && item.value))) throw new Error(`sections.${id}.items[${itemIndex}] must contain a numeric value`);
      }
    }
  }
  if (!hasSummary) throw new Error('Plan JSON must include a summary or solution-summary section');
  if (!hasValidation) throw new Error('Plan JSON must include a validation or validation-matrix section');
  return data;
}

function findMarkdownPlanPath(issueNumber, options = {}) {
  if (options.artifactPath) {
    const explicitPath = path.resolve(process.cwd(), options.artifactPath);
    if (!fs.existsSync(explicitPath)) throw new Error(`Markdown Plan does not exist: ${options.artifactPath}`);
    return path.relative(process.cwd(), explicitPath).replace(/\\/g, '/');
  }
  const root = path.resolve(process.cwd(), '.issue-flow/issues');
  if (!fs.existsSync(root)) throw new Error('.issue-flow/issues does not exist');
  const issueDirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${issueNumber}-`))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const issueDir of issueDirs) {
    const planDir = path.join(root, issueDir, 'plan');
    if (!fs.existsSync(planDir)) continue;
    const planFile = fs.readdirSync(planDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name)
      .sort()[0];
    if (planFile) return path.join('.issue-flow', 'issues', issueDir, 'plan', planFile).replace(/\\/g, '/');
  }
  throw new Error(`No Markdown Plan file found for issue #${issueNumber}`);
}

function visualArtifactUrl(baseUrl, gitServerId, projectId, issueNumber, artifact) {
  return `${baseUrl}/repos/${encodeURIComponent(gitServerId)}/${encodeURIComponent(projectId)}/plan/${issueNumber}/${artifact}`;
}

function buildVisualArtifactMarker(input = {}) {
  const format = String(input.format || 'json').trim().toLowerCase();
  if (!PLAN_ARTIFACT_FORMATS.has(format)) throw new Error(`Unsupported Plan artifact format: ${format}`);
  return `<!-- issue-flow:plan-artifact artifact=${input.artifact} format=${format} repo=${input.repositoryId} issue=${input.issueNumber} branch=${input.branch} commit=${input.commit} path=${input.artifactPath} -->`;
}

function buildVisualArtifactComment(input = {}) {
  const title = input.artifact === 'decision' ? 'Decision' : input.format === 'markdown' ? 'Markdown Plan' : 'Visual Plan';
  return [
    buildVisualArtifactMarker(input),
    `## ${title}`,
    '',
    `[Open ${title}](${input.url})`,
    '',
    `- Branch: \`${input.branch}\``,
    `- Commit: \`${input.commit}\``,
    `- Artifact: \`${input.artifactPath}\``,
    `- Format: \`${input.format || 'json'}\``,
    '',
    'Review this artifact in Issue Flow. Review comments and approval are recorded on this PR/MR.',
  ].join('\n');
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
    throw new Error('Working tree has uncommitted changes. Commit the current work before publishing.');
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

function resolveAgentrixTaskId(options = {}) {
  return String(options.agentrixTaskId || process.env.AGENTRIX_TASK_ID || '').trim();
}

function buildPrBodyWithMarkers(body, issueNumber, taskId = '') {
  const sourceMarker = buildSourceIssueMarker(issueNumber);
  const sourceTaskId = String(taskId || process.env.AGENTRIX_TASK_ID || '').trim();
  const provenanceMarker = buildSourceMarker({
    sourceTaskId,
    sourceRuntime: sourceTaskId ? 'agentrix' : '',
  });
  const content = String(body || '').replace(LEGACY_AGENTRIX_TASK_MARKER_PATTERN, '').trimStart();
  let marked = SOURCE_ISSUE_MARKER_PATTERN.test(content)
    ? content.replace(SOURCE_ISSUE_MARKER_PATTERN, sourceMarker)
    : `${sourceMarker}\n${content}`;

  if (provenanceMarker) {
    if (SOURCE_PROVENANCE_MARKER_PATTERN.test(marked)) {
      marked = marked.replace(SOURCE_PROVENANCE_MARKER_PATTERN, `${provenanceMarker}\n`);
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
  return writePrBodyTextWithMarkers(body, issueNumber, taskId);
}

function writePrBodyTextWithMarkers(body, issueNumber, taskId = '') {
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
    return env.ISSUE_FLOW_GITLAB_TOKEN || env.GITLAB_TOKEN || env.GL_TOKEN || env.GITLAB_PRIVATE_TOKEN || env.CI_JOB_TOKEN || '';
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

function applyIssueFlow(provider, repo, issueNumber, flow, options, desired = {}) {
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
  for (const [key, value] of Object.entries(desired)) {
    if (value) args.push(`--${key}`, value);
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }

  runChecked('node', args, {
    dryRun: false,
    inherit: true,
  });
}

function planSubmissionIssueState(artifact) {
  return artifact === 'decision'
    ? { flow: 'flow::clarify', desired: {} }
    : { flow: 'flow::approve', desired: { plan: 'plan::pending' } };
}

async function publishPlanMergeRequest({ provider, repo, issueNumber, headBranch, baseBranch, sourceIssue, visualPlanMode, options }) {
  const visual = visualPlanMode === 'on';
  const artifact = visual ? resolveVisualArtifactType(options) : 'plan';
  const format = visual ? 'json' : 'markdown';
  const repositoryId = resolveIssueFlowRepositoryId(options);
  const routeRepository = resolveVisualRouteRepository(options, repo);
  const baseUrl = resolveIssueFlowBaseUrl();
  if (visual) {
    assertVisualBriefNotInIssueArtifacts(issueNumber);
  }
  if (visual && artifact === 'plan') {
    assertDecisionArtifactsRemoved(issueNumber);
  }
  const artifactPath = visual
    ? findIssueArtifactPath(issueNumber, artifact, options)
    : findMarkdownPlanPath(issueNumber, options);
  if (visual) assertVisualArtifactData(artifactPath, artifact);
  if (!isGitTrackedFile(artifactPath) && !options.dryRun) {
    throw new Error(`Plan artifact must be committed before publishing: ${artifactPath}`);
  }
  if (!visual) {
    validateBodyFile(options.bodyFile);
    assertBodyFileNotTracked(options.bodyFile);
  }
  const label = SUBMIT_KINDS.plan.label;
  await ensureMergeRequestLabel(provider, repo, label, options);
  pushCurrentBranch(headBranch, options);
  const commit = runOutput('git', ['rev-parse', 'HEAD']);
  const url = visualArtifactUrl(baseUrl, routeRepository.gitServerId, routeRepository.projectId, issueNumber, artifact);
  const artifactInput = { artifact, format, repositoryId, issueNumber, branch: headBranch, commit, artifactPath, url };
  const artifactBody = buildVisualArtifactComment(artifactInput);
  const suppliedBody = visual ? '' : fs.readFileSync(options.bodyFile, 'utf8').trim();
  const markedBody = writePrBodyTextWithMarkers(
    [artifactBody, suppliedBody].filter(Boolean).join('\n\n'),
    issueNumber,
    resolveAgentrixTaskId(options),
  );
  const titleConfig = artifact === 'decision'
    ? { ...SUBMIT_KINDS.plan, titlePrefix: 'Decision' }
    : SUBMIT_KINDS.plan;
  let prUrl;
  try {
    prUrl = await createOrUpdatePullRequest({
      provider,
      repo,
      title: normalizePrTitle(titleConfig, issueNumber, options.title),
      bodyFile: markedBody.path,
      label,
      baseBranch,
      headBranch,
      draft: options.draft,
      options,
    });
  } finally {
    markedBody.cleanup();
  }
  const publicationState = planSubmissionIssueState(artifact);
  applyIssueFlow(provider, repo, issueNumber, publicationState.flow, options, publicationState.desired);
  const result = {
    kind: 'plan', artifact, format, provider: provider.name, issueNumber, repositoryId,
    ...routeRepository, branch: headBranch, commit, artifactPath, url, prUrl,
    issueFlow: publicationState.flow, label,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
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
          reason: 'Source issue must have exactly one size:: label before publishing a plan or submitting a build PR/MR.',
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
      `Source issue #${issueNumber} needs exactly one size:: label before publishing a plan or submitting a build PR/MR.`,
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
  const headBranch = resolveHeadBranch(options);
  const baseBranch = resolveBaseBranch(options);

  assertCleanWorktree(options);
  assertPublishBranch(headBranch, baseBranch, options);
  const sourceIssue = await loadSourceIssueForSubmit(provider, repo, issueNumber, options);
  validateSourceIssueSize(sourceIssue, issueNumber);
  const visualPlanMode = kind === 'plan' ? resolveVisualPlanFeatureMode(sourceIssue) : 'off';
  if (kind === 'plan') {
    if (visualPlanMode === 'off' && options.artifact) {
      throw new Error(`Source issue must have ${VISUAL_PLAN_FEATURE_ON} before publishing a Visual Plan artifact.`);
    }
    await publishPlanMergeRequest({ provider, repo, issueNumber, headBranch, baseBranch, sourceIssue, visualPlanMode, options });
    return 0;
  }

  const label = options.label || kindConfig.label;
  validateLabel(label);
  validateBodyFile(options.bodyFile);
  assertBodyFileNotTracked(options.bodyFile);

  const title = normalizePrTitle(kindConfig, issueNumber, options.title);
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
  assertDecisionArtifactsRemoved,
  assertVisualArtifactData,
  assertVisualBriefNotInIssueArtifacts,
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
  planSubmissionIssueState,
  parseArgs,
  buildVisualArtifactComment,
  buildVisualArtifactMarker,
  findIssueArtifactPath,
  findMarkdownPlanPath,
  resolveIssueFlowBaseUrl,
  resolveIssueFlowRepositoryId,
  resolveVisualRouteRepository,
  resolveVisualArtifactType,
  resolveVisualPlanFeatureMode,
  visualArtifactUrl,
  resolveAgentrixTaskId,
  resolveAgentrixWorkerBaseBranch,
  resolveBaseBranch,
  SUBMIT_KINDS,
  validateSourceIssueSize,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
