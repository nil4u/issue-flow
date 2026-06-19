const assert = require('node:assert/strict');
const test = require('node:test');

const {
  checkLabels,
  countResults,
  parseArgs,
  syncLabels,
} = require('../skills/issue-flow/scripts/sync-labels.cjs');
const { labelsForScope } = require('../skills/issue-flow/scripts/labels.cjs');

test('sync-labels parser rejects ambiguous check dry-run mode', () => {
  assert.deepEqual(parseArgs(['--provider', 'github', '--repo', 'owner/repo', '--dry-run']), {
    _: [],
    provider: 'github',
    repo: 'owner/repo',
    dryRun: true,
  });
  assert.throws(() => parseArgs(['--dry-run', '--check']), /--dry-run and --check are mutually exclusive/);
});

test('sync-labels dry-run emits provider-formatted ensure actions without provider reads', async () => {
  let reads = 0;
  const provider = {
    name: 'gitlab',
    getLabel: async () => {
      reads += 1;
    },
  };

  const results = await syncLabels(
    provider,
    { fullName: 'group/project' },
    [{ name: 'priority::p0', color: 'B60205', description: 'Highest priority issue' }],
    { dryRun: true }
  );

  assert.equal(reads, 0);
  assert.deepEqual(results, [
    {
      name: 'priority::p0',
      action: 'ensure',
      expected: {
        name: 'priority::p0',
        color: '#B60205',
        description: 'Highest priority issue',
      },
    },
  ]);
});

test('sync-labels check maps provider state to skipped missing and drifted', async () => {
  const provider = {
    name: 'github',
    getLabel: async (_repo, name) => {
      if (name === 'missing') {
        return undefined;
      }
      if (name === 'drift') {
        return { name, color: '000000', description: 'old' };
      }
      return { name, color: '1D76DB', description: 'current' };
    },
  };

  const results = await checkLabels(
    provider,
    { fullName: 'owner/repo' },
    [
      { name: 'current', color: '1D76DB', description: 'current' },
      { name: 'missing', color: '1D76DB', description: 'current' },
      { name: 'drift', color: '1D76DB', description: 'current' },
    ],
    {}
  );

  assert.deepEqual(results.map((result) => [result.name, result.action]), [
    ['current', 'skipped'],
    ['missing', 'missing'],
    ['drift', 'drifted'],
  ]);
  assert.deepEqual(countResults(results), {
    created: 0,
    updated: 0,
    skipped: 1,
    failed: 0,
    missing: 1,
    drifted: 1,
    planned: 0,
  });
});

test('sync-labels catalog definitions include size labels', async () => {
  const provider = {
    name: 'github',
  };

  const results = await syncLabels(
    provider,
    { fullName: 'owner/repo' },
    labelsForScope('issue').filter((label) => label.name.startsWith('size::')),
    { dryRun: true }
  );

  assert.deepEqual(results.map((result) => result.name), ['size::XS', 'size::S', 'size::M', 'size::L', 'size::XL']);
});
