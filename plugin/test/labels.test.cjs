const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectDesiredLabels,
  computeLabelChanges,
  shouldSkipIssueBodyUpdate,
  validateFlowSizeGate,
} = require('../skills/issue-flow/scripts/apply.cjs');
const {
  MANAGED_LABELS,
  labelDefinitionFor,
  labelsForScope,
  resolveIssueSizeLabel,
} = require('../skills/issue-flow/scripts/labels.cjs');

test('catalog covers issue and PR/MR managed labels with stable metadata', () => {
  assert.deepEqual(
    labelsForScope('issue').map((label) => label.name),
    [
      'type::feature',
      'type::bug',
      'type::debt',
      'type::ops',
      'status::active',
      'status::done',
      'status::drop',
      'status::suspend',
      'flow::triage',
      'flow::plan',
      'flow::build',
      'flow::clarify',
      'flow::approve',
      'automation::off',
      'automation::plan',
      'automation::build',
      'priority::p0',
      'priority::p1',
      'priority::p2',
      'priority::p3',
      'size::XS',
      'size::S',
      'size::M',
      'size::L',
      'size::XL',
    ]
  );
  assert.deepEqual(labelsForScope('merge_request').map((label) => label.name), ['mr-by::plan', 'mr-by::build']);

  for (const label of MANAGED_LABELS) {
    assert.match(label.color, /^[A-F0-9]{6}$/);
    assert.equal(typeof label.description, 'string');
    assert.notEqual(label.description.trim(), '');
  }
});

test('catalog exposes lookup by label name', () => {
  assert.equal(labelDefinitionFor('mr-by::plan').color, '0052CC');
  assert.equal(labelDefinitionFor('missing'), undefined);
});

test('apply script accepts explicit automation opt-out plus plan and build issue labels', () => {
  assert.throws(
    () => collectDesiredLabels({ automation: 'automation::triage' }),
    /automation must be one of: automation::off, automation::plan, automation::build/
  );
  assert.deepEqual(collectDesiredLabels({ automation: 'automation::off' }), { automation: 'automation::off' });
});

test('apply script accepts and validates size labels', () => {
  assert.deepEqual(collectDesiredLabels({ size: 'size::M' }), { size: 'size::M' });
  assert.throws(
    () => collectDesiredLabels({ size: 'size::XXL' }),
    /size must be one of: size::XS, size::S, size::M, size::L, size::XL/
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

test('managed label changes replace only the selected size prefix', () => {
  assert.deepEqual(
    computeLabelChanges(['size::S', 'type::feature', 'priority::p2'], { size: 'size::M' }),
    {
      labelsToAdd: ['size::M'],
      labelsToRemove: ['size::S'],
    }
  );
});

test('clarify flow never updates issue body', () => {
  assert.equal(shouldSkipIssueBodyUpdate({ flow: 'flow::clarify' }), true);
  assert.equal(shouldSkipIssueBodyUpdate({ flow: 'flow::plan' }), false);
});

test('plan and build flow require exactly one size label in final apply labels', () => {
  assert.throws(
    () => validateFlowSizeGate([], { flow: 'flow::plan' }, [], { issueNumber: 123 }),
    /needs exactly one size:: label/
  );
  assert.throws(
    () => validateFlowSizeGate(['size::S', 'size::M'], { flow: 'flow::build' }, [], { issueNumber: 123 }),
    /more than one size:: label: size::S, size::M/
  );
  assert.deepEqual(
    validateFlowSizeGate(['size::S'], { flow: 'flow::build' }, [], { issueNumber: 123 }),
    { ok: true, label: 'size::S', weight: 1 }
  );
  assert.deepEqual(
    validateFlowSizeGate(['size::S', 'size::M'], { flow: 'flow::plan', size: 'size::L' }, [], { issueNumber: 123 }),
    { ok: true, label: 'size::L', weight: 3 }
  );
  assert.equal(validateFlowSizeGate([], { flow: 'flow::triage' }, [], { issueNumber: 123 }), undefined);
});

test('single invalid size label is not accepted as a valid issue size', () => {
  assert.deepEqual(resolveIssueSizeLabel(['size::XXL']), {
    ok: false,
    code: 'invalid_size_label',
    reason: 'This issue has a size:: label that is not managed by issue-flow; choose one managed size label before continuing.',
    labels: ['size::XXL'],
  });
  assert.throws(
    () => validateFlowSizeGate(['size::XXL'], { flow: 'flow::build' }, [], { issueNumber: 123 }),
    /invalid size:: label: size::XXL/
  );
});
