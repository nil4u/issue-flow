const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildIssueBodyWithSourceMarker,
  collectCreateLabels,
  main,
  parseArgs,
  validateCreateSizeGate,
} = require('../skills/issue-flow/scripts/create-issue.cjs');

function createBodyFile(content = 'Issue body') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-create-issue-'));
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, content, 'utf8');
  return {
    path: bodyFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function captureConsole(callback) {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}

test('create issue parser accepts managed labels and repeated unmanaged labels', () => {
  assert.deepEqual(parseArgs([
    '--title',
    'Add widget export',
    '--body-file',
    '/tmp/body.md',
    '--type',
    'type::feature',
    '--status',
    'status::active',
    '--flow',
    'flow::plan',
    '--automation',
    'automation::build',
    '--priority',
    'priority::p2',
    '--size',
    'size::M',
    '--label',
    'area::export',
    '--label',
    'customer-request',
  ]), {
    _: [],
    labels: ['area::export', 'customer-request'],
    title: 'Add widget export',
    bodyFile: '/tmp/body.md',
    type: 'type::feature',
    status: 'status::active',
    flow: 'flow::plan',
    automation: 'automation::build',
    priority: 'priority::p2',
    size: 'size::M',
  });
});

test('create issue label collection validates managed labels', () => {
  assert.deepEqual(
    collectCreateLabels({
      type: 'type::feature',
      status: 'status::active',
      flow: 'flow::build',
      automation: 'automation::off',
      priority: 'priority::p2',
      size: 'size::S',
      labels: ['area::api'],
    }),
    ['type::feature', 'status::active', 'flow::build', 'automation::off', 'priority::p2', 'size::S', 'area::api']
  );

  assert.throws(() => collectCreateLabels({ flow: 'flow::review' }), /flow must be one of:/);
  assert.throws(
    () => collectCreateLabels({ labels: ['flow::plan'] }),
    /flow::plan is a managed label\. Use --flow flow::plan instead of --label\./
  );
  assert.throws(
    () => collectCreateLabels({ labels: ['size::S'] }),
    /size::S is a managed label\. Use --size size::S instead of --label\./
  );
  assert.throws(() => collectCreateLabels({ labels: ['mr-by::build'] }), /mr-by::\* labels are only valid/);
});

test('create issue requires size when creating directly into plan or build', () => {
  assert.throws(
    () => validateCreateSizeGate(['status::active', 'flow::plan'], { flow: 'flow::plan' }),
    /requires --size size::<value>/
  );
  assert.throws(
    () => validateCreateSizeGate(['flow::build', 'size::S', 'size::M'], { flow: 'flow::build' }),
    /requires exactly one size:: label/
  );
  assert.throws(
    () => validateCreateSizeGate(['flow::build', 'size::XXL'], { flow: 'flow::build' }),
    /requires a managed size label/
  );
  assert.deepEqual(
    validateCreateSizeGate(['flow::build', 'size::S'], { flow: 'flow::build' }),
    { ok: true, label: 'size::S', weight: 1 }
  );
  assert.equal(validateCreateSizeGate(['flow::triage'], { flow: 'flow::triage' }), undefined);
});

test('create issue source marker records task and runtime in one hidden marker', () => {
  assert.equal(
    buildIssueBodyWithSourceMarker('## Goal\n\nShip it.', 'task_123'),
    '<!-- issue-flow:source source_task_id=task_123 source_runtime=agentrix -->\n## Goal\n\nShip it.'
  );
  assert.equal(
    buildIssueBodyWithSourceMarker('<!-- issue-flow:agentrix:task=old -->\n\n## Goal', 'task_456'),
    '<!-- issue-flow:source source_task_id=task_456 source_runtime=agentrix -->\n## Goal'
  );
});

test('create issue dry-run outputs stable JSON without calling provider APIs', async () => {
  const bodyFile = createBodyFile('## Goal\n\nCreate a thing.');
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error('dry-run must not call fetch');
    };
    const output = await captureConsole(() =>
      main([
        '--provider',
        'github',
        '--repo',
        'acme/webapp',
        '--title',
        'Create a thing',
        '--body-file',
        bodyFile.path,
        '--type',
        'type::feature',
        '--automation',
        'automation::off',
        '--size',
        'size::M',
        '--dry-run',
      ])
    );
    const parsed = JSON.parse(output);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.provider, 'github');
    assert.equal(parsed.repo, 'acme/webapp');
    assert.equal(parsed.title, 'Create a thing');
    assert.deepEqual(parsed.labels, ['type::feature', 'automation::off', 'size::M']);
  } finally {
    global.fetch = previousFetch;
    bodyFile.cleanup();
  }
});

test('create issue requires an explicit milestone decision only when enabled', async () => {
  const bodyFile = createBodyFile('Targeted issue.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-create-config-'));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ milestone: { enabled: true } }), 'utf8');
  const args = [
    '--provider', 'github', '--repo', 'acme/webapp', '--config', config,
    '--title', 'Targeted issue', '--body-file', bodyFile.path, '--dry-run',
  ];
  try {
    await assert.rejects(main(args), /Milestone selection is required/);
    const output = await captureConsole(() => main([...args, '--milestone', 'release/0721']));
    assert.equal(JSON.parse(output).milestone, 'release/0721');
  } finally {
    bodyFile.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
