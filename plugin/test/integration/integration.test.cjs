const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const SCRIPTS_DIR = path.join(__dirname, '..', 'skills', 'issue-flow', 'scripts');
const APPLY = path.join(SCRIPTS_DIR, 'apply.cjs');
const INTAKE = path.join(SCRIPTS_DIR, 'intake.cjs');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// --- Config ---

const githubToken = process.env.GITHUB_TOKEN || '';
const githubRepo = process.env.GITHUB_TEST_REPO || '';
const skipGithub = !githubToken || !githubRepo;

const gitlabToken = process.env.GITLAB_TOKEN || '';
const gitlabBaseUrl = process.env.GITLAB_BASE_URL || '';
const gitlabProject = process.env.GITLAB_TEST_PROJECT || '';
const skipGitlab = !gitlabToken || !gitlabBaseUrl || !gitlabProject;

// --- Helpers ---

function run(script, args, env = {}) {
  return execFileSync('node', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

function runJson(script, args, env = {}) {
  const output = run(script, args, env).trim();
  try {
    return JSON.parse(output);
  } catch {}
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

async function githubApi(method, apiPath, body) {
  const baseUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

async function gitlabApi(method, apiPath, body) {
  const baseUrl = `${gitlabBaseUrl.replace(/\/+$/, '')}/api/v4`;
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      'PRIVATE-TOKEN': gitlabToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitLab API ${response.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : undefined;
}

// --- GitHub Integration Tests ---

test('github: apply.cjs --dry-run outputs plan without API call', { skip: skipGithub && 'GITHUB_TOKEN or GITHUB_TEST_REPO not set' }, () => {
  const result = runJson(APPLY, [
    '--issue-number', '1',
    '--flow', 'flow::triage',
    '--dry-run',
    '--repo', githubRepo,
    '--provider', 'github',
  ], { GITHUB_TOKEN: githubToken });

  assert.ok(result);
  assert.equal(result.dryRun, true);
});

test('github: create issue, apply labels, verify, cleanup', { skip: skipGithub && 'GITHUB_TOKEN or GITHUB_TEST_REPO not set' }, async () => {
  const [owner, repo] = githubRepo.split('/');
  const apiBase = `/repos/${owner}/${repo}`;

  const issue = await githubApi('POST', `${apiBase}/issues`, {
    title: `[test] issue-flow integration ${Date.now()}`,
    body: 'Auto-created by integration test. Will be closed.',
  });
  const issueNumber = issue.number;

  try {
    // Apply initial labels
    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--type', 'type::bug',
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--priority', 'priority::p2',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    const labels = updated.labels.map((l) => l.name);
    assert.ok(labels.includes('type::bug'), `Expected type::bug, got: ${labels}`);
    assert.ok(labels.includes('status::active'), `Expected status::active, got: ${labels}`);
    assert.ok(labels.includes('flow::triage'), `Expected flow::triage, got: ${labels}`);
    assert.ok(labels.includes('priority::p2'), `Expected priority::p2, got: ${labels}`);

    // Change flow — should replace flow::triage with flow::plan
    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--flow', 'flow::plan',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated2 = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    const labels2 = updated2.labels.map((l) => l.name);
    assert.ok(labels2.includes('flow::plan'), `Expected flow::plan, got: ${labels2}`);
    assert.ok(!labels2.includes('flow::triage'), `flow::triage should be removed, got: ${labels2}`);
    assert.ok(labels2.includes('type::bug'), `type::bug should remain`);
    assert.ok(labels2.includes('status::active'), `status::active should remain`);

    // --clear-flow + status change
    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--status', 'status::done',
      '--clear-flow',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated3 = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    const labels3 = updated3.labels.map((l) => l.name);
    assert.ok(labels3.includes('status::done'), `Expected status::done, got: ${labels3}`);
    assert.ok(!labels3.includes('status::active'), `status::active should be removed`);
    assert.ok(!labels3.includes('flow::plan'), `flow::plan should be cleared`);
  } finally {
    await githubApi('PATCH', `${apiBase}/issues/${issueNumber}`, { state: 'closed' });
  }
});

test('github: intake adds default labels to bare issue', { skip: skipGithub && 'GITHUB_TOKEN or GITHUB_TEST_REPO not set' }, async () => {
  const { computeIssueIntakeLabels } = require(INTAKE);
  const [owner, repo] = githubRepo.split('/');
  const apiBase = `/repos/${owner}/${repo}`;

  const issue = await githubApi('POST', `${apiBase}/issues`, {
    title: `[test] intake integration ${Date.now()}`,
    body: 'Auto-created by integration test.',
  });
  const issueNumber = issue.number;

  try {
    const labelsToAdd = computeIssueIntakeLabels([]);
    assert.deepEqual(labelsToAdd, ['status::active', 'flow::triage']);

    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    const labels = updated.labels.map((l) => l.name);
    assert.ok(labels.includes('status::active'), `Expected status::active, got: ${labels}`);
    assert.ok(labels.includes('flow::triage'), `Expected flow::triage, got: ${labels}`);
  } finally {
    await githubApi('PATCH', `${apiBase}/issues/${issueNumber}`, { state: 'closed' });
  }
});

test('github: body update works, clarify skips body', { skip: skipGithub && 'GITHUB_TOKEN or GITHUB_TEST_REPO not set' }, async () => {
  const [owner, repo] = githubRepo.split('/');
  const apiBase = `/repos/${owner}/${repo}`;

  const issue = await githubApi('POST', `${apiBase}/issues`, {
    title: `[test] body update ${Date.now()}`,
    body: 'Original body.',
  });
  const issueNumber = issue.number;
  const bodyFile = path.join(__dirname, `_test_body_${issueNumber}.md`);

  try {
    fs.writeFileSync(bodyFile, '## Updated\n\nNormalized body content.');
    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--flow', 'flow::plan',
      '--normalized-body-file', bodyFile,
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    assert.ok(updated.body.includes('Normalized body content'), `Body should be updated`);

    // flow::clarify should NOT overwrite body
    fs.writeFileSync(bodyFile, 'THIS SHOULD NOT APPEAR');
    run(APPLY, [
      '--issue-number', String(issueNumber),
      '--flow', 'flow::clarify',
      '--normalized-body-file', bodyFile,
      '--repo', githubRepo,
      '--provider', 'github',
    ], { GITHUB_TOKEN: githubToken });

    const updated2 = await githubApi('GET', `${apiBase}/issues/${issueNumber}`);
    assert.ok(!updated2.body.includes('THIS SHOULD NOT APPEAR'), `Body should not change on clarify`);
    assert.ok(updated2.body.includes('Normalized body content'), `Original body should remain`);
  } finally {
    await githubApi('PATCH', `${apiBase}/issues/${issueNumber}`, { state: 'closed' });
    try { fs.unlinkSync(bodyFile); } catch {}
  }
});

// --- GitLab Integration Tests ---

test('gitlab: apply.cjs --dry-run outputs plan without API call', { skip: skipGitlab && 'GITLAB_TOKEN, GITLAB_BASE_URL, or GITLAB_TEST_PROJECT not set' }, () => {
  const result = runJson(APPLY, [
    '--issue-number', '1',
    '--flow', 'flow::triage',
    '--dry-run',
    '--repo', gitlabProject,
    '--provider', 'gitlab',
  ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

  assert.ok(result);
  assert.equal(result.dryRun, true);
});

test('gitlab: create issue, apply labels, verify, cleanup', { skip: skipGitlab && 'GITLAB_TOKEN, GITLAB_BASE_URL, or GITLAB_TEST_PROJECT not set' }, async () => {
  const projectRef = encodeURIComponent(gitlabProject);

  const issue = await gitlabApi('POST', `/projects/${projectRef}/issues`, {
    title: `[test] issue-flow integration ${Date.now()}`,
    description: 'Auto-created by integration test. Will be closed.',
  });
  const issueIid = issue.iid;

  try {
    // Apply initial labels
    run(APPLY, [
      '--issue-number', String(issueIid),
      '--type', 'type::feature',
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--priority', 'priority::p1',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    const labels = updated.labels || [];
    assert.ok(labels.includes('type::feature'), `Expected type::feature, got: ${labels}`);
    assert.ok(labels.includes('status::active'), `Expected status::active, got: ${labels}`);
    assert.ok(labels.includes('flow::triage'), `Expected flow::triage, got: ${labels}`);
    assert.ok(labels.includes('priority::p1'), `Expected priority::p1, got: ${labels}`);

    // Change flow
    run(APPLY, [
      '--issue-number', String(issueIid),
      '--flow', 'flow::build',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated2 = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    const labels2 = updated2.labels || [];
    assert.ok(labels2.includes('flow::build'), `Expected flow::build, got: ${labels2}`);
    assert.ok(!labels2.includes('flow::triage'), `flow::triage should be removed`);
    assert.ok(labels2.includes('type::feature'), `type::feature should remain`);

    // Clear flow + set done
    run(APPLY, [
      '--issue-number', String(issueIid),
      '--status', 'status::done',
      '--clear-flow',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated3 = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    const labels3 = updated3.labels || [];
    assert.ok(labels3.includes('status::done'), `Expected status::done, got: ${labels3}`);
    assert.ok(!labels3.includes('status::active'), `status::active should be removed`);
    assert.ok(!labels3.includes('flow::build'), `flow should be cleared`);
  } finally {
    await gitlabApi('PUT', `/projects/${projectRef}/issues/${issueIid}`, { state_event: 'close' });
  }
});

test('gitlab: intake adds default labels to bare issue', { skip: skipGitlab && 'GITLAB_TOKEN, GITLAB_BASE_URL, or GITLAB_TEST_PROJECT not set' }, async () => {
  const { computeIssueIntakeLabels } = require(INTAKE);
  const projectRef = encodeURIComponent(gitlabProject);

  const issue = await gitlabApi('POST', `/projects/${projectRef}/issues`, {
    title: `[test] intake integration ${Date.now()}`,
    description: 'Auto-created by integration test.',
  });
  const issueIid = issue.iid;

  try {
    const labelsToAdd = computeIssueIntakeLabels([]);
    assert.deepEqual(labelsToAdd, ['status::active', 'flow::triage']);

    run(APPLY, [
      '--issue-number', String(issueIid),
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    const labels = updated.labels || [];
    assert.ok(labels.includes('status::active'), `Expected status::active, got: ${labels}`);
    assert.ok(labels.includes('flow::triage'), `Expected flow::triage, got: ${labels}`);
  } finally {
    await gitlabApi('PUT', `/projects/${projectRef}/issues/${issueIid}`, { state_event: 'close' });
  }
});

test('gitlab: body update works, clarify skips body', { skip: skipGitlab && 'GITLAB_TOKEN, GITLAB_BASE_URL, or GITLAB_TEST_PROJECT not set' }, async () => {
  const projectRef = encodeURIComponent(gitlabProject);

  const issue = await gitlabApi('POST', `/projects/${projectRef}/issues`, {
    title: `[test] body update ${Date.now()}`,
    description: 'Original body.',
  });
  const issueIid = issue.iid;
  const bodyFile = path.join(__dirname, `_test_body_gl_${issueIid}.md`);

  try {
    fs.writeFileSync(bodyFile, '## Updated\n\nNormalized body content.');
    run(APPLY, [
      '--issue-number', String(issueIid),
      '--flow', 'flow::plan',
      '--normalized-body-file', bodyFile,
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    assert.ok(updated.description.includes('Normalized body content'), `Body should be updated`);

    // clarify should not overwrite
    fs.writeFileSync(bodyFile, 'THIS SHOULD NOT APPEAR');
    run(APPLY, [
      '--issue-number', String(issueIid),
      '--flow', 'flow::clarify',
      '--normalized-body-file', bodyFile,
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl });

    const updated2 = await gitlabApi('GET', `/projects/${projectRef}/issues/${issueIid}`);
    assert.ok(!updated2.description.includes('THIS SHOULD NOT APPEAR'), `Body should not change on clarify`);
    assert.ok(updated2.description.includes('Normalized body content'), `Original body should remain`);
  } finally {
    await gitlabApi('PUT', `/projects/${projectRef}/issues/${issueIid}`, { state_event: 'close' });
    try { fs.unlinkSync(bodyFile); } catch {}
  }
});
