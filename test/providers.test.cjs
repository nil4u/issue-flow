const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAgentrixGitlabBridgePayload,
  labelTitlesFromEnv,
} = require('../skills/issue-flow/scripts/events.cjs');

const {
  gitlabApiBodyArgs,
  gitlabApiBaseUrl,
  gitlabHostname,
  parseGitRemoteUrl,
  parseRepoFullName,
  resolveProvider,
} = require('../skills/issue-flow/scripts/providers.cjs');

test('provider detection accepts gitlab remotes and project paths', () => {
  assert.equal(resolveProvider({ repo: 'https://gitlab.com/group/sub/project.git' }, {}).name, 'gitlab');
  assert.equal(resolveProvider({ gitlabUrl: 'https://git.internal.example', repo: 'group/sub/project' }, {}).name, 'gitlab');
  assert.equal(resolveProvider({ repo: 'git@git.internal.example:group/sub/project.git' }, {}).name, 'gitlab');
  assert.equal(resolveProvider({ repo: 'git@github.com:group/sub/project.git' }, {}).name, 'github');
  assert.deepEqual(parseRepoFullName('git@gitlab.com:group/sub/project.git'), {
    owner: 'group/sub',
    repo: 'project',
    fullName: 'group/sub/project',
  });
});

test('agentrix GitLab bridge labels parse from JSON first', () => {
  assert.deepEqual(
    labelTitlesFromEnv({
      AGENTRIX_LABELS: 'stale',
      AGENTRIX_LABELS_JSON: '["flow::build","automation::build"]',
    }),
    ['flow::build', 'automation::build']
  );
});

test('gitlab base URL defaults from the git remote host', () => {
  assert.deepEqual(parseGitRemoteUrl('git@git.internal.example:group/sub/project.git'), {
    host: 'git.internal.example',
    baseUrl: 'https://git.internal.example',
    fullName: 'group/sub/project',
  });
  assert.equal(gitlabApiBaseUrl({ repo: 'git@git.internal.example:group/sub/project.git' }), 'https://git.internal.example/api/v4');
  assert.equal(gitlabHostname({ repo: 'ssh://git@git.internal.example/group/sub/project.git' }), 'git.internal.example');
});

test('gitlab glab fallback serializes API params as fields instead of raw input', () => {
  const args = gitlabApiBodyArgs({
    add_labels: 'flow::clarify,priority::p2',
    remove_labels: 'flow::triage',
    description: '@literal\nhello',
    confidential: true,
    weight: 0,
    milestone_id: null,
    skipped: undefined,
  });

  assert.deepEqual(args, [
    '--raw-field',
    'add_labels=flow::clarify,priority::p2',
    '--raw-field',
    'remove_labels=flow::triage',
    '--raw-field',
    'description=@literal\nhello',
    '--field',
    'confidential=true',
    '--field',
    'weight=0',
    '--field',
    'milestone_id=null',
  ]);
  assert.equal(args.includes('--input'), false);
});

test('agentrix GitLab bridge issue event normalizes to issue-flow context', () => {
  const payload = buildAgentrixGitlabBridgePayload({
    AGENTRIX_TRIGGER_SOURCE: 'agentrix_daemon_webhook',
    AGENTRIX_PROVIDER: 'gitlab',
    AGENTRIX_EVENT_NAME: 'issues',
    AGENTRIX_EVENT_ACTION: 'labeled',
    AGENTRIX_ISSUE_NUMBER: '17',
    AGENTRIX_ISSUE_TITLE: 'Support GitLab bridge',
    AGENTRIX_ISSUE_URL: 'https://gitlab.example/acme/platform/-/issues/17',
    AGENTRIX_LABELS_JSON: '["status::active","flow::build","automation::build"]',
    CI_PROJECT_ID: '42',
    CI_PROJECT_PATH: 'acme/platform',
    CI_PROJECT_URL: 'https://gitlab.example/acme/platform',
  });
  const provider = resolveProvider({ provider: 'gitlab' }, payload);

  assert.deepEqual(provider.buildIssueContext(payload, { provider: 'gitlab' }), {
    provider: 'gitlab',
    owner: 'acme',
    repo: 'platform',
    repoFullName: 'acme/platform',
    projectId: '42',
    number: 17,
    title: 'Support GitLab bridge',
    body: '',
    htmlUrl: 'https://gitlab.example/acme/platform/-/issues/17',
    state: 'open',
    author: '',
    labels: ['status::active', 'flow::build', 'automation::build'],
  });
});

test('agentrix GitLab bridge issue comment event carries note context', () => {
  const payload = buildAgentrixGitlabBridgePayload({
    AGENTRIX_TRIGGER_SOURCE: 'agentrix_daemon_webhook',
    AGENTRIX_PROVIDER: 'gitlab',
    AGENTRIX_EVENT_NAME: 'issue_comment',
    AGENTRIX_EVENT_ACTION: 'created',
    AGENTRIX_SUBJECT_KIND: 'issue',
    AGENTRIX_ISSUE_NUMBER: '17',
    AGENTRIX_COMMENT_ID: '101',
    AGENTRIX_COMMENT_BODY: '@agentrix please plan',
    AGENTRIX_COMMENT_URL: 'https://gitlab.example/acme/platform/-/issues/17#note_101',
    CI_PROJECT_ID: '42',
    CI_PROJECT_PATH: 'acme/platform',
  });
  const provider = resolveProvider({ provider: 'gitlab' }, payload);

  assert.equal(provider.isPullRequestIssue(payload), false);
  assert.deepEqual(provider.getCommentContext(payload), {
    id: 101,
    author: '',
    body: '@agentrix please plan',
    htmlUrl: 'https://gitlab.example/acme/platform/-/issues/17#note_101',
  });
  assert.equal(provider.buildIssueContext(payload, { provider: 'gitlab' }).number, 17);
});

test('gitlab issue payload normalizes to issue-flow context', () => {
  const provider = resolveProvider({ provider: 'gitlab' }, {});
  const issue = provider.buildIssueContext(
    {
      object_kind: 'issue',
      project: {
        id: 42,
        path_with_namespace: 'acme/platform',
      },
      user: {
        username: 'alice',
      },
      object_attributes: {
        iid: 17,
        title: 'Support GitLab issue flow',
        description: 'Body text',
        state: 'opened',
        url: 'https://gitlab.com/acme/platform/-/issues/17',
        labels: [{ title: 'flow::build' }, { title: 'automation::build' }],
      },
    },
    { provider: 'gitlab' }
  );

  assert.deepEqual(issue, {
    provider: 'gitlab',
    owner: 'acme',
    repo: 'platform',
    repoFullName: 'acme/platform',
    projectId: '42',
    number: 17,
    title: 'Support GitLab issue flow',
    body: 'Body text',
    htmlUrl: 'https://gitlab.com/acme/platform/-/issues/17',
    state: 'open',
    author: 'alice',
    labels: ['flow::build', 'automation::build'],
  });
});
