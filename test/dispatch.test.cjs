const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseArgs,
  resolveAutomationDecision,
  resolveRuntimeResumeDecision,
  runPrMerged,
} = require('../skills/issue-flow/scripts/dispatch.cjs');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

test('dispatch parser accepts runtime and Agentrix path options', () => {
  assert.deepEqual(parseArgs([
    'auto',
    '--event',
    '/tmp/event.json',
    '--runtime',
    'agentrix',
    '--prompts-dir',
    '.github/agentrix/issue-flow',
    '--templates-dir',
    '.github/agentrix/issue-flow/templates',
    '--plan-root-dir',
    '.agentrix/issues',
  ]), {
    command: 'auto',
    options: {
      _: [],
      event: '/tmp/event.json',
      runtime: 'agentrix',
      promptsDir: '.github/agentrix/issue-flow',
      templatesDir: '.github/agentrix/issue-flow/templates',
      planRootDir: '.agentrix/issues',
    },
  });
});

test('dispatch rejects workflow and plugin directory overrides', () => {
  assert.throws(
    () => parseArgs(['auto', '--workflow-dir', '.github/workflows/custom']),
    /Unknown option: --workflow-dir/
  );
  assert.throws(
    () => parseArgs(['auto', '--plugin-dir', '.agentrix/plugins/custom']),
    /Unknown option: --plugin-dir/
  );
});

test('dispatch automation skips flow actions unsupported by runtime', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::review', 'automation::build'],
      },
      agentrix,
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'unsupported_flow',
      action: 'review',
      flowLabel: 'flow::review',
      automationLabel: 'automation::build',
      repoDefaultLevel: 'build',
      issueAutomationLevel: 'build',
      effectiveLevel: 'build',
    }
  );
});

test('dispatch resume skips flow actions unsupported by runtime', () => {
  assert.deepEqual(
    resolveRuntimeResumeDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::review'],
      },
      agentrix
    ),
    {
      shouldRun: false,
      reason: 'unsupported_flow',
      action: 'review',
      flowLabel: 'flow::review',
    }
  );
});

test('dispatch pr-merged auto-resumes plan merges into build action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-dispatch-merged-test-'));
  const eventPath = path.join(root, 'event.json');
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        merged: true,
        labels: [{ name: 'mr-by::plan' }],
        body: '<!-- issue-flow:source-issue=42 -->\nSource issue: #42',
        title: 'Plan #42: Add widget support',
        head: { ref: '42-add-widget-support/plan' },
      },
      repository: { full_name: 'example/platform' },
    })
  );

  try {
    const result = await runPrMerged({
      event: eventPath,
      dryRun: true,
      autoDefault: 'build',
    });

    assert.equal(result.transition.action, 'applied');
    assert.equal(result.transition.flow, 'flow::build');
    assert.equal(result.autoResume.action, 'build');
    assert.equal(result.autoResume.result.status, 'dry-run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
