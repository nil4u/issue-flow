const assert = require('node:assert/strict');
const test = require('node:test');

const {
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

test('gitlab base URL defaults from the git remote host', () => {
  assert.deepEqual(parseGitRemoteUrl('git@git.internal.example:group/sub/project.git'), {
    host: 'git.internal.example',
    baseUrl: 'https://git.internal.example',
    fullName: 'group/sub/project',
  });
  assert.equal(gitlabApiBaseUrl({ repo: 'git@git.internal.example:group/sub/project.git' }), 'https://git.internal.example/api/v4');
  assert.equal(gitlabHostname({ repo: 'ssh://git@git.internal.example/group/sub/project.git' }), 'git.internal.example');
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
