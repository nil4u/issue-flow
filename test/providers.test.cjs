const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAgentrixGitlabBridgePayload,
  labelTitlesFromEnv,
} = require('../skills/issue-flow/scripts/events.cjs');

const {
  extractTokenFromRemoteUrl,
  gitlabApiBodyArgs,
  gitlabApiBaseUrl,
  gitlabHostname,
  labelMatchesDefinition,
  parseGitRemoteUrl,
  parseRepoFullName,
  planLabelSync,
  providerLabelDefinition,
  requestGitlab,
  resolveProvider,
} = require('../skills/issue-flow/scripts/providers.cjs');
const { labelDefinitionFor } = require('../skills/issue-flow/scripts/labels.cjs');

function withTemporaryEnv(values, fn) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

function createBodyFile(content = 'Body') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-test-body-'));
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, content, 'utf8');
  return {
    path: bodyFile,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createFakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-fake-gh-'));
  const logPath = path.join(dir, 'gh.log');
  const ghPath = path.join(dir, 'gh');
  fs.writeFileSync(
    ghPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.ISSUE_FLOW_GH_LOG, `${JSON.stringify(args)}\\n`, 'utf8');",
      "if (args[0] === 'api' && /\\/issues$/.test(args[1])) {",
      "  console.log(JSON.stringify({ number: 12, html_url: 'https://github.com/acme-org/webapp/issues/12', title: 'Created issue', labels: [{ name: 'type::feature' }] }));",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'pr' && args[1] === 'create') {",
      "  console.log('https://github.com/acme-org/webapp/pull/7');",
      '}',
    ].join('\n'),
    { mode: 0o755 }
  );
  return {
    path: ghPath,
    dir,
    logPath,
    readCalls: () =>
      fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [],
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function createFakeGlab() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-fake-glab-'));
  const logPath = path.join(dir, 'glab.log');
  const glabPath = path.join(dir, 'glab');
  fs.writeFileSync(
    glabPath,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.ISSUE_FLOW_GLAB_LOG, `${JSON.stringify(args)}\\n`, 'utf8');",
      "console.log('{}');",
    ].join('\n'),
    { mode: 0o755 }
  );
  return {
    dir,
    logPath,
    readCalls: () =>
      fs.existsSync(logPath)
        ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [],
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

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

test('remote token extraction ignores username-only HTTPS remotes', () => {
  assert.equal(extractTokenFromRemoteUrl('https://alice-dev@github.com/acme/webapp.git'), '');
  assert.equal(extractTokenFromRemoteUrl('https://git@gitlab.com/acme/webapp.git'), '');
  assert.equal(extractTokenFromRemoteUrl('https://x-access-token:ghp_1234567890abcdef@github.com/acme/webapp.git'), 'ghp_1234567890abcdef');
  assert.equal(extractTokenFromRemoteUrl('https://oauth2:glpat-1234567890abcdef@gitlab.com/acme/webapp.git'), 'glpat-1234567890abcdef');
  assert.equal(extractTokenFromRemoteUrl('https://github_pat_1234567890abcdef@github.com/acme/webapp.git'), 'github_pat_1234567890abcdef');
});

test('github submit operations use token API without gh CLI', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const bodyFile = createBodyFile('Token body');
  const previousFetch = global.fetch;
  const calls = [];

  await withTemporaryEnv(
    {
      GITHUB_TOKEN: 'token-123',
      GH_TOKEN: undefined,
      PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-empty-path-')),
    },
    async () => {
      global.fetch = async (url, init = {}) => {
        const parsedBody = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url: String(url), method: init.method, body: parsedBody });

        if (String(url).endsWith('/labels/mr-by%3A%3Abuild') && init.method === 'GET') {
          return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'Not Found' }) };
        }
        if (String(url).endsWith('/labels') && init.method === 'POST') {
          return { ok: true, status: 201, text: async () => JSON.stringify({ name: parsedBody.name }) };
        }
        if (String(url).includes('/pulls?') && init.method === 'GET') {
          return { ok: true, status: 200, text: async () => JSON.stringify([]) };
        }
        if (String(url).endsWith('/pulls') && init.method === 'POST') {
          return { ok: true, status: 201, text: async () => JSON.stringify({ number: 482, html_url: 'https://github.com/acme-org/webapp/pull/482' }) };
        }
        if (String(url).endsWith('/issues/482/labels') && init.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ name: parsedBody.labels[0] }]) };
        }

        throw new Error(`Unexpected GitHub API call: ${init.method} ${url}`);
      };

      await provider.ensurePullRequestLabel(repo, 'mr-by::build', {
        labelColor: '1D76DB',
        labelDescription: 'PR or MR was created by the build action',
      });
      const url = await provider.createOrUpdatePullRequest({
        repo,
        title: 'Build #7: Token first',
        bodyFile: bodyFile.path,
        label: 'mr-by::build',
        baseBranch: 'main',
        headBranch: '7-token-first/build',
        draft: true,
        options: {},
      });

      assert.equal(url, 'https://github.com/acme-org/webapp/pull/482');
    }
  );

  global.fetch = previousFetch;
  bodyFile.cleanup();

  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ['GET', '/repos/acme-org/webapp/labels/mr-by%3A%3Abuild'],
      ['POST', '/repos/acme-org/webapp/labels'],
      ['GET', '/repos/acme-org/webapp/pulls'],
      ['POST', '/repos/acme-org/webapp/pulls'],
      ['POST', '/repos/acme-org/webapp/issues/482/labels'],
    ]
  );
  assert.equal(calls[3].body.draft, true);
  assert.equal(calls[3].body.body, 'Token body');
});

test('github submit operations fallback to gh CLI only when token is missing', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const bodyFile = createBodyFile('Fallback body');
  const fakeGh = createFakeGh();
  const previousFetch = global.fetch;

  await withTemporaryEnv(
    {
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      PATH: fakeGh.dir,
      ISSUE_FLOW_GH_LOG: fakeGh.logPath,
    },
    async () => {
      global.fetch = async () => {
        throw new Error('GitHub API should not be called without a token');
      };

      await provider.ensurePullRequestLabel(repo, 'mr-by::plan', {
        labelColor: '0052CC',
        labelDescription: 'PR or MR was created by the plan action',
      });
      const url = await provider.createOrUpdatePullRequest({
        repo,
        title: 'Plan #7: CLI fallback',
        bodyFile: bodyFile.path,
        label: 'mr-by::plan',
        baseBranch: 'main',
        headBranch: '7-token-first/plan',
        draft: false,
        options: {},
      });

      assert.equal(url, 'https://github.com/acme-org/webapp/pull/7');
    }
  );

  global.fetch = previousFetch;
  bodyFile.cleanup();

  assert.deepEqual(
    fakeGh.readCalls().map((args) => args.slice(0, 2)),
    [
      ['label', 'list'],
      ['label', 'create'],
      ['pr', 'list'],
      ['pr', 'list'],
      ['api', '--method'],
      ['pr', 'create'],
    ]
  );
  fakeGh.cleanup();
});

test('github create issue uses token API with labels in the create request', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const previousFetch = global.fetch;
  const calls = [];

  await withTemporaryEnv(
    {
      GITHUB_TOKEN: 'token-123',
      GH_TOKEN: undefined,
    },
    async () => {
      global.fetch = async (url, init = {}) => {
        const parsedBody = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url: String(url), method: init.method, body: parsedBody });
        assert.equal(init.method, 'POST');
        assert.deepEqual(parsedBody.labels, ['type::feature', 'status::active', 'flow::plan']);
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              number: 31,
              title: parsedBody.title,
              body: parsedBody.body,
              html_url: 'https://github.com/acme-org/webapp/issues/31',
              state: 'open',
              labels: parsedBody.labels.map((name) => ({ name })),
            }),
        };
      };

      const issue = await provider.createIssue({
        repo,
        title: 'Create issue support',
        body: 'Body',
        labels: ['type::feature', 'status::active', 'flow::plan'],
        options: {},
      });

      assert.equal(issue.number, 31);
      assert.equal(issue.htmlUrl, 'https://github.com/acme-org/webapp/issues/31');
      assert.deepEqual(issue.labels, ['type::feature', 'status::active', 'flow::plan']);
    }
  );

  global.fetch = previousFetch;
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ['POST', '/repos/acme-org/webapp/issues'],
  ]);
});

test('github create issue falls back to gh api when token is missing', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const fakeGh = createFakeGh();
  const previousFetch = global.fetch;

  await withTemporaryEnv(
    {
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      PATH: fakeGh.dir,
      ISSUE_FLOW_GH_LOG: fakeGh.logPath,
    },
    async () => {
      global.fetch = async () => {
        throw new Error('GitHub API should not be called without a token');
      };
      const issue = await provider.createIssue({
        repo,
        title: 'Created issue',
        body: 'Body',
        labels: ['type::feature'],
        options: {},
      });
      assert.equal(issue.number, 12);
      assert.equal(issue.htmlUrl, 'https://github.com/acme-org/webapp/issues/12');
    }
  );

  global.fetch = previousFetch;
  assert.deepEqual(fakeGh.readCalls()[0].slice(0, 3), ['api', 'repos/acme-org/webapp/issues', '-X']);
  fakeGh.cleanup();
});

test('github token authorization failure does not fallback to gh CLI', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const fakeGh = createFakeGh();
  const previousFetch = global.fetch;

  await assert.rejects(
    withTemporaryEnv(
      {
        GITHUB_TOKEN: 'bad-token',
        GH_TOKEN: undefined,
        PATH: fakeGh.dir,
        ISSUE_FLOW_GH_LOG: fakeGh.logPath,
      },
      async () => {
        global.fetch = async () => ({
          ok: false,
          status: 401,
          text: async () => JSON.stringify({ message: 'Bad credentials' }),
        });

        await provider.ensurePullRequestLabel(repo, 'mr-by::build', {
          labelColor: '1D76DB',
          labelDescription: 'PR or MR was created by the build action',
        });
      }
    ),
    /Bad credentials/
  );

  global.fetch = previousFetch;
  assert.deepEqual(fakeGh.readCalls(), []);
  fakeGh.cleanup();
});

test('gitlab token request failures do not fallback to glab CLI', async () => {
  const fakeGlab = createFakeGlab();
  const previousFetch = global.fetch;

  await assert.rejects(
    withTemporaryEnv(
      {
        GITLAB_TOKEN: 'token-123',
        GL_TOKEN: undefined,
        GITLAB_PRIVATE_TOKEN: undefined,
        CI_JOB_TOKEN: undefined,
        PATH: fakeGlab.dir,
        ISSUE_FLOW_GLAB_LOG: fakeGlab.logPath,
      },
      async () => {
        global.fetch = async () => {
          throw new Error('network unavailable');
        };

        await requestGitlab('GET', '/projects/acme%2Fwebapp/issues/7');
      }
    ),
    /network unavailable/
  );

  global.fetch = previousFetch;
  assert.deepEqual(fakeGlab.readCalls(), []);
  fakeGlab.cleanup();
});

test('github API duplicate PR response updates the existing pull request', async () => {
  const provider = resolveProvider({ provider: 'github' }, {});
  const repo = { owner: 'acme-org', repo: 'webapp', fullName: 'acme-org/webapp' };
  const bodyFile = createBodyFile('Duplicate body');
  const previousFetch = global.fetch;
  const calls = [];
  let pullListCount = 0;

  await withTemporaryEnv(
    {
      GITHUB_TOKEN: 'token-123',
      GH_TOKEN: undefined,
    },
    async () => {
      global.fetch = async (url, init = {}) => {
        const parsedBody = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url: String(url), method: init.method, body: parsedBody });

        if (String(url).includes('/pulls?') && init.method === 'GET') {
          pullListCount += 1;
          const items =
            pullListCount === 1
              ? []
              : [{ number: 99, html_url: 'https://github.com/acme-org/webapp/pull/99' }];
          return { ok: true, status: 200, text: async () => JSON.stringify(items) };
        }
        if (String(url).endsWith('/pulls') && init.method === 'POST') {
          return {
            ok: false,
            status: 422,
            text: async () =>
              JSON.stringify({
                message: 'Validation Failed',
                errors: [{ message: 'A pull request already exists for acme-org:7-token-first/build.' }],
              }),
          };
        }
        if (String(url).endsWith('/pulls/99') && init.method === 'PATCH') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ html_url: 'https://github.com/acme-org/webapp/pull/99' }) };
        }
        if (String(url).endsWith('/issues/99/labels') && init.method === 'POST') {
          return { ok: true, status: 200, text: async () => JSON.stringify([{ name: parsedBody.labels[0] }]) };
        }

        throw new Error(`Unexpected GitHub API call: ${init.method} ${url}`);
      };

      const url = await provider.createOrUpdatePullRequest({
        repo,
        title: 'Build #7: Duplicate update',
        bodyFile: bodyFile.path,
        label: 'mr-by::build',
        baseBranch: 'main',
        headBranch: '7-token-first/build',
        draft: false,
        options: {},
      });

      assert.equal(url, 'https://github.com/acme-org/webapp/pull/99');
    }
  );

  global.fetch = previousFetch;
  bodyFile.cleanup();

  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname]),
    [
      ['GET', '/repos/acme-org/webapp/pulls'],
      ['POST', '/repos/acme-org/webapp/pulls'],
      ['GET', '/repos/acme-org/webapp/pulls'],
      ['PATCH', '/repos/acme-org/webapp/pulls/99'],
      ['POST', '/repos/acme-org/webapp/issues/99/labels'],
    ]
  );
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

test('gitlab create issue preflights managed labels before creating', async () => {
  const provider = resolveProvider({ provider: 'gitlab' }, {});
  const repo = { owner: 'acme', repo: 'platform', fullName: 'acme/platform' };
  const previousFetch = global.fetch;
  const calls = [];

  await withTemporaryEnv(
    {
      GITLAB_TOKEN: 'token-123',
      GL_TOKEN: undefined,
      GITLAB_PRIVATE_TOKEN: undefined,
      CI_JOB_TOKEN: undefined,
    },
    async () => {
      global.fetch = async (url, init = {}) => {
        const parsedBody = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url: String(url), method: init.method, body: parsedBody });
        const pathname = new URL(String(url)).pathname;

        if (pathname.includes('/labels/') && init.method === 'GET') {
          const labelName = decodeURIComponent(pathname.split('/labels/')[1]);
          const definition = labelDefinitionFor(labelName);
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                name: definition.name,
                color: `#${definition.color}`,
                description: definition.description,
              }),
          };
        }

        if (pathname.endsWith('/issues') && init.method === 'POST') {
          assert.deepEqual(parsedBody, {
            title: 'Create GitLab issue',
            description: 'Body',
            labels: 'type::feature,status::active,flow::build',
          });
          return {
            ok: true,
            status: 201,
            text: async () =>
              JSON.stringify({
                iid: 41,
                title: parsedBody.title,
                description: parsedBody.description,
                web_url: 'https://gitlab.com/acme/platform/-/issues/41',
                state: 'opened',
                labels: parsedBody.labels.split(','),
              }),
          };
        }

        throw new Error(`Unexpected GitLab API call: ${init.method} ${url}`);
      };

      const issue = await provider.createIssue({
        repo,
        title: 'Create GitLab issue',
        body: 'Body',
        labels: ['type::feature', 'status::active', 'flow::build'],
        managedLabelDefinitions: [
          labelDefinitionFor('type::feature'),
          labelDefinitionFor('status::active'),
          labelDefinitionFor('flow::build'),
        ],
        options: {},
      });

      assert.equal(issue.number, 41);
      assert.deepEqual(issue.labels, ['type::feature', 'status::active', 'flow::build']);
    }
  );

  global.fetch = previousFetch;
  assert.deepEqual(
    calls.map((call) => [call.method, new URL(call.url).pathname.replace(/.*\/labels\/.*/, '/labels/:name')]),
    [
      ['GET', '/labels/:name'],
      ['GET', '/labels/:name'],
      ['GET', '/labels/:name'],
      ['POST', '/api/v4/projects/acme%2Fplatform/issues'],
    ]
  );
});

test('gitlab create issue fails before create when managed label drifts', async () => {
  const provider = resolveProvider({ provider: 'gitlab' }, {});
  const repo = { owner: 'acme', repo: 'platform', fullName: 'acme/platform' };
  const previousFetch = global.fetch;
  const calls = [];

  await assert.rejects(
    withTemporaryEnv(
      {
        GITLAB_TOKEN: 'token-123',
        GL_TOKEN: undefined,
        GITLAB_PRIVATE_TOKEN: undefined,
        CI_JOB_TOKEN: undefined,
      },
      async () => {
        global.fetch = async (url, init = {}) => {
          calls.push({ url: String(url), method: init.method });
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                name: 'flow::build',
                color: '#000000',
                description: 'Wrong',
              }),
          };
        };

        await provider.createIssue({
          repo,
          title: 'Drifted label',
          body: 'Body',
          labels: ['flow::build'],
          managedLabelDefinitions: [labelDefinitionFor('flow::build')],
          options: {},
        });
      }
    ),
    /Run sync-labels\.cjs before create-issue\.cjs/
  );

  global.fetch = previousFetch;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
});

test('provider label definitions use GitHub and GitLab color formats', () => {
  const definition = {
    name: 'priority::p0',
    color: 'B60205',
    description: 'Highest priority issue',
  };

  assert.deepEqual(providerLabelDefinition('github', definition), {
    name: 'priority::p0',
    color: 'B60205',
    description: 'Highest priority issue',
  });
  assert.deepEqual(providerLabelDefinition('gitlab', definition), {
    name: 'priority::p0',
    color: '#B60205',
    description: 'Highest priority issue',
  });
});

test('provider label sync planning detects missing drift and current labels', () => {
  const definition = {
    name: 'flow::build',
    color: '1D76DB',
    description: 'Waiting for implementation',
  };

  assert.equal(planLabelSync('github', undefined, definition), 'create');
  assert.equal(
    planLabelSync('github', { name: 'flow::build', color: '000000', description: 'Waiting for implementation' }, definition),
    'update'
  );
  assert.equal(
    planLabelSync('gitlab', { name: 'flow::build', color: '#1d76db', description: 'Waiting for implementation' }, definition),
    'skip'
  );
  assert.equal(
    labelMatchesDefinition('gitlab', { name: 'flow::build', color: '#1d76db', description: 'Waiting for implementation' }, definition),
    true
  );
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
