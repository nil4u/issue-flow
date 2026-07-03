// @ts-nocheck
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const DEFAULT_PLUGIN_DIR = path.join(PACKAGE_ROOT, 'plugin')

function issueFlowPluginDir(env = process.env) {
  return path.resolve(String(env.ISSUE_FLOW_PLUGIN_DIR || DEFAULT_PLUGIN_DIR))
}

function issueFlowInstallScriptPath(env = process.env) {
  return path.join(issueFlowPluginDir(env), 'install.sh')
}

function issueFlowPackageJsonPath(env = process.env) {
  return path.join(issueFlowPluginDir(env), 'package.json')
}

export {
  issueFlowInstallScriptPath,
  issueFlowPackageJsonPath,
  issueFlowPluginDir,
}
