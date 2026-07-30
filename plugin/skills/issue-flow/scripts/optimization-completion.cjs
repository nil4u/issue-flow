const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OPTIMIZATION_SOURCE_PATTERN = /<!--\s*issue-flow:automation-optimization\s+source-issue=(\d+)\s*-->/i;
const PROPOSAL_PATTERN = /<!--\s*issue-flow:optimization-proposal\s+optimization-issue=(\d+)\s+source-issue=(\d+)\s+proposal=([^\s>]+)(?:\s+action=([^\s>]+))?\s*-->/i;
const ARTIFACT_PATTERN = /<!--\s*issue-flow:plan-artifact\s+artifact=optimization\s+format=json\s+(?:repo=[^\s]+\s+)?issue=(\d+)\s+branch=([^\s]+)\s+commit=([^\s]+)\s+path=([^\s]+)\s*-->/i;

function parseProposalMarker(body = '') {
  const match = String(body).match(PROPOSAL_PATTERN);
  return match ? {
    optimizationIssueNumber: Number.parseInt(match[1], 10),
    sourceIssueNumber: Number.parseInt(match[2], 10),
    proposalId: match[3],
    action: match[4] || 'created',
  } : undefined;
}

function parseArtifactMarker(pullRequest = {}) {
  const match = String(pullRequest.body || '').match(ARTIFACT_PATTERN);
  return match ? {
    issueNumber: Number.parseInt(match[1], 10),
    branch: match[2],
    commit: match[3],
    path: match[4],
  } : undefined;
}

function sourceIssueNumber(body = '') {
  const match = String(body).match(OPTIMIZATION_SOURCE_PATTERN);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function issueBody(issue = {}) {
  return issue.body || issue.description || '';
}

function terminalState(issue = {}) {
  const labels = (Array.isArray(issue.labels) ? issue.labels : [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean);
  if (labels.includes('status::done')) return 'completed';
  if (labels.includes('status::drop')) return 'cancelled';
  return '';
}

function runApply(provider, repo, issueNumber, args, options = {}) {
  const command = [
    path.join(__dirname, 'apply.cjs'),
    '--issue-number', String(issueNumber),
    '--provider', provider.name,
    '--repo', repo.fullName,
    ...args,
  ];
  if (options.dryRun) command.push('--dry-run');
  const result = spawnSync('node', command, { encoding: 'utf8', stdio: options.dryRun ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '').trim() || `apply.cjs exited with status ${result.status ?? 1}`);
}

function proposalStates(data, optimizationIssueNumber, comments, issues) {
  const ignored = new Set(comments.map((comment) => parseProposalMarker(comment.body)).filter((marker) => marker && marker.optimizationIssueNumber === optimizationIssueNumber && marker.action === 'ignored').map((marker) => marker.proposalId));
  const children = new Map();
  for (const issue of issues) {
    const marker = parseProposalMarker(issueBody(issue));
    if (marker && marker.optimizationIssueNumber === optimizationIssueNumber && !children.has(marker.proposalId)) children.set(marker.proposalId, issue);
  }
  return data.proposals.map((proposal) => {
    const child = children.get(proposal.id);
    return {
      id: proposal.id,
      kind: proposal.kind || 'project-change',
      state: child ? terminalState(child) || 'active' : ignored.has(proposal.id) ? 'ignored' : 'pending',
    };
  });
}

function allOptimizationProposalsTerminal(states = []) {
  const executable = states.filter((item) => item.kind !== 'issue-flow-feedback');
  return states.length > 0 && executable.every((item) => ['ignored', 'completed', 'cancelled'].includes(item.state));
}

async function completeOptimizationForChildIssue(provider, repo, childIssueNumber, options = {}) {
  if (!provider.listRepositoryIssues || !provider.listPlanPullRequests || !provider.readRepositoryFile || !provider.closePullRequest || !provider.closeIssue) return { completed: false, reason: 'provider_not_supported' };
  const child = await provider.getIssueForApply({ ...repo, provider: provider.name, issueNumber: childIssueNumber, number: childIssueNumber }, options);
  const relation = parseProposalMarker(issueBody(child));
  if (!relation) return { completed: false, reason: 'not_optimization_proposal' };
  if (!terminalState(child)) return { completed: false, reason: 'proposal_not_terminal' };
  const issues = await provider.listRepositoryIssues(repo, options);
  const optimizationIssue = issues.find((issue) => issue.number === relation.optimizationIssueNumber);
  if (!optimizationIssue) throw new Error(`Optimization issue #${relation.optimizationIssueNumber} was not found`);
  const sourceNumber = sourceIssueNumber(optimizationIssue.body) || relation.sourceIssueNumber;
  const candidates = (await provider.listPlanPullRequests(repo, options)).map((pullRequest) => ({ pullRequest, marker: parseArtifactMarker(pullRequest) }))
    .filter((item) => item.marker && item.marker.issueNumber === relation.optimizationIssueNumber)
    .sort((left, right) => Number(['open', 'opened'].includes(right.pullRequest.state)) - Number(['open', 'opened'].includes(left.pullRequest.state)));
  const selected = candidates[0];
  if (!selected) throw new Error(`Optimization Plan MR for issue #${relation.optimizationIssueNumber} was not found`);
  const data = JSON.parse(await provider.readRepositoryFile(repo, selected.marker.commit, selected.marker.path, options));
  if (!data || data.artifact !== 'optimization' || !Array.isArray(data.proposals)) throw new Error('Optimization Plan artifact is invalid');
  const comments = await provider.listPullRequestComments(selected.pullRequest, options);
  const states = proposalStates(data, relation.optimizationIssueNumber, comments, issues.map((issue) => issue.number === child.number ? child : issue));
  if (!allOptimizationProposalsTerminal(states)) return { completed: false, reason: 'proposals_pending', proposals: states };
  await provider.closePullRequest(selected.pullRequest, options);
  runApply(provider, repo, relation.optimizationIssueNumber, ['--status', 'status::done', '--clear-flow'], options);
  if (!options.dryRun) await provider.closeIssue({ ...optimizationIssue, ...repo, issueNumber: optimizationIssue.number }, options);
  runApply(provider, repo, sourceNumber, ['--optimization-state', 'optimization::analyzed'], options);
  return { completed: true, optimizationIssueNumber: relation.optimizationIssueNumber, sourceIssueNumber: sourceNumber, proposals: states };
}

module.exports = {
  allOptimizationProposalsTerminal,
  completeOptimizationForChildIssue,
  parseArtifactMarker,
  parseProposalMarker,
  proposalStates,
  sourceIssueNumber,
};
