const assert = require('node:assert/strict');
const test = require('node:test');
const { runReviewComment, runComment } = require('../skills/issue-flow/scripts/dispatch.cjs');
const { providers } = require('../skills/issue-flow/scripts/providers.cjs');
const { buildGitlabBridgePayload } = require('../skills/issue-flow/scripts/events.cjs');
const agentrix = require('../skills/issue-flow/scripts/runtimes/agentrix.cjs');

async function withBlacklist(value, callback) {
  const previous = process.env.ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST;
  process.env.ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST = value;
  try { await callback(); } finally {
    if (previous === undefined) delete process.env.ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST;
    else process.env.ISSUE_FLOW_COMMENT_AUTHOR_BLACKLIST = previous;
  }
}

function payloadFor(provider, author, ordinary = false) {
  const body = '<!-- issue-flow:source source_task_id=task-123 source_runtime=agentrix -->';
  if (provider === 'gitlab') return {
    object_kind: 'note', user: author,
    project: { id: 42, path_with_namespace: 'team/app' },
    object_attributes: { id: 101, action: 'create', noteable_type: 'MergeRequest', note: 'ci-bot in body', ...(ordinary ? {} : { position: { new_path: 'app.js', new_line: 1 } }) },
    merge_request: { iid: 9, state: 'opened', title: 'Build', description: body, labels: ['mr-by::build', 'review::off'] },
  };
  const pr = { number: 9, state: 'open', title: 'Build', body, labels: ['mr-by::build', 'review::off'] };
  return {
    action: 'created', repository: { full_name: 'team/app' },
    comment: { id: 101, user: author, body: 'ci-bot in body' },
    ...(ordinary ? { issue: { ...pr, pull_request: {} } } : { pull_request: pr }),
  };
}

for (const provider of ['github', 'gitlab']) {
  test(`${provider} filters repeated ordinary and inline comments before provider or runtime effects`, async (t) => {
    for (const method of ['fetchCurrentPullRequest', 'addReviewCommentReaction', 'createPullRequestComment', 'listPullRequestComments']) {
      t.mock.method(providers[provider], method, () => assert.fail(`unexpected ${method}`));
    }
    t.mock.method(agentrix, 'resumeTask', () => assert.fail('unexpected resume'));
    await withBlacklist(' CI-bot,security-bot ', async () => {
      for (const ordinary of [true, false]) {
        const user = provider === 'github' ? { login: 'ci-BOT', type: 'User' } : { username: 'ci-BOT', name: 'Human' };
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.deepEqual(await runReviewComment({ provider }, { payload: payloadFor(provider, user, ordinary) }), {
            action: 'skipped', reason: 'comment_author_blacklisted', reviewComment: '101',
          });
        }
      }
    });
  });

  test(`${provider} preserves unblocked review resumes, including review::off`, async () => {
    const users = provider === 'github' ? [{ login: 'human' }, undefined] : [{ username: 'human', name: 'ci-bot' }, undefined];
    await withBlacklist('ci-bot', async () => {
      for (const author of users) {
        const result = await runReviewComment({ provider, dryRun: true, gitlabToken: 'test' }, { payload: payloadFor(provider, author) });
        assert.equal(result.action, 'task_resume');
      }
    });
  });

  test(`${provider} filters issue mentions before acknowledging or starting a task`, async (t) => {
    t.mock.method(providers[provider], 'addTriggerCommentReaction', () => assert.fail('unexpected acknowledge'));
    t.mock.method(agentrix, 'resumeTask', () => assert.fail('unexpected resume'));
    const payload = provider === 'github'
      ? { action: 'created', issue: { number: 42 }, comment: { id: 101, user: { login: 'ci-bot' }, body: '@agentrix fix this' } }
      : { object_kind: 'note', user: { username: 'ci-bot' }, project: { id: 42, path_with_namespace: 'team/app' }, issue: { iid: 42 }, object_attributes: { id: 101, action: 'create', noteable_type: 'Issue', note: '@agentrix fix this' } };
    await withBlacklist('ci-bot', async () => {
      assert.equal((await runComment({ provider }, { payload })).reason, 'comment_author_blacklisted');
    });
  });
}

test('blacklist uses literal complete account names and ignores empty entries', async () => {
  const { parseCommentAuthorBlacklist, commentAuthorSkipReason } = require('../skills/issue-flow/scripts/comment-policy.cjs');
  assert.deepEqual(parseCommentAuthorBlacklist(' CI-Bot,\nci-bot,security-bot\r\n,github-actions[bot] '), ['ci-bot', 'security-bot', 'github-actions[bot]']);
  await withBlacklist('ci-bot,github-actions[bot]', async () => {
    for (const author of [' ci-BOT ', 'github-actions[bot]']) {
      assert.equal(commentAuthorSkipReason(author), 'comment_author_blacklisted');
    }
    for (const author of [undefined, null, {}, '', 'ci-bot-helper', '@ci-bot']) {
      assert.equal(commentAuthorSkipReason(author), '');
    }
  });
  assert.deepEqual(parseCommentAuthorBlacklist(), []);
});

test('GitLab author falls back to display name and clearing a blacklist restores resumes', async () => {
  await withBlacklist('CI Bot', async () => {
    assert.equal((await runReviewComment({ provider: 'gitlab' }, { payload: payloadFor('gitlab', { name: 'CI Bot' }) })).reason, 'comment_author_blacklisted');
  });
  await withBlacklist('', async () => {
    assert.equal((await runReviewComment({ provider: 'gitlab', dryRun: true, gitlabToken: 'test' }, { payload: payloadFor('gitlab', { name: 'CI Bot' }) })).action, 'task_resume');
  });
});

for (const eventName of ['issue_comment', 'pull_request_review_comment']) {
  test(`GitLab bridge ${eventName} filters the forwarded author without API reads`, async (t) => {
    t.mock.method(global, 'fetch', () => assert.fail('unexpected API call'));
    const env = {
      GITLAB_BRIDGE_EVENT_NAME: eventName, GITLAB_BRIDGE_EVENT_ACTION: 'created',
      GITLAB_BRIDGE_PR_NUMBER: eventName === 'pull_request_review_comment' ? '9' : '',
      GITLAB_BRIDGE_ISSUE_NUMBER: '42', GITLAB_BRIDGE_COMMENT_ID: '101',
      GITLAB_BRIDGE_COMMENT_BODY: '@agentrix fix this', GITLAB_USER_LOGIN: 'pipeline-owner',
      GITLAB_BRIDGE_COMMENT_AUTHOR: 'ci-bot', CI_PROJECT_ID: '123', CI_PROJECT_PATH: 'team/app',
    };
    const payload = buildGitlabBridgePayload(env);
    await withBlacklist('ci-bot', async () => {
      const run = eventName === 'issue_comment' ? runComment : runReviewComment;
      assert.equal((await run({ provider: 'gitlab' }, { payload })).reason, 'comment_author_blacklisted');
    });
    for (const author of [undefined, '']) {
      const missing = buildGitlabBridgePayload({ ...env, GITLAB_BRIDGE_COMMENT_AUTHOR: author });
      assert.equal(providers.gitlab.getCommentContext(missing).author, '');
    }
  });
}
