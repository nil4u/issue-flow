const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { extractBranchEvent } = require('../skills/issue-flow/scripts/milestone.cjs');
const {
  listMilestoneCandidates,
  matchesBranchPattern,
  resolveIssueTarget,
  resolveMilestoneConfig,
  resolveMilestoneSelection,
} = require('../skills/issue-flow/scripts/milestones.cjs');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

function writeConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-milestone-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config), 'utf8');
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('milestone config is opt-in and defaults branch patterns only after enablement', () => {
  const disabled = writeConfig({});
  const enabled = writeConfig({ milestone: { enabled: true } });
  const custom = writeConfig({ milestone: { enabled: true, branchPatterns: ['hotfix/*'] } });
  try {
    assert.deepEqual(resolveMilestoneConfig({ config: disabled.file }), {
      enabled: false,
      branchPatterns: ['release/*', 'integration/*'],
    });
    assert.deepEqual(resolveMilestoneConfig({ config: enabled.file }), {
      enabled: true,
      branchPatterns: ['release/*', 'integration/*'],
    });
    assert.deepEqual(resolveMilestoneConfig({ config: custom.file }), {
      enabled: true,
      branchPatterns: ['hotfix/*'],
    });
  } finally {
    disabled.cleanup(); enabled.cleanup(); custom.cleanup();
  }
});

test('branch matching and lifecycle event parsing use GitHub payloads or normalized bridge variables', () => {
  assert.equal(matchesBranchPattern('release/0721', 'release/*'), true);
  assert.equal(matchesBranchPattern('feature/0721', 'release/*'), false);
  assert.deepEqual(extractBranchEvent({ event_name: 'create', ref_type: 'branch', ref: 'release/0721' }, {}), {
    action: 'create', branch: 'release/0721',
  });
  assert.deepEqual(extractBranchEvent({}, {
    GITLAB_BRIDGE_EVENT_NAME: 'delete',
    GITLAB_BRIDGE_REF_TYPE: 'branch',
    GITLAB_BRIDGE_REF_NAME: 'integration/x',
  }), {
    action: 'delete', branch: 'integration/x',
  });
  assert.deepEqual(extractBranchEvent({ ref: 'refs/heads/integration/x', before: '123', after: '000000' }, {}), {
    action: 'ignored', branch: 'integration/x',
  });
});

test('Agentrix receives base plus checkout refs without forcing a task branch name', () => {
  const args = agentrix.buildRunArgs('build', {
    number: 7, repoFullName: 'acme/app', title: 'Ship',
  }, {}, {
    baseRef: 'release/0721', checkoutRef: 'release/0721',
  }, 'prompt', '/tmp/result.json');
  assert.equal(args[args.indexOf('--base-ref') + 1], 'release/0721');
  assert.equal(args[args.indexOf('--checkout-ref') + 1], 'release/0721');
  assert.equal(args.includes('--branch-name'), false);
});

test('milestone selection is explicit and candidates require an existing branch', async () => {
  const config = writeConfig({ milestone: { enabled: true, branchPatterns: ['release/*'] } });
  const provider = {
    listMilestones: async () => [
      { id: 1, title: 'release/0721', state: 'open' },
      { id: 2, title: 'release/missing', state: 'open' },
      { id: 3, title: 'integration/x', state: 'open' },
    ],
    branchExists: async (_repo, branch) => ['release/0721', 'integration/x', 'main'].includes(branch),
    getMilestoneByTitle: async (_repo, title) => ({ id: 1, title, state: 'open' }),
    getDefaultBranch: async () => 'main',
  };
  try {
    await assert.rejects(resolveMilestoneSelection(undefined, provider, {}, { config: config.file }), /selection is required/);
    assert.deepEqual(await listMilestoneCandidates(provider, {}, { config: config.file }), [
      { id: 1, title: 'release/0721', state: 'open' },
    ]);
    assert.deepEqual(await resolveIssueTarget({ milestone: { title: 'release/0721' } }, provider, {}, { config: config.file }), {
      enabled: true, baseRef: 'release/0721', checkoutRef: 'release/0721', milestone: 'release/0721',
    });
    assert.deepEqual(await resolveMilestoneSelection('none', provider, {}, { config: config.file }), {
      enabled: true, milestone: null,
    });
    assert.deepEqual(await resolveIssueTarget({}, provider, {}, { config: config.file }), {
      enabled: true, baseRef: 'main', checkoutRef: 'main', milestone: '',
    });
  } finally {
    config.cleanup();
  }
});

test('empty branch patterns keep manually maintained milestones selectable', async () => {
  const config = writeConfig({ milestone: { enabled: true, branchPatterns: [] } });
  const provider = {
    listMilestones: async () => [{ id: 3, title: 'custom/acceptance', state: 'open' }],
    branchExists: async () => true,
  };
  try {
    assert.deepEqual(await listMilestoneCandidates(provider, {}, { config: config.file }), [
      { id: 3, title: 'custom/acceptance', state: 'open' },
    ]);
  } finally {
    config.cleanup();
  }
});
