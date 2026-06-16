const fs = require('node:fs');

const AGENTRIX_GITLAB_TRIGGER_SOURCE = 'agentrix_daemon_webhook';

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseJsonArray(value) {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function splitProjectPath(projectPath) {
  const parts = String(projectPath || '').split('/').filter(Boolean);
  return {
    owner: parts.slice(0, -1).join('/'),
    name: parts[parts.length - 1] || '',
  };
}

function agentrixProjectPath(env = process.env) {
  if (env.CI_PROJECT_PATH) {
    return env.CI_PROJECT_PATH;
  }
  if (env.GITLAB_PROJECT_PATH) {
    return env.GITLAB_PROJECT_PATH;
  }
  if (env.AGENTRIX_REPOSITORY_OWNER && env.AGENTRIX_REPOSITORY_NAME) {
    return `${env.AGENTRIX_REPOSITORY_OWNER}/${env.AGENTRIX_REPOSITORY_NAME}`;
  }
  return '';
}

function labelTitlesFromEnv(env = process.env) {
  const parsed = parseJsonArray(env.AGENTRIX_LABELS_JSON);
  if (parsed) {
    return parsed.map((label) => {
      if (typeof label === 'string') {
        return label;
      }
      if (label && typeof label.title === 'string') {
        return label.title;
      }
      if (label && typeof label.name === 'string') {
        return label.name;
      }
      return '';
    }).filter(Boolean);
  }
  return String(env.AGENTRIX_LABELS || '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

function labelsFromEnv(env = process.env) {
  return labelTitlesFromEnv(env).map((title) => ({ title }));
}

function buildGitlabBridgeProject(env = process.env) {
  const projectPath = agentrixProjectPath(env);
  const { name } = splitProjectPath(projectPath);
  return {
    id: parsePositiveInteger(env.CI_PROJECT_ID),
    path: name,
    path_with_namespace: projectPath,
    default_branch: env.CI_DEFAULT_BRANCH || env.AGENTRIX_BASE_REF || env.CI_COMMIT_REF_NAME || '',
    web_url: env.CI_PROJECT_URL || '',
  };
}

function issueProviderAction(action) {
  if (action === 'opened') return 'open';
  if (action === 'closed') return 'close';
  if (action === 'reopened') return 'reopen';
  return action ? 'update' : undefined;
}

function noteProviderAction(action) {
  if (action === 'created') return 'create';
  if (action === 'edited') return 'update';
  if (action === 'deleted') return 'delete';
  return action;
}

function mergeRequestProviderAction(action, env = process.env) {
  if (action === 'opened') return 'open';
  if (action === 'reopened') return 'reopen';
  if (action === 'closed' && env.AGENTRIX_PULL_REQUEST_MERGED === 'true') return 'merge';
  if (action === 'closed') return 'close';
  if (action === 'synchronize') return 'update';
  return action;
}

function buildGitlabBridgeIssuePayload(env = process.env, project = buildGitlabBridgeProject(env)) {
  const action = env.AGENTRIX_EVENT_ACTION || '';
  const issueNumber = parsePositiveInteger(env.AGENTRIX_ISSUE_NUMBER);
  if (!issueNumber) {
    return undefined;
  }

  const issue = {
    iid: issueNumber,
    title: env.AGENTRIX_ISSUE_TITLE || '',
    description: env.AGENTRIX_ISSUE_BODY || '',
    action: issueProviderAction(action),
    state: action === 'closed' ? 'closed' : 'opened',
    url: env.AGENTRIX_ISSUE_URL || '',
    labels: labelsFromEnv(env),
  };

  return {
    event_type: 'issue',
    object_kind: 'issue',
    project,
    object_attributes: issue,
    labels: issue.labels,
    user: {
      username: env.GITLAB_USER_LOGIN || env.GITLAB_USER_NAME || '',
    },
  };
}

function buildGitlabBridgeNotePayload(env = process.env, project = buildGitlabBridgeProject(env)) {
  const action = env.AGENTRIX_EVENT_ACTION || '';
  const subjectKind = env.AGENTRIX_SUBJECT_KIND || (env.AGENTRIX_PR_NUMBER ? 'pull_request' : 'issue');
  const noteableType = subjectKind === 'pull_request' ? 'MergeRequest' : 'Issue';
  const issueNumber = parsePositiveInteger(env.AGENTRIX_ISSUE_NUMBER);
  const mergeRequestNumber = parsePositiveInteger(env.AGENTRIX_PR_NUMBER);
  const subjectNumber = subjectKind === 'pull_request' ? mergeRequestNumber : issueNumber;
  if (!subjectNumber) {
    return undefined;
  }

  const payload = {
    event_type: 'note',
    object_kind: 'note',
    project,
    object_attributes: {
      id: parsePositiveInteger(env.AGENTRIX_COMMENT_ID) || env.AGENTRIX_COMMENT_ID,
      action: noteProviderAction(action),
      note: env.AGENTRIX_COMMENT_BODY || '',
      noteable_type: env.AGENTRIX_GITLAB_NOTEABLE_TYPE || noteableType,
      url: env.AGENTRIX_COMMENT_URL || '',
    },
    user: {
      username: env.GITLAB_USER_LOGIN || env.GITLAB_USER_NAME || '',
      bot: false,
    },
  };

  if (subjectKind === 'pull_request') {
    payload.merge_request = {
      iid: mergeRequestNumber,
      source_branch: env.AGENTRIX_HEAD_REF || '',
      target_branch: env.AGENTRIX_BASE_REF || '',
    };
  } else {
    payload.issue = {
      iid: issueNumber,
      title: env.AGENTRIX_ISSUE_TITLE || '',
      description: env.AGENTRIX_ISSUE_BODY || '',
      state: 'opened',
      url: env.AGENTRIX_ISSUE_URL || '',
      labels: labelsFromEnv(env),
    };
  }

  return payload;
}

function buildGitlabBridgeMergeRequestPayload(env = process.env, project = buildGitlabBridgeProject(env)) {
  const action = env.AGENTRIX_EVENT_ACTION || '';
  const mergeRequestNumber = parsePositiveInteger(env.AGENTRIX_PR_NUMBER);
  if (!mergeRequestNumber) {
    return undefined;
  }

  const merged = env.AGENTRIX_PULL_REQUEST_MERGED === 'true';
  const attrs = {
    iid: mergeRequestNumber,
    title: env.AGENTRIX_MR_TITLE || '',
    description: env.AGENTRIX_PR_BODY || env.AGENTRIX_MR_DESCRIPTION || '',
    action: mergeRequestProviderAction(action, env),
    state: merged ? 'merged' : action === 'closed' ? 'closed' : 'opened',
    source_branch: env.AGENTRIX_HEAD_REF || '',
    target_branch: env.AGENTRIX_BASE_REF || '',
    last_commit: env.AGENTRIX_HEAD_SHA || env.CI_COMMIT_SHA ? { id: env.AGENTRIX_HEAD_SHA || env.CI_COMMIT_SHA } : undefined,
    url: env.AGENTRIX_MR_URL || '',
    labels: labelsFromEnv(env),
  };

  return {
    event_type: 'merge_request',
    object_kind: 'merge_request',
    project,
    object_attributes: attrs,
    labels: attrs.labels,
    user: {
      username: env.GITLAB_USER_LOGIN || env.GITLAB_USER_NAME || '',
    },
  };
}

function isAgentrixGitlabBridgeEnv(env = process.env) {
  return env.AGENTRIX_TRIGGER_SOURCE === AGENTRIX_GITLAB_TRIGGER_SOURCE && env.AGENTRIX_PROVIDER === 'gitlab';
}

function buildAgentrixGitlabBridgePayload(env = process.env) {
  if (!isAgentrixGitlabBridgeEnv(env)) {
    return undefined;
  }

  const project = buildGitlabBridgeProject(env);
  switch (env.AGENTRIX_EVENT_NAME) {
    case 'issues':
      return buildGitlabBridgeIssuePayload(env, project);
    case 'issue_comment':
    case 'pull_request_review_comment':
      return buildGitlabBridgeNotePayload(env, project);
    case 'pull_request':
    case 'pull_request_review':
      return buildGitlabBridgeMergeRequestPayload(env, project);
    default:
      return undefined;
  }
}

function resolveEventPath(options = {}, env = process.env) {
  return options.event || env.GITHUB_EVENT_PATH || env.GITLAB_EVENT_PATH || '';
}

function loadEventPayload(options = {}, env = process.env) {
  const eventPath = resolveEventPath(options, env);
  if (eventPath) {
    return {
      source: 'file',
      eventPath,
      payload: readJsonFile(eventPath),
    };
  }

  const payload = buildAgentrixGitlabBridgePayload(env);
  if (payload) {
    return {
      source: 'agentrix-gitlab-bridge',
      eventPath: '',
      payload,
    };
  }

  return {
    source: 'empty',
    eventPath: '',
    payload: {},
  };
}

module.exports = {
  AGENTRIX_GITLAB_TRIGGER_SOURCE,
  buildAgentrixGitlabBridgePayload,
  buildGitlabBridgeIssuePayload,
  buildGitlabBridgeMergeRequestPayload,
  buildGitlabBridgeNotePayload,
  isAgentrixGitlabBridgeEnv,
  labelTitlesFromEnv,
  loadEventPayload,
  readJsonFile,
  resolveEventPath,
};
