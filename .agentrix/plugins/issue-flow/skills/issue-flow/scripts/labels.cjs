const MANAGED_LABEL_GROUPS = {
  type: {
    prefix: 'type::',
    scope: 'issue',
    labels: [
      {
        name: 'type::feature',
        color: '0E8A16',
        description: 'Issue is a feature or enhancement',
      },
      {
        name: 'type::bug',
        color: 'D73A4A',
        description: 'Issue reports a defect or regression',
      },
      {
        name: 'type::debt',
        color: '5319E7',
        description: 'Issue tracks technical debt or cleanup',
      },
      {
        name: 'type::ops',
        color: '1D76DB',
        description: 'Issue tracks operations or maintenance work',
      },
    ],
  },
  status: {
    prefix: 'status::',
    scope: 'issue',
    labels: [
      {
        name: 'status::active',
        color: '0052CC',
        description: 'Issue is active and eligible for workflow actions',
      },
      {
        name: 'status::done',
        color: '0E8A16',
        description: 'Issue is complete',
      },
      {
        name: 'status::drop',
        color: '6A737D',
        description: 'Issue has been dropped and should not continue',
      },
      {
        name: 'status::suspend',
        color: 'FBCA04',
        description: 'Issue is suspended until conditions change',
      },
    ],
  },
  flow: {
    prefix: 'flow::',
    scope: 'issue',
    labels: [
      {
        name: 'flow::triage',
        color: 'BFDADC',
        description: 'Waiting for triage',
      },
      {
        name: 'flow::plan',
        color: '0052CC',
        description: 'Waiting for a plan action',
      },
      {
        name: 'flow::build',
        color: '1D76DB',
        description: 'Waiting for implementation',
      },
      {
        name: 'flow::clarify',
        color: 'D4C5F9',
        description: 'Waiting for clarification',
      },
      {
        name: 'flow::approve',
        color: '0E8A16',
        description: 'Waiting for approval of a plan or build PR/MR',
      },
    ],
  },
  automation: {
    prefix: 'automation::',
    scope: 'issue',
    labels: [
      {
        name: 'automation::off',
        color: '6A737D',
        description: 'Automation is explicitly disabled for this issue',
      },
      {
        name: 'automation::plan',
        color: '7057FF',
        description: 'Automation may create plan PRs/MRs',
      },
      {
        name: 'automation::build',
        color: '006B75',
        description: 'Automation may create plan and build PRs/MRs',
      },
    ],
  },
  priority: {
    prefix: 'priority::',
    scope: 'issue',
    labels: [
      {
        name: 'priority::p0',
        color: 'B60205',
        description: 'Highest priority issue',
      },
      {
        name: 'priority::p1',
        color: 'D93F0B',
        description: 'High priority issue',
      },
      {
        name: 'priority::p2',
        color: 'FBCA04',
        description: 'Normal priority issue',
      },
      {
        name: 'priority::p3',
        color: 'C5DEF5',
        description: 'Low priority issue',
      },
    ],
  },
  'mr-by': {
    prefix: 'mr-by::',
    scope: 'merge_request',
    labels: [
      {
        name: 'mr-by::plan',
        color: '0052CC',
        description: 'PR or MR was created by the plan action',
      },
      {
        name: 'mr-by::build',
        color: '1D76DB',
        description: 'PR or MR was created by the build action',
      },
    ],
  },
};

const MANAGED_LABELS = Object.freeze(
  Object.values(MANAGED_LABEL_GROUPS)
    .flatMap((group) =>
      group.labels.map((label) => ({
        ...label,
        scope: group.scope,
        group: group.prefix.replace(/::$/, ''),
        prefix: group.prefix,
      }))
    )
    .map((label) => Object.freeze(label))
);

const LABEL_BY_NAME = new Map(MANAGED_LABELS.map((label) => [label.name, label]));

function labelsForScope(scope = 'all') {
  if (scope === 'all') {
    return MANAGED_LABELS;
  }
  return MANAGED_LABELS.filter((label) => label.scope === scope);
}

function labelDefinitionFor(name) {
  return LABEL_BY_NAME.get(name);
}

function labelGroupsForScope(scope) {
  const entries = Object.entries(MANAGED_LABEL_GROUPS).filter(([, group]) => !scope || group.scope === scope);
  return Object.fromEntries(
    entries.map(([key, group]) => [
      key,
      {
        prefix: group.prefix,
        scope: group.scope,
        values: group.labels.map((label) => label.name),
      },
    ])
  );
}

module.exports = {
  MANAGED_LABEL_GROUPS,
  MANAGED_LABELS,
  labelDefinitionFor,
  labelGroupsForScope,
  labelsForScope,
};
