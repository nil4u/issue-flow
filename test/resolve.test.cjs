const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractMention,
  maxAutomationLevel,
  normalizeAutomationLevel,
  resolveAutomationDecision,
  shouldRunAutoForEvent,
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

test('automation decision uses issue automation label when present', () => {
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

test('automation decision uses repo default when issue automation label is absent', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::plan'],
      },
      { autoDefault: 'plan' }
    ),
    {
      shouldRun: true,
      action: 'plan',
      flowLabel: 'flow::plan',
      automationLabel: undefined,
      repoDefaultLevel: 'plan',
      issueAutomationLevel: 'off',
      effectiveLevel: 'plan',
    }
  );
});

test('automation decision lets issue automation label lower repo default', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::build', 'automation::plan'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'automation_level_too_low',
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::plan',
      repoDefaultLevel: 'build',
      issueAutomationLevel: 'plan',
      effectiveLevel: 'plan',
    }
  );
});

test('automation decision lets automation off override repo default', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['status::active', 'flow::build', 'automation::off'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'automation_off',
      action: 'build',
      flowLabel: 'flow::build',
      automationLabel: 'automation::off',
      repoDefaultLevel: 'build',
      issueAutomationLevel: 'off',
      effectiveLevel: 'off',
    }
  );
});

test('automation decision requires active status label', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        labels: ['flow::build', 'automation::build'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'missing_status_label',
      automationLabel: 'automation::build',
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

test('automation decision allows plan and build with one size label', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::plan', 'automation::plan', 'size::M'],
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

test('automation decision blocks plan and build when size labels conflict', () => {
  const decision = resolveAutomationDecision(
    {
      state: 'open',
      labels: ['status::active', 'flow::build', 'automation::build', 'size::S', 'size::M'],
    },
    { autoDefault: 'build' }
  );

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.code, 'multiple_size_labels');
  assert.equal(decision.reason, 'This issue has more than one size:: label; choose one size label before continuing.');
  assert.deepEqual(decision.labels, ['size::S', 'size::M']);
  assert.doesNotMatch(decision.reason, /multiple_size_labels/);
});

test('automation decision blocks plan and build when size label is not managed', () => {
  const decision = resolveAutomationDecision(
    {
      state: 'open',
      labels: ['status::active', 'flow::build', 'automation::build', 'size::XXL'],
    },
    { autoDefault: 'build' }
  );

  assert.equal(decision.shouldRun, false);
  assert.equal(decision.code, 'invalid_size_label');
  assert.equal(decision.reason, 'This issue has a size:: label that is not managed by issue-flow; choose one managed size label before continuing.');
  assert.deepEqual(decision.labels, ['size::XXL']);
});

test('automation decision does not require size for triage', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::triage', 'automation::build'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: true,
      action: 'triage',
      flowLabel: 'flow::triage',
      automationLabel: 'automation::build',
      repoDefaultLevel: 'build',
      issueAutomationLevel: 'build',
      effectiveLevel: 'build',
    }
  );
});

test('automation decision rejects old flow::review without resolving a review action', () => {
  assert.deepEqual(
    resolveAutomationDecision(
      {
        state: 'open',
        labels: ['status::active', 'flow::review', 'automation::build'],
      },
      { autoDefault: 'build' }
    ),
    {
      shouldRun: false,
      reason: 'unsupported_flow',
      flowLabel: 'flow::review',
      automationLabel: 'automation::build',
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

test('auto labeled event gate only admits routing labels', () => {
  assert.equal(shouldRunAutoForEvent({ action: 'opened' }), true);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'flow::build' } }), true);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'automation::build' } }), true);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'automation::off' } }), false);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'type::feature' } }), false);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'priority::p2' } }), false);
  assert.equal(shouldRunAutoForEvent({ action: 'labeled', label: { name: 'size::M' } }), false);
});
