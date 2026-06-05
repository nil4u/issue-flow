/**
 * Full lifecycle integration test.
 *
 * Case (per provider):
 *   1. Clone repo via HTTPS + token, ensure main branch exists
 *   2. Create test issue (API)
 *   3. apply.cjs → status::active + flow::triage (intake)
 *   4. apply.cjs → flow::plan, type::feature (triage decision)
 *   5. Create branch, add plan.md, commit, push
 *   6. submit.cjs plan → verify PR has mr-by::plan, issue has flow::approve
 *   7. Merge PR (API)
 *   8. pr-merged.cjs → verify issue has flow::build
 *   9. Create branch, add impl file, commit, push
 *   10. submit.cjs build → verify PR has mr-by::build, issue has flow::approve
 *   11. Merge PR (API)
 *   12. pr-merged.cjs → verify issue has status::done, flow cleared
 *   Cleanup: close issue, delete branches
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPTS_DIR = path.join(__dirname, '..', 'skills', 'issue-flow', 'scripts');
const APPLY = path.join(SCRIPTS_DIR, 'apply.cjs');
const SUBMIT = path.join(SCRIPTS_DIR, 'submit.cjs');
const PR_MERGED = path.join(SCRIPTS_DIR, 'pr-merged.cjs');

// --- Env ---

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (value && !process.env[key]) process.env[key] = value;
  }
}
loadEnv();

const githubToken = process.env.GITHUB_TOKEN || '';
const githubRepo = process.env.GITHUB_TEST_REPO || '';
const skipGithub = !githubToken || !githubRepo;

const gitlabToken = process.env.GITLAB_TOKEN || '';
const gitlabBaseUrl = (process.env.GITLAB_BASE_URL || '').replace(/\/+$/, '');
const gitlabProject = process.env.GITLAB_TEST_PROJECT || '';
const skipGitlab = !gitlabToken || !gitlabBaseUrl || !gitlabProject;

// --- Helpers ---

function shell(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout || 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}... exit ${result.status}: ${(result.stderr || '').slice(0, 300)}`);
  }
  return result.stdout.trim();
}

function nodeScript(script, args, opts = {}) {
  return shell('node', [script, ...args], opts);
}

function parseLastJson(text) {
  const t = (text || '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[^{}]*\}/g);
  if (m) {
    for (let i = m.length - 1; i >= 0; i--) {
      try { return JSON.parse(m[i]); } catch {}
    }
  }
  // Try multi-line JSON blocks
  const blocks = t.match(/\{[\s\S]*?\n\}/g);
  if (blocks) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      try { return JSON.parse(blocks[i]); } catch {}
    }
  }
  return null;
}

async function githubApi(method, apiPath, body) {
  const url = `${process.env.GITHUB_API_URL || 'https://api.github.com'}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${apiPath} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

async function gitlabApi(method, apiPath, body) {
  const url = `${gitlabBaseUrl}/api/v4${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: {
      'PRIVATE-TOKEN': gitlabToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitLab ${method} ${apiPath} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

function cloneUrl(provider) {
  if (provider === 'github') {
    return `https://x-access-token:${githubToken}@github.com/${githubRepo}.git`;
  }
  const host = gitlabBaseUrl.replace(/^https?:\/\//, '');
  return `https://oauth2:${gitlabToken}@${host}/${gitlabProject}.git`;
}

function ensureMainBranch(repoDir) {
  const branches = shell('git', ['branch', '-r'], { cwd: repoDir });
  if (branches.includes('origin/main')) {
    shell('git', ['checkout', 'main'], { cwd: repoDir });
    return;
  }
  // No main branch yet — create one
  shell('git', ['checkout', '--orphan', 'main'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Test repo\n');
  shell('git', ['add', '.'], { cwd: repoDir });
  shell('git', ['commit', '-m', 'init main'], { cwd: repoDir });
  shell('git', ['push', '-u', 'origin', 'main'], { cwd: repoDir });
}

function writeEventFile(dir, payload) {
  const p = path.join(dir, 'event.json');
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gitlabMergeMr(projectRef, mrIid, retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await gitlabApi('PUT', `/projects/${projectRef}/merge_requests/${mrIid}/merge`, { squash: true });
      return;
    } catch (err) {
      if (i === retries - 1 || !err.message.includes('cannot be merged')) throw err;
      await sleep(3000);
    }
  }
}

// --- GitHub Full Lifecycle ---

test('github: full issue lifecycle (triage → plan PR → merge → build PR → merge → done)', {
  skip: skipGithub && 'GITHUB_TOKEN or GITHUB_TEST_REPO not set',
  timeout: 180000,
}, async () => {
  const [owner, repo] = githubRepo.split('/');
  const apiBase = `/repos/${owner}/${repo}`;
  const ts = Date.now();
  const planBranch = `${ts}-lifecycle/plan`;
  const buildBranch = `${ts}-lifecycle/build`;
  const env = { GITHUB_TOKEN: githubToken, GH_TOKEN: githubToken };

  // 1. Clone
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-gh-'));
  shell('git', ['clone', cloneUrl('github'), repoDir]);
  shell('git', ['config', 'user.email', 'test@issue-flow.dev'], { cwd: repoDir });
  shell('git', ['config', 'user.name', 'Issue Flow Test'], { cwd: repoDir });
  ensureMainBranch(repoDir);

  // 2. Create issue
  const issue = await githubApi('POST', `${apiBase}/issues`, {
    title: `[lifecycle] ${ts}`,
    body: 'Full lifecycle integration test.',
  });
  const num = issue.number;

  try {
    // 3. Intake: apply default labels
    nodeScript(APPLY, [
      '--issue-number', String(num),
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env });

    let labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('status::active'));
    assert.ok(labels.includes('flow::triage'));

    // 4. Triage decision
    nodeScript(APPLY, [
      '--issue-number', String(num),
      '--flow', 'flow::plan',
      '--type', 'type::feature',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env });

    labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('flow::plan'));
    assert.ok(labels.includes('type::feature'));
    assert.ok(!labels.includes('flow::triage'));

    // 5. Create plan branch, commit (no push — submit.cjs will push)
    shell('git', ['checkout', '-b', planBranch], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, `plan-${num}.md`), `# Plan for #${num}\n\nSteps:\n- Step 1\n`);
    shell('git', ['add', '.'], { cwd: repoDir });
    shell('git', ['commit', '-m', `Plan #${num}: feature plan`], { cwd: repoDir });

    // 6. Submit plan PR (script handles push + PR creation + label + flow transition)
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-body-'));
    const planBodyFile = path.join(bodyDir, 'plan.md');
    fs.writeFileSync(planBodyFile, `## Plan\n\nImplementation plan for #${num}.`);

    const submitPlanOut = nodeScript(SUBMIT, [
      'plan',
      '--issue-number', String(num),
      '--title', `Plan #${num}: feature plan`,
      '--body-file', planBodyFile,
      '--head', planBranch,
      '--base', 'main',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env, cwd: repoDir, timeout: 60000 });

    const planResult = parseLastJson(submitPlanOut);
    assert.ok(planResult, `Should parse submit output, got: ${submitPlanOut.slice(-200)}`);
    assert.equal(planResult.kind, 'plan');
    assert.ok(planResult.prUrl);

    // Verify PR label
    const planPr = await githubApi('GET', `${apiBase}/pulls?head=${owner}:${planBranch}&state=open`);
    assert.ok(planPr.length > 0, 'Plan PR should exist');
    const planPrLabels = planPr[0].labels.map(l => l.name);
    assert.ok(planPrLabels.includes('mr-by::plan'), `PR labels: ${planPrLabels}`);
    assert.ok(planPr[0].body.includes(`<!-- issue-flow:source-issue=${num} -->`));

    // Verify issue flow::approve
    labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('flow::approve'), `Issue should be flow::approve, got: ${labels}`);

    // 7. Merge plan PR
    const planPrNumber = planPr[0].number;
    await githubApi('PUT', `${apiBase}/pulls/${planPrNumber}/merge`, { merge_method: 'squash' });

    // 8. pr-merged → flow::build
    const planMergeEvent = writeEventFile(bodyDir, {
      action: 'closed',
      pull_request: {
        merged: true,
        title: planPr[0].title,
        body: planPr[0].body,
        labels: [{ name: 'mr-by::plan' }],
        head: { ref: planBranch },
      },
      repository: { full_name: githubRepo, owner: { login: owner }, name: repo },
    });

    nodeScript(PR_MERGED, [
      '--event', planMergeEvent,
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env });

    labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('flow::build'), `After plan merge: ${labels}`);
    assert.ok(!labels.includes('flow::approve'));

    // 9. Create build branch, commit (submit.cjs will push)
    shell('git', ['checkout', 'main'], { cwd: repoDir });
    shell('git', ['pull'], { cwd: repoDir });
    shell('git', ['checkout', '-b', buildBranch], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, `impl-${num}.js`), `module.exports = { feature: ${num} };\n`);
    shell('git', ['add', '.'], { cwd: repoDir });
    shell('git', ['commit', '-m', `Build #${num}: implement feature`], { cwd: repoDir });

    // 10. Submit build PR (script handles push + PR creation + label + flow transition)
    const buildBodyFile = path.join(bodyDir, 'build.md');
    fs.writeFileSync(buildBodyFile, `## Build\n\nImplementation for #${num}.`);

    const submitBuildOut = nodeScript(SUBMIT, [
      'build',
      '--issue-number', String(num),
      '--title', `Build #${num}: implement feature`,
      '--body-file', buildBodyFile,
      '--head', buildBranch,
      '--base', 'main',
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env, cwd: repoDir, timeout: 60000 });

    const buildResult = parseLastJson(submitBuildOut);
    assert.ok(buildResult, `Should parse build submit output`);
    assert.equal(buildResult.kind, 'build');

    const buildPr = await githubApi('GET', `${apiBase}/pulls?head=${owner}:${buildBranch}&state=open`);
    assert.ok(buildPr.length > 0);
    assert.ok(buildPr[0].labels.map(l => l.name).includes('mr-by::build'));

    labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('flow::approve'), `Issue should be flow::approve for build`);

    // 11. Merge build PR
    const buildPrNumber = buildPr[0].number;
    await githubApi('PUT', `${apiBase}/pulls/${buildPrNumber}/merge`, { merge_method: 'squash' });

    // 12. pr-merged → status::done + clear flow
    const buildMergeEvent = writeEventFile(bodyDir, {
      action: 'closed',
      pull_request: {
        merged: true,
        title: buildPr[0].title,
        body: buildPr[0].body,
        labels: [{ name: 'mr-by::build' }],
        head: { ref: buildBranch },
      },
      repository: { full_name: githubRepo, owner: { login: owner }, name: repo },
    });

    nodeScript(PR_MERGED, [
      '--event', buildMergeEvent,
      '--repo', githubRepo,
      '--provider', 'github',
    ], { env });

    labels = (await githubApi('GET', `${apiBase}/issues/${num}`)).labels.map(l => l.name);
    assert.ok(labels.includes('status::done'), `Final state should have status::done, got: ${labels}`);
    assert.ok(!labels.some(l => l.startsWith('flow::')), `Flow should be cleared, got: ${labels}`);

  } finally {
    await githubApi('PATCH', `${apiBase}/issues/${num}`, { state: 'closed' }).catch(() => {});
    shell('git', ['push', 'origin', '--delete', planBranch], { cwd: repoDir, allowFail: true });
    shell('git', ['push', 'origin', '--delete', buildBranch], { cwd: repoDir, allowFail: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// --- GitLab Full Lifecycle ---

test('gitlab: full issue lifecycle (triage → plan MR → merge → build MR → merge → done)', {
  skip: skipGitlab && 'GITLAB env not set',
  timeout: 180000,
}, async () => {
  const projectRef = encodeURIComponent(gitlabProject);
  const ts = Date.now();
  const planBranch = `${ts}-lifecycle/plan`;
  const buildBranch = `${ts}-lifecycle/build`;
  const env = { GITLAB_TOKEN: gitlabToken, GITLAB_BASE_URL: gitlabBaseUrl };

  // 1. Clone
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-gl-'));
  shell('git', ['clone', cloneUrl('gitlab'), repoDir]);
  shell('git', ['config', 'user.email', 'test@issue-flow.dev'], { cwd: repoDir });
  shell('git', ['config', 'user.name', 'Issue Flow Test'], { cwd: repoDir });
  ensureMainBranch(repoDir);

  // 2. Create issue
  const issue = await gitlabApi('POST', `/projects/${projectRef}/issues`, {
    title: `[lifecycle] ${ts}`,
    description: 'Full lifecycle integration test.',
  });
  const num = issue.iid;

  try {
    // 3. Intake
    nodeScript(APPLY, [
      '--issue-number', String(num),
      '--status', 'status::active',
      '--flow', 'flow::triage',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env });

    let updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('status::active'));
    assert.ok(updated.labels.includes('flow::triage'));

    // 4. Triage decision
    nodeScript(APPLY, [
      '--issue-number', String(num),
      '--flow', 'flow::plan',
      '--type', 'type::feature',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env });

    updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('flow::plan'));
    assert.ok(updated.labels.includes('type::feature'));
    assert.ok(!updated.labels.includes('flow::triage'));

    // 5. Plan branch (submit.cjs will push)
    shell('git', ['checkout', '-b', planBranch], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, `plan-${num}.md`), `# Plan for #${num}\n`);
    shell('git', ['add', '.'], { cwd: repoDir });
    shell('git', ['commit', '-m', `Plan #${num}: feature plan`], { cwd: repoDir });

    // 6. Submit plan MR (script handles push + MR creation + label + flow transition)
    const bodyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-body-'));
    const planBodyFile = path.join(bodyDir, 'plan.md');
    fs.writeFileSync(planBodyFile, `## Plan\n\nPlan for #${num}.`);

    const submitPlanOut = nodeScript(SUBMIT, [
      'plan',
      '--issue-number', String(num),
      '--title', `Plan #${num}: feature plan`,
      '--body-file', planBodyFile,
      '--head', planBranch,
      '--base', 'main',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env, cwd: repoDir, timeout: 60000 });

    const planResult = parseLastJson(submitPlanOut);
    assert.ok(planResult, `Should parse submit output`);
    assert.equal(planResult.kind, 'plan');
    assert.ok(planResult.prUrl);

    // Verify MR
    const planMrs = await gitlabApi('GET', `/projects/${projectRef}/merge_requests?source_branch=${encodeURIComponent(planBranch)}&state=opened`);
    assert.ok(planMrs.length > 0);
    assert.ok(planMrs[0].labels.includes('mr-by::plan'), `MR labels: ${planMrs[0].labels}`);
    assert.ok(planMrs[0].description.includes(`<!-- issue-flow:source-issue=${num} -->`));

    // Verify issue
    updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('flow::approve'), `Issue: ${updated.labels}`);

    // 7. Merge plan MR (retry — GitLab needs time to compute merge status)
    const planMrIid = planMrs[0].iid;
    await gitlabMergeMr(projectRef, planMrIid);

    // 8. pr-merged → flow::build
    const planMergeEvent = writeEventFile(bodyDir, {
      object_kind: 'merge_request',
      project: { path_with_namespace: gitlabProject },
      labels: [{ title: 'mr-by::plan' }],
      object_attributes: {
        action: 'merge',
        state: 'merged',
        source_branch: planBranch,
        title: `Plan #${num}: feature plan`,
        description: planMrs[0].description,
      },
    });

    nodeScript(PR_MERGED, [
      '--event', planMergeEvent,
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env });

    updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('flow::build'), `After plan merge: ${updated.labels}`);
    assert.ok(!updated.labels.includes('flow::approve'));

    // 9. Build branch (submit.cjs will push)
    shell('git', ['checkout', 'main'], { cwd: repoDir });
    shell('git', ['pull'], { cwd: repoDir });
    shell('git', ['checkout', '-b', buildBranch], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, `impl-${num}.js`), `module.exports = { feature: ${num} };\n`);
    shell('git', ['add', '.'], { cwd: repoDir });
    shell('git', ['commit', '-m', `Build #${num}: implement`], { cwd: repoDir });

    // 10. Submit build MR (script handles push + MR creation + label + flow transition)
    const buildBodyFile = path.join(bodyDir, 'build.md');
    fs.writeFileSync(buildBodyFile, `## Build\n\nImpl for #${num}.`);

    const submitBuildOut = nodeScript(SUBMIT, [
      'build',
      '--issue-number', String(num),
      '--title', `Build #${num}: implement`,
      '--body-file', buildBodyFile,
      '--head', buildBranch,
      '--base', 'main',
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env, cwd: repoDir, timeout: 60000 });

    const buildResult = parseLastJson(submitBuildOut);
    assert.ok(buildResult);
    assert.equal(buildResult.kind, 'build');

    const buildMrs = await gitlabApi('GET', `/projects/${projectRef}/merge_requests?source_branch=${encodeURIComponent(buildBranch)}&state=opened`);
    assert.ok(buildMrs.length > 0);
    assert.ok(buildMrs[0].labels.includes('mr-by::build'));

    updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('flow::approve'));

    // 11. Merge build MR
    const buildMrIid = buildMrs[0].iid;
    await gitlabMergeMr(projectRef, buildMrIid);

    // 12. pr-merged → status::done + clear flow
    const buildMergeEvent = writeEventFile(bodyDir, {
      object_kind: 'merge_request',
      project: { path_with_namespace: gitlabProject },
      labels: [{ title: 'mr-by::build' }],
      object_attributes: {
        action: 'merge',
        state: 'merged',
        source_branch: buildBranch,
        title: `Build #${num}: implement`,
        description: buildMrs[0].description,
      },
    });

    nodeScript(PR_MERGED, [
      '--event', buildMergeEvent,
      '--repo', gitlabProject,
      '--provider', 'gitlab',
    ], { env });

    updated = await gitlabApi('GET', `/projects/${projectRef}/issues/${num}`);
    assert.ok(updated.labels.includes('status::done'), `Final: ${updated.labels}`);
    assert.ok(!updated.labels.some(l => l.startsWith('flow::')), `Flow cleared: ${updated.labels}`);

  } finally {
    await gitlabApi('PUT', `/projects/${projectRef}/issues/${num}`, { state_event: 'close' }).catch(() => {});
    try { await gitlabApi('DELETE', `/projects/${projectRef}/repository/branches/${encodeURIComponent(planBranch)}`); } catch {}
    try { await gitlabApi('DELETE', `/projects/${projectRef}/repository/branches/${encodeURIComponent(buildBranch)}`); } catch {}
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
