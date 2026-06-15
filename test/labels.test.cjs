const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectDesiredLabels,
  computeLabelChanges,
  shouldSkipIssueBodyUpdate,
} = require('../skills/issue-flow/scripts/apply.cjs');

test('apply script exposes only plan and build automation issue labels', () => {
  assert.throws(
    () => collectDesiredLabels({ automation: 'automation::triage' }),
    /automation must be one of: automation::plan, automation::build/
  );
  assert.throws(
    () => collectDesiredLabels({ automation: 'automation::off' }),
    /automation must be one of: automation::plan, automation::build/
  );
});

test('apply script rejects review as an issue flow label', () => {
  assert.throws(
    () => collectDesiredLabels({ flow: 'flow::review' }),
    /flow must be one of: flow::triage, flow::plan, flow::build, flow::clarify, flow::approve/
  );
});

test('managed label changes remove only selected conflicting prefixes', () => {
  assert.deepEqual(
    computeLabelChanges(
      ['type::bug', 'status::active', 'priority::p3', 'automation::build', 'unmanaged'],
      { type: 'type::feature', priority: 'priority::p2', automation: 'automation::plan' }
    ),
    {
      labelsToAdd: ['type::feature', 'priority::p2', 'automation::plan'],
      labelsToRemove: ['type::bug', 'priority::p3', 'automation::build'],
    }
  );
});

test('managed label changes preserve automation label when no automation update is requested', () => {
  assert.deepEqual(
    computeLabelChanges(
      ['type::bug', 'status::active', 'flow::triage', 'automation::build'],
      { type: 'type::feature', flow: 'flow::plan' }
    ),
    {
      labelsToAdd: ['type::feature', 'flow::plan'],
      labelsToRemove: ['type::bug', 'flow::triage'],
    }
  );
});

test('clarify flow never updates issue body', () => {
  assert.equal(shouldSkipIssueBodyUpdate({ flow: 'flow::clarify' }), true);
  assert.equal(shouldSkipIssueBodyUpdate({ flow: 'flow::plan' }), false);
});
