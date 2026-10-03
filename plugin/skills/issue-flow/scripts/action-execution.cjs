const ACTION_FIELDS = ['agent', 'model', 'reasoningEffort'];
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_AGENT = 'codex';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateActionObject(value, fieldPath) {
  if (value === null || value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new Error(`${fieldPath} must be an object.`);
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!ACTION_FIELDS.includes(field)) {
      throw new Error(`${fieldPath}.${field} is not a supported action execution field.`);
    }
    if (fieldValue === null) continue;
    if (typeof fieldValue !== 'string' || !fieldValue.trim()) {
      throw new Error(`${fieldPath}.${field} must be a non-empty string or null.`);
    }
    if (field === 'reasoningEffort' && !REASONING_EFFORTS.has(fieldValue)) {
      throw new Error(`${fieldPath}.reasoningEffort must be one of ${[...REASONING_EFFORTS].join(', ')}.`);
    }
  }
  return value;
}

function validateActionExecutionConfig(config = {}, configPath = '.issue-flow/config.json') {
  if (!isPlainObject(config)) {
    throw new Error(`${configPath}.agentrix must be an object.`);
  }
  const actions = config.actions;
  if (actions === undefined || actions === null) return {};
  if (!isPlainObject(actions)) {
    throw new Error(`${configPath}.agentrix.actions must be an object.`);
  }
  for (const [action, value] of Object.entries(actions)) {
    validateActionObject(value, `${configPath}.agentrix.actions.${action}`);
  }
  return actions;
}

function readValue(source, key) {
  if (source && Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null) {
    return source[key];
  }
  return undefined;
}

function resolveActionExecution(action, options = {}, config = {}, configPath = '.issue-flow/config.json') {
  const actions = validateActionExecutionConfig(config, configPath);
  const actionConfig = actions[action];
  const defaults = actions.defaults;
  const explicit = {};
  for (const field of ACTION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(options, field) && options[field] !== undefined && options[field] !== null) {
      explicit[field] = options[field];
    }
  }
  validateActionObject(explicit, 'runtime options');

  const values = {};
  const sources = {};
  for (const field of ACTION_FIELDS) {
    const candidates = [
      ['options', readValue(explicit, field)],
      [`actions.${action}`, readValue(actionConfig, field)],
      ['actions.defaults', readValue(defaults, field)],
    ];
    let selected = candidates.find(([, value]) => value !== undefined);
    if (!selected && field === 'agent') {
      if (process.env.AGENTRIX_ISSUE_FLOW_AGENT) {
        selected = ['AGENTRIX_ISSUE_FLOW_AGENT', process.env.AGENTRIX_ISSUE_FLOW_AGENT];
      }
      if (!selected && process.env.AGENTRIX_AGENT) selected = ['AGENTRIX_AGENT', process.env.AGENTRIX_AGENT];
      if (!selected) selected = ['built-in', DEFAULT_AGENT];
    }
    if (selected) {
      values[field] = selected[1];
      sources[field] = selected[0];
    }
  }
  return { action, values, sources };
}

module.exports = {
  ACTION_FIELDS,
  REASONING_EFFORTS,
  validateActionExecutionConfig,
  resolveActionExecution,
};
