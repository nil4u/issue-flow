const assert = require('node:assert/strict');
const test = require('node:test');
require('tsx/cjs');
const { publicIssueFlowBaseUrl } = require('../src/core/installation/config.ts');

test('repository configuration uses an explicit public service URL or the public tunnel during local development', () => {
  assert.equal(publicIssueFlowBaseUrl('http://127.0.0.1:8788', { ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://tunnel.example/' }), 'https://tunnel.example');
  assert.equal(publicIssueFlowBaseUrl('https://flow.example', { ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://hooks.example' }), 'https://flow.example');
  assert.equal(publicIssueFlowBaseUrl('http://127.0.0.1:8788', { ISSUE_FLOW_PUBLIC_BASE_URL: 'https://public.example/flow/', ISSUE_FLOW_WEBHOOK_BASE_URL: 'https://hooks.example' }), 'https://public.example/flow');
  assert.equal(publicIssueFlowBaseUrl('', { ISSUE_FLOW_BASE_URL: 'https://production.example/' }), 'https://production.example');
});

test('a local or malformed address cannot silently enter a generated installation PR', () => {
  for (const base of ['http://127.0.0.1:8788', 'http://localhost:8788', 'http://[::1]:8788', '', 'https://flow.example?token=x']) {
    assert.throws(() => publicIssueFlowBaseUrl(base, {}), (error) => error.code === 'issue_flow_public_base_url_required');
  }
  assert.throws(() => publicIssueFlowBaseUrl('https://flow.example', { ISSUE_FLOW_PUBLIC_BASE_URL: 'http://localhost:8788' }), /ISSUE_FLOW_PUBLIC_BASE_URL/);
});
