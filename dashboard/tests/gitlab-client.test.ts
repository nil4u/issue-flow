import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient } from '../src/lib/gitlab.ts';

test('GitLabClient uses project path when dashboard project id is a local Agentrix id', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const client = new GitLabClient({
      baseUrl: 'https://git.lianjia.com',
      token: 'pat',
      projectId: 'gitlab-git-lianjia-com:huilian/wandou-kanban',
      projectPath: 'huilian/wandou-kanban'
    });

    await client.listIssues();

    assert.equal(
      calls[0],
      'https://git.lianjia.com/api/v4/projects/huilian%2Fwandou-kanban/issues?per_page=100&state=all'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitLabClient keeps numeric GitLab project ids for API requests', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const client = new GitLabClient({
      baseUrl: 'https://git.lianjia.com',
      token: 'pat',
      projectId: '43371',
      projectPath: 'huilian/wandou-kanban'
    });

    await client.listIssues();

    assert.equal(
      calls[0],
      'https://git.lianjia.com/api/v4/projects/43371/issues?per_page=100&state=all'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
