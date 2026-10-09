const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const server = {
  id: 'github-main', type: 'github', baseUrl: 'https://github.com', apiUrl: 'https://api.github.com',
  githubApp: { appId: '42', slug: 'issue-flow-test', privateKey: pem },
  oauth: { clientId: 'client', clientSecret: 'client-secret' }, webhook: { secret: 'webhook-secret' },
  commitAuthor: { name: 'Issue Flow', email: 'bot@example.com' },
};
const remote = { id: 123, name: 'repo', full_name: 'owner/repo', default_branch: 'main', html_url: 'https://github.com/owner/repo', owner: { login: 'owner' }, permissions: { admin: true } };
const installation = { id: 7, app_id: 42, permissions: { contents: 'write', workflows: 'write', issues: 'write', pull_requests: 'write', secrets: 'write', actions_variables: 'write', actions: 'read' } };
function fixture() {
  const repository = { id: 'local-repo', serverRepoId: '123', projectId: '123', provider: 'github', gitServerId: server.id, fullName: 'owner/repo', defaultBranch: 'main', settings: {} };
  const calls = [];
  const store = {
    getGitServer: async () => server,
    listGitServers: async () => [server],
    getRepository: async () => repository,
    findRepositoryByProject: async () => repository,
    getUserAgentrixConfig: async () => ({ agentrix: { apiKey: 'agentrix-secret', runnerId: 'runner' } }),
    updateRepositorySettingsCache: async (id, patch) => { Object.assign(repository.settings, patch); return repository; },
    upsertRepo: async () => repository,
    syncRepositories: async () => [repository],
  };
  const options = { store, basePublicUrl: 'https://flow.example', input: { gitServerId: server.id, projectId: '123' }, session: { gitServerId: server.id, userId: 'user', token: 'user-token' } };
  function mockFetch(handler = () => undefined) {
    global.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const call = { url: String(url), path, method: init.method || 'GET', body, init };
      calls.push(call);
      const custom = await handler(call);
      if (custom !== undefined) return custom;
      if (path === '/repositories/123') return Response.json(remote);
      if (path === '/repos/owner/repo/installation') return Response.json(installation);
      if (path === '/app/installations/7/access_tokens') return Response.json({ token: 'installation-token' });
      assert.fail(`Unexpected GitHub call: ${call.method} ${url}`);
    };
  }
  return { repository, options, store, calls, mockFetch };
}
module.exports = { server, remote, installation, fixture, pem, publicKey };
