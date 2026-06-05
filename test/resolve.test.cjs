const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractMention,
  maxAutomationLevel,
  normalizeAutomationLevel,
  resolveAutomationDecision,
} = require('../skills/issue-flow/scripts/resolve.cjs');

test('mention extraction keeps manual instruction text', () => {
  assert.deepEqual(extractMention('@bot: please plan this'), {
    triggered: true,
    instruction: 'please plan this',
  });
});

test('mention extraction returns not triggered for unrelated text', () => {
  assert.deepEqual(extractMention('hello world'), {
    triggered: false,
    instruction: '',
  });
});

test('mention extraction handles mention without instruction', () => {
  const result = extractMention('@bot');
  assert.equal(result.triggered, true);
  assert.equal(result.instruction, '');
});

test('automation levels normalize labels and choose the highest enabled level', () => {
  assert.equal(normalizeAutomationLevel('automation::PLAN'), 'plan');
  assert.equal(maxAutomationLevel('triage', 'automation::build'), 'build');
});

test('automation decision raises repo default with issue automation label', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::plan', 'automation::plan'],
      },
      { autoDefault: 'triage' }
    ),
    {
      shouldRun: true,
      action: 'plan',
      flowLabel: 'flow::plan',
      automationLabel: 'automation::plan',
      repoDefaultLevel: 'triage',
      issueAutomationLevel: 'plan',
      effectiveLevel: 'plan',
    }
  );
});

test('automation decision does not let issue labels lower repo default', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::build', 'automation::off'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: true,
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::off',
      repoDefaultLevel: 'build',
      issueAutomationLevel: 'off',
      effectiveLevel: 'build',
    }
  );
});

test('automation decision skips when effective level is below current flow', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::build', 'automation::plan'],
      },
      { autoDefault: 'triage' }
    ),
    {
      shouldRun: false,
      reason: 'automation_level_too_low',
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::plan',
      repoDefaultLevel: 'triage',
      issueAutomationLevel: 'plan',
      effectiveLevel: 'plan',
    }
  );
});

test('automation decision runs build when manual automation label allows current flow', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::build', 'automation::build'],
      },
      { autoDefault: 'triage' }
    ),
    {
      shouldRun: true,
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::build',
      repoDefaultLevel: 'triage',
      issueAutomationLevel: 'build',
      effectiveLevel: 'build',
    }
  );
});

test('automation decision never runs closed issues', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'closed',
        labels: ['status::active', 'flow::build', 'automation::build'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'issue_not_open',
      state: 'closed',
    }
  );
});

test('automation decision uses the highest manual automation label when labels conflict', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::build', 'automation::plan', 'automation::build'],
      },
      { autoDefault: 'triage' }
    ),
    {
      shouldRun: true,
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::build',
      repoDefaultLevel: 'triage',
      issueAutomationLevel: 'build',
      effectiveLevel: 'build',
    }
  );
});
