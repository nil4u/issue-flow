const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const util = require('node:util');

// installGitlabPluginMergeRequest 的 execFileAsync 在模块加载时捕获
// child_process.execFile，必须先替换再 require。
const realExecFile = child_process.execFile;
const execState = {
  calls: [],
  cloneTarget: '',
  statusOutput: ' M .gitlab-ci.yml\n',
  install: () => ({ stdout: '', stderr: '' }),
};

function handleExec(file, args) {
  execState.calls.push({ file, args });
  if (file === 'git') {
    if (args[0] === 'clone') {
      execState.cloneTarget = args[args.length - 1];
    }
    if (args[0] === 'status') {
      return { stdout: execState.statusOutput, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
  if (file === 'sh') {
    return execState.install(args);
  }
  throw new Error(`unexpected execFile: ${file} ${args.join(' ')}`);
}

function fakeExecFile(file, args, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  Promise.resolve()
    .then(() => handleExec(file, args))
    .then((result) => done(null, result.stdout, result.stderr), (error) => done(error));
}
fakeExecFile[util.promisify.custom] = async (file, args) => handleExec(file, args);
child_process.execFile = fakeExecFile;

// gitlab.ts -> store.ts -> storage/db.ts 需要 DATABASE_URL 才能加载；
// PrismaClient 构造不建立连接，占位值即可。
process.env.DATABASE_URL ||= 'postgresql://issue-flow:test@127.0.0.1:5432/issue_flow_test';

require('tsx/cjs');
const { installGitlabPluginMergeRequest } = require('../src/core/gitlab-bootstrap.ts');

const realFetch = global.fetch;
test.after(() => {
  child_process.execFile = realExecFile;
  global.fetch = realFetch;
});

function resetExecState() {
  execState.calls = [];
  execState.cloneTarget = '';
  execState.statusOutput = ' M .gitlab-ci.yml\n';
  execState.install = () => ({ stdout: '', stderr: '' });
}

function installInput(extra = {}) {
  return {
    apiUrl: 'https://gitlab.example.com/api/v4',
    baseUrl: 'https://gitlab.example.com',
    token: 'secret-token',
    authType: 'bearer',
    projectIdOrPath: '123',
    projectPath: 'group/app',
    branch: 'main',
    operation: 'install',
    commitAuthor: {
      name: 'Issue Flow Bot',
      email: 'issue-flow-bot@gitlab.example.com',
    },
    ...extra,
  };
}

function gitCalls(subcommand) {
  return execState.calls.filter((call) => call.file === 'git' && call.args[0] === subcommand);
}

function installScriptCalls() {
  return execState.calls.filter((call) => call.file === 'sh');
}

const conflictPlan = {
  fingerprint: 'fp-1',
  conflicts: [{
    id: '.gitlab-ci.yml',
    category: 'gitlab_ci',
    path: '.gitlab-ci.yml',
    mode: 'managed',
    kind: 'desired',
    reason: 'missing_issue_flow_include',
    defaultAction: 'use_proposed',
    allowedActions: ['use_proposed', 'keep_current'],
    currentContent: 'build:\n  script: echo build\n',
    proposedContent: 'include:\n  - local: .gitlab/issue-flow.gitlab-ci.yml\n\nbuild:\n  script: echo build\n',
  }],
};

test('install merge request stops with conflicts and does not push or create MR', async () => {
  resetExecState();
  const fetches = [];
  global.fetch = async (url, init) => {
    fetches.push({ url, init });
    throw new Error('unexpected fetch');
  };
  execState.install = (args) => {
    assert.equal(args[1], 'gitlab');
    assert.equal(args[2], '--plan-json');
    return { stdout: `${JSON.stringify(conflictPlan)}\n`, stderr: '' };
  };

  const result = await installGitlabPluginMergeRequest(installInput());

  assert.equal(result.conflicts, true);
  assert.equal(result.plan.fingerprint, 'fp-1');
  assert.equal(result.plan.conflicts.length, 1);
  assert.equal(installScriptCalls().length, 1);
  assert.equal(gitCalls('commit').length, 0);
  assert.equal(gitCalls('push').length, 0);
  assert.equal(fetches.length, 0);
});

test('install merge request applies decisions from a temp file outside the checkout', async () => {
  resetExecState();
  const decisions = {
    fingerprint: 'fp-1',
    actions: { '.gitlab-ci.yml': 'use_proposed' },
  };
  let decisionFileArg = '';
  let decisionFileBody;
  execState.install = (args) => {
    assert.equal(args[1], 'gitlab');
    assert.equal(args[2], '--decision-file');
    decisionFileArg = args[3];
    decisionFileBody = JSON.parse(fs.readFileSync(decisionFileArg, 'utf8'));
    return { stdout: '', stderr: '' };
  };
  global.fetch = async (url, init) => ({
    ok: true,
    status: 200,
    headers: {},
    text: async () => JSON.stringify({
      id: 9,
      iid: 3,
      web_url: 'https://gitlab.example.com/group/app/-/merge_requests/3',
    }),
  });

  const result = await installGitlabPluginMergeRequest(installInput({ decisions }));

  assert.deepEqual(decisionFileBody, decisions);
  assert.equal(path.dirname(decisionFileArg), path.dirname(execState.cloneTarget));
  assert.equal(decisionFileArg.startsWith(`${execState.cloneTarget}${path.sep}`), false);
  assert.equal(result.skipped, false);
  assert.equal(result.mergeRequest.iid, '3');
  assert.equal(gitCalls('push').length, 1);
  assert.deepEqual(gitCalls('config').map((call) => call.args), [
    ['config', 'user.name', 'Issue Flow Bot'],
    ['config', 'user.email', 'issue-flow-bot@gitlab.example.com'],
  ]);
});

test('install merge request re-streams new plan when decisions are stale', async () => {
  resetExecState();
  const newPlan = {
    error: 'install_plan_changed',
    fingerprint: 'fp-2',
    conflicts: [{ ...conflictPlan.conflicts[0], currentHash: 'changed' }],
  };
  execState.install = (args) => {
    assert.equal(args[2], '--decision-file');
    const failure = new Error('install exited 4');
    failure.code = 4;
    failure.stdout = `${JSON.stringify(newPlan)}\n`;
    failure.stderr = '';
    throw failure;
  };
  global.fetch = async () => {
    throw new Error('unexpected fetch');
  };

  const result = await installGitlabPluginMergeRequest(installInput({
    decisions: { fingerprint: 'fp-1', actions: {} },
  }));

  assert.equal(result.conflicts, true);
  assert.equal(result.plan.fingerprint, 'fp-2');
  assert.equal(result.plan.conflicts.length, 1);
  assert.equal(gitCalls('commit').length, 0);
  assert.equal(gitCalls('push').length, 0);
});
