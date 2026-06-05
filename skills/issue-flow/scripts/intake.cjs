const DEFAULT_STATUS_LABEL = 'status::active';
const DEFAULT_FLOW_LABEL = 'flow::triage';
const STATUS_PREFIX = 'status::';
const FLOW_PREFIX = 'flow::';

function normalizeLabelName(label) {
  if (typeof label === 'string') {
    return label;
  }
  if (label && typeof label.name === 'string') {
    return label.name;
  }
  return '';
}

function computeIssueIntakeLabels(currentLabels, options = {}) {
  const statusLabel = options.statusLabel || DEFAULT_STATUS_LABEL;
  const flowLabel = options.flowLabel || DEFAULT_FLOW_LABEL;
  const labels = currentLabels.map(normalizeLabelName).filter(Boolean);
  const hasStatus = labels.some((label) => label.startsWith(STATUS_PREFIX));
  const hasFlow = labels.some((label) => label.startsWith(FLOW_PREFIX));
  const labelsToAdd = [];

  if (!hasStatus) {
    labelsToAdd.push(statusLabel);
  }
  if (!hasFlow) {
    labelsToAdd.push(flowLabel);
  }

  return labelsToAdd.filter((label, index) => labelsToAdd.indexOf(label) === index);
}

module.exports = async function applyIssueIntakeLabels({ core, github, context }) {
  const issue = context.payload.issue;
  if (!issue) {
    core.info('No issue payload found; skipping intake labels.');
    return { added: [] };
  }

  const currentLabelsResponse = await github.rest.issues.listLabelsOnIssue({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issue.number,
    per_page: 100,
  });
  const currentLabels = currentLabelsResponse.data.map(normalizeLabelName).filter(Boolean);
  const labelsToAdd = computeIssueIntakeLabels(currentLabels);

  core.info(`Current labels: ${currentLabels.join(', ') || '(none)'}`);
  core.info(`Intake labels to add: ${labelsToAdd.join(', ') || '(none)'}`);

  if (labelsToAdd.length > 0) {
    await github.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: issue.number,
      labels: labelsToAdd,
    });
  }

  return { added: labelsToAdd };
};

module.exports.computeIssueIntakeLabels = computeIssueIntakeLabels;
