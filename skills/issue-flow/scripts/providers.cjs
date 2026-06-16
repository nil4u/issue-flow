const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_PROVIDER = 'github';

function parseJsonText(text) {
  return text ? JSON.parse(text) : undefined;
}

function normalizeProviderName(value) {
  const normalized = String(value || DEFAULT_PROVIDER).trim().toLowerCase();
  if (normalized === 'gh') {
    return 'github';
  }
  if (normalized === 'gl') {
    return 'gitlab';
  }
  if (normalized !== 'github' && normalized !== 'gitlab') {
    throw new Error(`provider must be one of: github, gitlab`);
  }
  return normalized;
}

function detectProvider(options = {}, payload = {}) {
  if (options.provider || process.env.ISSUE_FLOW_PROVIDER) {
    return normalizeProviderName(options.provider || process.env.ISSUE_FLOW_PROVIDER);
  }
  if (process.env.AGENTRIX_PROVIDER) {
    return normalizeProviderName(process.env.AGENTRIX_PROVIDER);
  }
  if (options.gitlabUrl || options.gitlabApiUrl || process.env.GITLAB_BASE_URL || process.env.GITLAB_API_URL) {
    return 'gitlab';
  }
  const repoHint = String(options.repo || options.gitlabProject || process.env.GITLAB_PROJECT_PATH || process.env.CI_PROJECT_PATH || '').toLowerCase();
  if (repoHint.includes('gitlab') || process.env.GITLAB_TOKEN || process.env.GL_TOKEN || process.env.GITLAB_PRIVATE_TOKEN) {
    return 'gitlab';
  }
  if (repoHint.includes('github')) {
    return 'github';
  }
  if (payload.object_kind || payload.project || process.env.GITLAB_CI || process.env.CI_PROJECT_PATH) {
    return 'gitlab';
  }
  const remote = parseGitRemoteUrl(options.repo || process.env.CI_REPOSITORY_URL || getGitOriginUrl());
  if (remote.host && remote.host.includes('github')) {
    return 'github';
  }
  if (remote.host) {
    return 'gitlab';
  }
  return 'github';
}

function resolveProvider(options = {}, payload = {}) {
  const name = detectProvider(options, payload);
  return providers[name];
}

function stripGitRemote(value) {
  return String(value || '')
    .trim()
    .replace(/^ssh:\/\/git@[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/^https?:\/\/[^@/]+@[^/]+\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '');
}

function getGitOriginUrl() {
  const result = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

function parseGitRemoteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return {};
  }

  let match = raw.match(/^git@([^:]+):(.+)$/);
  if (match) {
    return normalizeGitRemoteParts(match[1], match[2]);
  }

  match = raw.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (match) {
    return normalizeGitRemoteParts(match[1], match[2]);
  }

  match = raw.match(/^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (match) {
    return normalizeGitRemoteParts(match[2], match[3], match[1]);
  }

  return {};
}

function normalizeGitRemoteParts(host, remotePath, protocol = 'https') {
  const cleanHost = String(host || '').trim();
  const fullName = String(remotePath || '')
    .replace(/^\/+/, '')
    .replace(/\.git$/, '');
  if (!cleanHost || !fullName) {
    return {};
  }
  return {
    host: cleanHost.toLowerCase(),
    baseUrl: `${protocol}://${cleanHost}`,
    fullName,
  };
}

function parseRepoFullName(value) {
  if (!value) {
    return {};
  }
  const normalized = stripGitRemote(value);
  if (/^\d+$/.test(normalized)) {
    return {
      owner: '',
      repo: normalized,
      fullName: normalized,
      projectId: normalized,
    };
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) {
    return {};
  }
  return {
    owner: parts.slice(0, -1).join('/'),
    repo: parts[parts.length - 1],
    fullName: parts.join('/'),
  };
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

function normalizeGitlabState(state) {
  if (state === 'opened') {
    return 'open';
  }
  return typeof state === 'string' ? state : '';
}

function extractTokenFromRemoteUrl(remoteUrl) {
  if (!remoteUrl) {
    return '';
  }
  const match = String(remoteUrl).match(/^https?:\/\/(?:[^:]+:)?([^@]+)@/);
  if (!match) {
    return '';
  }
  const candidate = match[1];
  if (candidate === 'git' || candidate.length < 8) {
    return '';
  }
  return candidate;
}

function getTokenFromGitRemote() {
  return extractTokenFromRemoteUrl(getGitOriginUrl());
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getTokenFromGitRemote();
}

function githubApiUrl(apiPath) {
  const baseUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  return `${baseUrl}${apiPath}`;
}

async function requestGithub(method, apiPath, body) {
  const token = getGithubToken();
  if (!token) {
    throw new Error('Missing GITHUB_TOKEN or GH_TOKEN for GitHub API access');
  }

  const response = await fetch(githubApiUrl(apiPath), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = parseJsonText(text);
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.message === 'string'
        ? parsed.message
        : `GitHub API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  return parsed;
}

function resolveGithubRepo(payload = {}, options = {}) {
  for (const candidate of [options.repo, process.env.GITHUB_REPOSITORY]) {
    const parsed = parseRepoFullName(candidate);
    if (parsed.owner && parsed.repo) {
      return parsed;
    }
  }

  const repository = payload.repository;
  if (repository && typeof repository.full_name === 'string') {
    const payloadRepo = parseRepoFullName(repository.full_name);
    if (payloadRepo.owner && payloadRepo.repo) {
      return payloadRepo;
    }
  }

  if (repository && repository.owner && typeof repository.owner.login === 'string' && typeof repository.name === 'string') {
    return {
      owner: repository.owner.login,
      repo: repository.name,
      fullName: `${repository.owner.login}/${repository.name}`,
    };
  }

  throw new Error('Unable to resolve GitHub repository. Pass --repo or set GITHUB_REPOSITORY.');
}

function githubIssueApiPath(issue) {
  return `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/${issue.number}`;
}

function githubPullRequestApiPath(pr) {
  return `/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
}

function githubIssueCommentApiPath(issue, comment) {
  return `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/comments/${comment.id}`;
}

function githubIssueReactionApiPath(issue) {
  return `${githubIssueApiPath(issue)}/reactions`;
}

function buildGithubIssueContext(payload = {}, options = {}) {
  const repo = resolveGithubRepo(payload, options);
  const issue = payload.issue || {};
  const number = options.issueNumber
    ? parsePositiveInteger(options.issueNumber, '--issue-number')
    : parsePositiveInteger(issue.number, 'payload.issue.number');

  return {
    provider: 'github',
    owner: repo.owner,
    repo: repo.repo,
    repoFullName: repo.fullName,
    number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.body === 'string' ? issue.body : '',
    htmlUrl: typeof issue.html_url === 'string' ? issue.html_url : '',
    state: typeof issue.state === 'string' ? issue.state : '',
    author: issue.user && typeof issue.user.login === 'string' ? issue.user.login : '',
    labels: normalizeLabels(issue.labels),
  };
}

function normalizeGithubPullRequest(pr, repo, fallback = {}) {
  return {
    provider: 'github',
    owner: repo.owner,
    repo: repo.repo,
    repoFullName: repo.fullName,
    number: parsePositiveInteger(pr.number || fallback.number, 'pull request number'),
    title: typeof pr.title === 'string' ? pr.title : fallback.title || '',
    body: typeof pr.body === 'string' ? pr.body : fallback.body || '',
    htmlUrl: typeof pr.html_url === 'string' ? pr.html_url : fallback.htmlUrl || '',
    state: typeof pr.state === 'string' ? pr.state : fallback.state || '',
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    baseRef: pr.base && typeof pr.base.ref === 'string' ? pr.base.ref : fallback.baseRef || '',
    headRef: pr.head && typeof pr.head.ref === 'string' ? pr.head.ref : fallback.headRef || '',
    headSha: pr.head && typeof pr.head.sha === 'string' ? pr.head.sha : fallback.headSha || '',
    labels: normalizeLabels(pr.labels || fallback.labels),
    author: pr.user && typeof pr.user.login === 'string' ? pr.user.login : fallback.author || '',
  };
}

function buildGithubPullRequestContext(payload = {}, options = {}) {
  const repo = resolveGithubRepo(payload, options);
  const pr = payload.pull_request || {};
  const number = options.prNumber
    ? parsePositiveInteger(options.prNumber, '--pr-number')
    : parsePositiveInteger(pr.number, 'payload.pull_request.number');
  return normalizeGithubPullRequest({ ...pr, number }, repo);
}

async function fetchCurrentGithubPullRequest(pr, options = {}) {
  if (options.dryRun) {
    return pr;
  }

  const current = await requestGithub('GET', githubPullRequestApiPath(pr));
  return normalizeGithubPullRequest(current, pr, pr);
}

function getGithubCommentContext(payload = {}) {
  const comment = payload.comment || {};
  return {
    id: comment.id,
    author: comment.user && typeof comment.user.login === 'string' ? comment.user.login : '',
    body: typeof comment.body === 'string' ? comment.body : '',
    htmlUrl: typeof comment.html_url === 'string' ? comment.html_url : '',
  };
}

async function fetchCurrentGithubIssue(issue, options = {}) {
  if (options.dryRun || !getGithubToken()) {
    return issue;
  }

  const current = await requestGithub('GET', githubIssueApiPath(issue));
  return {
    ...issue,
    title: typeof current.title === 'string' ? current.title : issue.title,
    body: typeof current.body === 'string' ? current.body : issue.body,
    htmlUrl: typeof current.html_url === 'string' ? current.html_url : issue.htmlUrl,
    state: typeof current.state === 'string' ? current.state : issue.state,
    author: current.user && typeof current.user.login === 'string' ? current.user.login : issue.author,
    labels: normalizeLabels(current.labels),
  };
}

async function listGithubIssueComments(issue, options = {}) {
  if (options.dryRun) {
    return [];
  }

  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await requestGithub('GET', `${githubIssueApiPath(issue)}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    comments.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return comments;
}

async function createGithubIssueComment(issue, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, commentIssue: issue.number, body }, null, 2));
    return { id: 'dry-run-comment', html_url: '' };
  }

  return requestGithub('POST', `${githubIssueApiPath(issue)}/comments`, { body });
}

async function updateGithubIssueComment(issue, commentId, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, updateComment: commentId, body }, null, 2));
    return;
  }

  await requestGithub(
    'PATCH',
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/comments/${commentId}`,
    { body }
  );
}

async function deleteGithubIssueComment(issue, commentId, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, deleteComment: commentId }, null, 2));
    return;
  }

  await requestGithub(
    'DELETE',
    `/repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}/issues/comments/${commentId}`
  );
}

async function addGithubTriggerCommentReaction(issue, comment, content, options = {}) {
  if (!comment.id) {
    console.warn('Trigger comment has no id; eyes reaction skipped.');
    return;
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, reactionComment: comment.id, content }, null, 2));
    return;
  }

  await requestGithub('POST', `${githubIssueCommentApiPath(issue, comment)}/reactions`, { content });
}

async function addGithubIssueReaction(issue, content, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, reactionIssue: issue.number, content }, null, 2));
    return;
  }

  await requestGithub('POST', githubIssueReactionApiPath(issue), { content });
}

function getGitlabToken(options = {}) {
  return (
    options.gitlabToken ||
    process.env.GITLAB_TOKEN ||
    process.env.GL_TOKEN ||
    process.env.GITLAB_PRIVATE_TOKEN ||
    process.env.CI_JOB_TOKEN ||
    getTokenFromGitRemote()
  );
}

function hasGlab() {
  const result = spawnSync('glab', ['--version'], {
    encoding: 'utf8',
  });
  return !result.error && result.status === 0;
}

function gitlabApiBaseUrl(options = {}) {
  const explicitApiUrl = options.gitlabApiUrl || process.env.GITLAB_API_URL;
  if (explicitApiUrl) {
    return explicitApiUrl.replace(/\/+$/, '');
  }
  const baseUrl =
    options.gitlabUrl ||
    process.env.GITLAB_BASE_URL ||
    process.env.CI_SERVER_URL ||
    gitRemoteBaseUrl(options) ||
    'https://gitlab.com';
  return `${baseUrl.replace(/\/+$/, '')}/api/v4`;
}

function gitRemoteBaseUrl(options = {}) {
  const remote = parseGitRemoteUrl(options.repo || process.env.CI_REPOSITORY_URL || getGitOriginUrl());
  return remote.baseUrl || '';
}

function gitlabHostname(options = {}) {
  const candidate =
    options.gitlabUrl ||
    process.env.GITLAB_BASE_URL ||
    process.env.CI_SERVER_URL ||
    options.gitlabApiUrl ||
    process.env.GITLAB_API_URL ||
    gitRemoteBaseUrl(options);
  if (!candidate) {
    return '';
  }
  try {
    return new URL(candidate).host;
  } catch {
    return '';
  }
}

function gitlabApiBodyArgs(body) {
  if (body === undefined) {
    return [];
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('GitLab glab fallback body must be an object');
  }

  const args = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      args.push('--raw-field', `${key}=${value}`);
      continue;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      args.push('--field', `${key}=${value === null ? 'null' : String(value)}`);
      continue;
    }
    throw new Error(`GitLab glab fallback does not support non-scalar body field: ${key}`);
  }
  return args;
}

function requestGitlabWithGlab(method, apiPath, body, options = {}) {
  const args = ['api', apiPath.replace(/^\//, ''), '--method', method];
  const hostname = gitlabHostname(options);

  if (hostname && hostname !== 'gitlab.com') {
    args.push('--hostname', hostname);
  }

  args.push(...gitlabApiBodyArgs(body));

  const result = spawnSync('glab', args, {
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `glab api exited with status ${result.status ?? 1}`);
  }
  return parseJsonText(result.stdout.trim());
}

async function requestGitlab(method, apiPath, body, options = {}) {
  const token = getGitlabToken(options);
  if (!token) {
    return requestGitlabWithGlab(method, apiPath, body, options);
  }

  const url = new URL(`${gitlabApiBaseUrl(options)}${apiPath}`);
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (process.env.CI_JOB_TOKEN && token === process.env.CI_JOB_TOKEN) {
    headers['JOB-TOKEN'] = token;
  } else {
    headers['PRIVATE-TOKEN'] = token;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (options.noGlabFallback) {
      throw error;
    }
    return requestGitlabWithGlab(method, apiPath, body, options);
  }

  const text = await response.text();
  const parsed = parseJsonText(text);
  if (!response.ok) {
    const message =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.message
        ? typeof parsed.message === 'string'
          ? parsed.message
          : JSON.stringify(parsed.message)
        : `GitLab API HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.response = parsed;
    throw error;
  }

  return parsed;
}

function resolveGitlabRepo(payload = {}, options = {}) {
  for (const candidate of [
    options.repo,
    options.gitlabProject,
    process.env.GITLAB_PROJECT_PATH,
    process.env.CI_PROJECT_PATH,
    process.env.AGENTRIX_REPOSITORY_OWNER && process.env.AGENTRIX_REPOSITORY_NAME
      ? `${process.env.AGENTRIX_REPOSITORY_OWNER}/${process.env.AGENTRIX_REPOSITORY_NAME}`
      : '',
  ]) {
    const parsed = parseRepoFullName(candidate);
    if (parsed.fullName) {
      if (!parsed.projectId && process.env.CI_PROJECT_ID && parsed.fullName === process.env.CI_PROJECT_PATH) {
        parsed.projectId = process.env.CI_PROJECT_ID;
      }
      return parsed;
    }
  }

  const project = payload.project || {};
  const parsedProject = parseRepoFullName(project.path_with_namespace || project.web_url || project.git_http_url);
  if (parsedProject.fullName) {
    if (project.id !== undefined) {
      parsedProject.projectId = String(project.id);
    }
    return parsedProject;
  }

  if (process.env.CI_PROJECT_ID) {
    return {
      owner: '',
      repo: process.env.CI_PROJECT_ID,
      fullName: process.env.CI_PROJECT_PATH || process.env.CI_PROJECT_ID,
      projectId: process.env.CI_PROJECT_ID,
    };
  }

  throw new Error('Unable to resolve GitLab project. Pass --repo, set GITLAB_PROJECT_PATH, or set CI_PROJECT_PATH.');
}

function gitlabProjectRef(issueOrRepo) {
  const project = issueOrRepo.projectId || issueOrRepo.repoFullName || issueOrRepo.fullName;
  return encodeURIComponent(project);
}

function gitlabIssueApiPath(issue) {
  return `/projects/${gitlabProjectRef(issue)}/issues/${encodeURIComponent(issue.number)}`;
}

function gitlabIssueNotesApiPath(issue) {
  return `${gitlabIssueApiPath(issue)}/notes`;
}

function pickGitlabIssuePayload(payload = {}) {
  if (payload.issue) {
    return payload.issue;
  }
  if (payload.object_kind === 'issue') {
    return payload.object_attributes || {};
  }
  return {};
}

function buildGitlabIssueContext(payload = {}, options = {}) {
  const repo = resolveGitlabRepo(payload, options);
  const issue = pickGitlabIssuePayload(payload);
  const number = options.issueNumber
    ? parsePositiveInteger(options.issueNumber, '--issue-number')
    : parsePositiveInteger(issue.iid || issue.number, 'GitLab issue iid');

  return {
    provider: 'gitlab',
    owner: repo.owner,
    repo: repo.repo,
    repoFullName: repo.fullName,
    projectId: repo.projectId,
    number,
    title: typeof issue.title === 'string' ? issue.title : '',
    body: typeof issue.description === 'string' ? issue.description : typeof issue.body === 'string' ? issue.body : '',
    htmlUrl: typeof issue.url === 'string' ? issue.url : typeof issue.web_url === 'string' ? issue.web_url : '',
    state: normalizeGitlabState(issue.state),
    author:
      (issue.author && (issue.author.username || issue.author.name)) ||
      (payload.user && (payload.user.username || payload.user.name)) ||
      '',
    labels: normalizeLabels(issue.labels || payload.labels),
  };
}

function isGitlabMergeRequestOrNonIssue(payload = {}) {
  if (payload.object_kind === 'merge_request') {
    return true;
  }
  if (payload.object_kind === 'note') {
    const noteableType = payload.object_attributes && payload.object_attributes.noteable_type;
    return noteableType !== 'Issue';
  }
  return false;
}

function isGitlabBotComment(payload = {}) {
  const user = payload.user || {};
  return user.bot === true || user.user_type === 'bot';
}

function getGitlabCommentContext(payload = {}) {
  const note = payload.object_attributes || {};
  return {
    id: note.id,
    author: payload.user && (payload.user.username || payload.user.name) ? payload.user.username || payload.user.name : '',
    body: typeof note.note === 'string' ? note.note : '',
    htmlUrl: typeof note.url === 'string' ? note.url : '',
  };
}

async function fetchCurrentGitlabIssue(issue, options = {}) {
  if (options.dryRun || !getGitlabToken(options)) {
    return issue;
  }

  const current = await requestGitlab('GET', gitlabIssueApiPath(issue), undefined, options);
  return {
    ...issue,
    title: typeof current.title === 'string' ? current.title : issue.title,
    body: typeof current.description === 'string' ? current.description : issue.body,
    htmlUrl: typeof current.web_url === 'string' ? current.web_url : issue.htmlUrl,
    state: normalizeGitlabState(current.state),
    author:
      current.author && (current.author.username || current.author.name)
        ? current.author.username || current.author.name
        : issue.author,
    labels: normalizeLabels(current.labels),
  };
}

async function listGitlabIssueComments(issue, options = {}) {
  if (options.dryRun) {
    return [];
  }

  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await requestGitlab(
      'GET',
      `${gitlabIssueNotesApiPath(issue)}?per_page=100&page=${page}`,
      undefined,
      options
    );
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    comments.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return comments;
}

async function createGitlabIssueComment(issue, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, commentIssue: issue.number, body }, null, 2));
    return { id: 'dry-run-comment', web_url: '' };
  }

  return requestGitlab('POST', gitlabIssueNotesApiPath(issue), { body }, options);
}

async function updateGitlabIssueComment(issue, commentId, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, updateComment: commentId, body }, null, 2));
    return;
  }

  await requestGitlab('PUT', `${gitlabIssueNotesApiPath(issue)}/${encodeURIComponent(commentId)}`, { body }, options);
}

async function deleteGitlabIssueComment(issue, commentId, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, deleteComment: commentId }, null, 2));
    return;
  }

  await requestGitlab('DELETE', `${gitlabIssueNotesApiPath(issue)}/${encodeURIComponent(commentId)}`, undefined, options);
}

async function addGitlabTriggerCommentReaction(issue, comment, content, options = {}) {
  if (!comment.id) {
    console.warn('Trigger comment has no id; eyes reaction skipped.');
    return;
  }

  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, reactionComment: comment.id, content }, null, 2));
    return;
  }

  await requestGitlab(
    'POST',
    `${gitlabIssueNotesApiPath(issue)}/${encodeURIComponent(comment.id)}/award_emoji`,
    { name: content },
    options
  );
}

async function addGitlabIssueReaction(issue, content, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, reactionIssue: issue.number, content }, null, 2));
    return;
  }

  await requestGitlab('POST', `${gitlabIssueApiPath(issue)}/award_emoji`, { name: content }, options);
}

function gitlabMergeRequestsApiPath(repo) {
  return `/projects/${gitlabProjectRef(repo)}/merge_requests`;
}

function gitlabMergeRequestApiPath(pr) {
  return `${gitlabMergeRequestsApiPath(pr)}/${encodeURIComponent(pr.number)}`;
}

function gitlabMergeRequestNotesApiPath(pr) {
  return `${gitlabMergeRequestApiPath(pr)}/notes`;
}

function pickGitlabMergeRequestPayload(payload = {}) {
  if (payload.merge_request) {
    return payload.merge_request;
  }
  if (payload.object_kind === 'merge_request') {
    return payload.object_attributes || {};
  }
  return {};
}

function normalizeGitlabPullRequest(pr, repo, fallback = {}) {
  const labels = pr.labels || fallback.labels;
  const state = normalizeGitlabState(pr.state || fallback.state);
  const diffRefs = pr.diff_refs || {};
  const lastCommit = pr.last_commit || {};
  const draft =
    pr.work_in_progress === true ||
    pr.draft === true ||
    /^draft:/i.test(pr.title || fallback.title || '');
  return {
    provider: 'gitlab',
    owner: repo.owner,
    repo: repo.repo,
    repoFullName: repo.fullName,
    projectId: repo.projectId,
    number: parsePositiveInteger(pr.iid || pr.number || fallback.number, 'merge request iid'),
    title: typeof pr.title === 'string' ? pr.title : fallback.title || '',
    body: typeof pr.description === 'string' ? pr.description : typeof pr.body === 'string' ? pr.body : fallback.body || '',
    htmlUrl: typeof pr.web_url === 'string' ? pr.web_url : typeof pr.url === 'string' ? pr.url : fallback.htmlUrl || '',
    state,
    draft,
    merged: state === 'merged' || pr.merged === true || fallback.merged === true,
    baseRef: typeof pr.target_branch === 'string' ? pr.target_branch : fallback.baseRef || '',
    headRef: typeof pr.source_branch === 'string' ? pr.source_branch : fallback.headRef || '',
    headSha: pr.sha || diffRefs.head_sha || lastCommit.id || fallback.headSha || '',
    labels: normalizeLabels(labels),
    author:
      (pr.author && (pr.author.username || pr.author.name)) ||
      (fallback.author || ''),
  };
}

function buildGitlabPullRequestContext(payload = {}, options = {}) {
  const repo = resolveGitlabRepo(payload, options);
  const pr = pickGitlabMergeRequestPayload(payload);
  const number = options.prNumber
    ? parsePositiveInteger(options.prNumber, '--pr-number')
    : parsePositiveInteger(pr.iid || pr.number, 'GitLab merge request iid');
  return normalizeGitlabPullRequest({ ...pr, iid: number }, repo);
}

async function fetchCurrentGitlabPullRequest(pr, options = {}) {
  if (options.dryRun) {
    return pr;
  }

  const current = await requestGitlab('GET', gitlabMergeRequestApiPath(pr), undefined, options);
  return normalizeGitlabPullRequest(current, pr, pr);
}

async function listGitlabPullRequestComments(pr, options = {}) {
  if (options.dryRun) {
    return [];
  }

  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageItems = await requestGitlab(
      'GET',
      `${gitlabMergeRequestNotesApiPath(pr)}?per_page=100&page=${page}`,
      undefined,
      options
    );
    if (!Array.isArray(pageItems) || pageItems.length === 0) {
      break;
    }
    comments.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return comments;
}

async function createGitlabPullRequestComment(pr, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, commentPullRequest: pr.number, body }, null, 2));
    return { id: 'dry-run-comment', web_url: '' };
  }

  return requestGitlab('POST', gitlabMergeRequestNotesApiPath(pr), { body }, options);
}

async function updateGitlabPullRequestComment(pr, commentId, body, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, updateComment: commentId, body }, null, 2));
    return;
  }

  await requestGitlab('PUT', `${gitlabMergeRequestNotesApiPath(pr)}/${encodeURIComponent(commentId)}`, { body }, options);
}

async function deleteGitlabPullRequestComment(pr, commentId, options = {}) {
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, deleteComment: commentId }, null, 2));
    return;
  }

  await requestGitlab('DELETE', `${gitlabMergeRequestNotesApiPath(pr)}/${encodeURIComponent(commentId)}`, undefined, options);
}

function readBodyFile(bodyFile) {
  return fs.readFileSync(bodyFile, 'utf8');
}

async function findExistingGitlabMergeRequest(repo, headBranch, options = {}) {
  if (options.dryRun) {
    return undefined;
  }
  const sourceBranch = encodeURIComponent(String(headBranch || '').trim());
  if (!sourceBranch) {
    return undefined;
  }
  const items = await requestGitlab(
    'GET',
    `${gitlabMergeRequestsApiPath(repo)}?state=opened&source_branch=${sourceBranch}`,
    undefined,
    options
  );
  return Array.isArray(items) ? items[0] : undefined;
}

async function createOrUpdateGitlabMergeRequest({ repo, title, bodyFile, label, baseBranch, headBranch, draft, options }) {
  if (options.dryRun) {
    const url = `${(options.gitlabUrl || process.env.GITLAB_BASE_URL || process.env.CI_SERVER_URL || 'https://gitlab.com').replace(/\/+$/, '')}/${repo.fullName}/-/merge_requests/dry-run`;
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          provider: 'gitlab',
          repo: repo.fullName,
          title,
          baseBranch,
          headBranch,
          label,
          draft: Boolean(draft),
        },
        null,
        2
      )
    );
    return url;
  }

  const existing = await findExistingGitlabMergeRequest(repo, headBranch, options);
  const description = readBodyFile(bodyFile);
  const mrTitle = draft && !/^draft:/i.test(title) ? `Draft: ${title}` : title;
  if (existing && existing.iid) {
    const updated = await requestGitlab(
      'PUT',
      `${gitlabMergeRequestsApiPath(repo)}/${encodeURIComponent(existing.iid)}`,
      {
        title: mrTitle,
        description,
        add_labels: label,
      },
      options
    );
    return updated.web_url || existing.web_url || '';
  }

  const created = await requestGitlab(
    'POST',
    gitlabMergeRequestsApiPath(repo),
    {
      source_branch: headBranch,
      target_branch: baseBranch,
      title: mrTitle,
      description,
      labels: label,
    },
    options
  );
  return created.web_url || '';
}

async function getGitlabIssueForApply(target, options = {}) {
  return requestGitlab('GET', gitlabIssueApiPath(target), undefined, options);
}

async function applyGitlabLabels(target, labelsToAdd, labelsToRemove, options = {}) {
  const body = {};
  if (labelsToAdd.length > 0) {
    body.add_labels = labelsToAdd.join(',');
  }
  if (labelsToRemove.length > 0) {
    body.remove_labels = labelsToRemove.join(',');
  }
  if (Object.keys(body).length > 0) {
    await requestGitlab('PUT', gitlabIssueApiPath(target), body, options);
  }
}

async function updateGitlabIssueBody(target, body, options = {}) {
  await requestGitlab('PUT', gitlabIssueApiPath(target), { description: body }, options);
}

function requestGithubWithGh(method, apiPath, body) {
  const args = ['api', apiPath.replace(/^\//, ''), '-X', method];
  let inputPath = '';

  if (body !== undefined) {
    inputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-gh-')), 'body.json');
    fs.writeFileSync(inputPath, JSON.stringify(body), 'utf8');
    args.push('--input', inputPath);
  }

  try {
    const result = spawnSync('gh', args, {
      encoding: 'utf8',
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `gh api exited with status ${result.status ?? 1}`);
    }
    return parseJsonText(result.stdout.trim());
  } finally {
    if (inputPath) {
      fs.rmSync(path.dirname(inputPath), { recursive: true, force: true });
    }
  }
}

async function requestGithubForApply(method, apiPath, body) {
  if (!getGithubToken()) {
    return requestGithubWithGh(method, apiPath, body);
  }
  return requestGithub(method, apiPath, body);
}

async function getGithubIssueForApply(target) {
  return requestGithubForApply('GET', githubIssueApiPath({ ...target, number: target.issueNumber }));
}

async function applyGithubLabels(target, labelsToAdd, labelsToRemove) {
  const issue = { ...target, number: target.issueNumber };
  for (const label of labelsToRemove) {
    await requestGithubForApply('DELETE', `${githubIssueApiPath(issue)}/labels/${encodeURIComponent(label)}`);
  }

  if (labelsToAdd.length > 0) {
    await requestGithubForApply('POST', `${githubIssueApiPath(issue)}/labels`, { labels: labelsToAdd });
  }
}

async function updateGithubIssueBody(target, body) {
  await requestGithubForApply('PATCH', githubIssueApiPath({ ...target, number: target.issueNumber }), { body });
}

function parsePositiveInteger(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const githubProvider = {
  name: 'github',
  envEventPath: 'GITHUB_EVENT_PATH',
  envEventName: 'GITHUB_EVENT_NAME',
  hasToken: () => Boolean(getGithubToken()),
  resolveRepo: resolveGithubRepo,
  buildIssueContext: buildGithubIssueContext,
  buildPullRequestContext: buildGithubPullRequestContext,
  isPullRequestIssue: (payload) => Boolean(payload.issue && payload.issue.pull_request),
  isBotComment: (payload) => Boolean(payload.comment && payload.comment.user && payload.comment.user.type === 'Bot'),
  getCommentContext: getGithubCommentContext,
  fetchCurrentIssue: fetchCurrentGithubIssue,
  fetchCurrentPullRequest: fetchCurrentGithubPullRequest,
  listIssueComments: listGithubIssueComments,
  createIssueComment: createGithubIssueComment,
  updateIssueComment: updateGithubIssueComment,
  deleteIssueComment: deleteGithubIssueComment,
  listPullRequestComments: listGithubIssueComments,
  createPullRequestComment: createGithubIssueComment,
  updatePullRequestComment: updateGithubIssueComment,
  deletePullRequestComment: deleteGithubIssueComment,
  addTriggerCommentReaction: addGithubTriggerCommentReaction,
  addIssueReaction: addGithubIssueReaction,
  issueApiPath: githubIssueApiPath,
  pullRequestApiPath: githubPullRequestApiPath,
  issueCommentApiPath: githubIssueCommentApiPath,
  issueReactionApiPath: githubIssueReactionApiPath,
  getIssueForApply: getGithubIssueForApply,
  applyLabels: applyGithubLabels,
  updateIssueBody: updateGithubIssueBody,
};

const gitlabProvider = {
  name: 'gitlab',
  envEventPath: 'GITLAB_EVENT_PATH',
  envEventName: 'GITLAB_EVENT_NAME',
  hasToken: (options) => Boolean(getGitlabToken(options)) || hasGlab(),
  resolveRepo: resolveGitlabRepo,
  buildIssueContext: buildGitlabIssueContext,
  buildPullRequestContext: buildGitlabPullRequestContext,
  isPullRequestIssue: isGitlabMergeRequestOrNonIssue,
  isBotComment: isGitlabBotComment,
  getCommentContext: getGitlabCommentContext,
  fetchCurrentIssue: fetchCurrentGitlabIssue,
  fetchCurrentPullRequest: fetchCurrentGitlabPullRequest,
  listIssueComments: listGitlabIssueComments,
  createIssueComment: createGitlabIssueComment,
  updateIssueComment: updateGitlabIssueComment,
  deleteIssueComment: deleteGitlabIssueComment,
  listPullRequestComments: listGitlabPullRequestComments,
  createPullRequestComment: createGitlabPullRequestComment,
  updatePullRequestComment: updateGitlabPullRequestComment,
  deletePullRequestComment: deleteGitlabPullRequestComment,
  addTriggerCommentReaction: addGitlabTriggerCommentReaction,
  addIssueReaction: addGitlabIssueReaction,
  issueApiPath: gitlabIssueApiPath,
  pullRequestApiPath: gitlabMergeRequestApiPath,
  getIssueForApply: getGitlabIssueForApply,
  applyLabels: applyGitlabLabels,
  updateIssueBody: updateGitlabIssueBody,
  createOrUpdateMergeRequest: createOrUpdateGitlabMergeRequest,
};

const providers = {
  github: githubProvider,
  gitlab: gitlabProvider,
};

module.exports = {
  detectProvider,
  extractTokenFromRemoteUrl,
  gitlabApiBodyArgs,
  getGitlabToken,
  gitlabApiBaseUrl,
  gitlabHostname,
  normalizeGitlabState,
  normalizeLabelName,
  normalizeLabels,
  normalizeProviderName,
  parseGitRemoteUrl,
  parseRepoFullName,
  providers,
  requestGitlab,
  resolveProvider,
};
