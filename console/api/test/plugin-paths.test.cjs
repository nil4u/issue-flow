const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

require('tsx/cjs');

const {
  issueFlowInstallScriptPath,
  issueFlowLabelsCatalogPath,
  issueFlowPackageJsonPath,
  issueFlowPluginDir,
} = require('../src/core/plugin-paths.ts');

test('issue-flow plugin paths default to the monorepo plugin directory', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const pluginDir = path.join(root, 'plugin');

  assert.equal(issueFlowPluginDir({}), pluginDir);
  assert.equal(issueFlowInstallScriptPath({}), path.join(pluginDir, 'install.sh'));
  assert.equal(issueFlowLabelsCatalogPath({}), path.join(pluginDir, 'skills', 'issue-flow', 'scripts', 'labels.cjs'));
  assert.equal(issueFlowPackageJsonPath({}), path.join(pluginDir, 'package.json'));
});

test('ISSUE_FLOW_PLUGIN_DIR overrides the plugin directory', () => {
  const pluginDir = path.resolve('/tmp/custom-issue-flow-plugin');

  assert.equal(issueFlowPluginDir({ ISSUE_FLOW_PLUGIN_DIR: pluginDir }), pluginDir);
  assert.equal(issueFlowInstallScriptPath({ ISSUE_FLOW_PLUGIN_DIR: pluginDir }), path.join(pluginDir, 'install.sh'));
  assert.equal(issueFlowLabelsCatalogPath({ ISSUE_FLOW_PLUGIN_DIR: pluginDir }), path.join(pluginDir, 'skills', 'issue-flow', 'scripts', 'labels.cjs'));
  assert.equal(issueFlowPackageJsonPath({ ISSUE_FLOW_PLUGIN_DIR: pluginDir }), path.join(pluginDir, 'package.json'));
});
