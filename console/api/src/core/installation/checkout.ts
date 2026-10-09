// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { issueFlowInstallScriptPath } from '../plugin-paths.js'

const execFileAsync = promisify(execFile)

function redact(value = '', token = '') {
  return token ? String(value || '').replaceAll(token, '[redacted]') : String(value || '');
}

async function runGit(cwd, args, token = '') {
  try {
    return await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch (error) {
    const detail = redact(error && (error.stderr || error.stdout || error.message) || '', token).trim();
    const failure = new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
    failure.status = 502;
    throw failure;
  }
}

async function tryGit(cwd, args, token = '') {
  try {
    return await runGit(cwd, args, token);
  } catch {
    return undefined;
  }
}

function gitStatusFiles(output = '') {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
}

function commitAuthor(input = {}) {
  const author = input.commitAuthor || {}
  return {
    name: String(author.name || input.commitAuthorName || 'issue-flow').trim() || 'issue-flow',
    email: String(author.email || input.commitAuthorEmail || '').trim(),
  }
}

async function runIssueFlowInstallScript(cwd, input = {}) {
  const script = issueFlowInstallScriptPath()
  if (!fs.existsSync(script)) {
    const failure = new Error(`issue-flow install script not found: ${script}`)
    failure.status = 502
    throw failure
  }
  const args = [script, input.provider, ...(input.args || [])]
  try {
    const result = await execFileAsync('sh', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 1024 * 1024 * 8,
    })
    return { status: 0, stdout: result.stdout || '', stderr: result.stderr || '' }
  } catch (error) {
    if (error && error.code === 4 && input.allowPlanChanged) {
      return {
        status: 4,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
      }
    }
    const detail = redact(error && (error.stderr || error.stdout || error.message) || '', input.token || '').trim()
    const failure = new Error(`issue-flow install failed${detail ? `: ${detail}` : ''}`)
    failure.status = 502
    throw failure
  }
}

function parseInstallerJson(output = '', fallbackError = 'issue_flow_install_json_invalid') {
  try {
    return JSON.parse(String(output || '').trim() || '{}')
  } catch {
    const error = new Error(fallbackError)
    error.status = 502
    throw error
  }
}

export function configureIssueFlow(checkout, input = {}) {
  const configPath = path.join(checkout, '.issue-flow', 'config.json')
  if (!fs.existsSync(configPath)) return
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  delete config.visionPlan
  delete config.visualPlan
  delete config.repositoryId
  config.gitServerId = String(input.gitServerId || config.gitServerId || '')
  config.projectId = String(input.projectId || config.projectId || '')
  config.baseUrl = String(input.issueFlowBaseUrl || config.baseUrl || '').replace(/\/+$/, '')
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

async function prepareCheckout(context) {
  const { root, checkout, input, provider, targetBranch, sourceBranch, token, progress } = context
  progress({ id: 'clone', status: 'running', label: '克隆仓库', detail: `正在克隆 ${targetBranch}` })
  await runGit(root, ['clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', targetBranch, provider.remoteUrl(input), checkout], token)
  await tryGit(checkout, ['sparse-checkout', 'init', '--no-cone'], token)
  await tryGit(checkout, ['sparse-checkout', 'set', ...provider.sparsePaths], token)
  await runGit(checkout, ['checkout', targetBranch], token)
  await runGit(checkout, ['checkout', '-b', sourceBranch], token)
  progress({ id: 'clone', status: 'passed', label: '克隆仓库', detail: `已创建分支 ${sourceBranch}` })
}

async function applyInstallDecisions({ root, checkout, input, provider, token }) {
  const decisionFile = path.join(root, 'install-decisions.json')
  fs.writeFileSync(decisionFile, `${JSON.stringify(input.decisions)}\n`, 'utf8')
  const result = await runIssueFlowInstallScript(checkout, {
    provider: provider.id, token, args: ['--decision-file', decisionFile], allowPlanChanged: true,
  })
  if (result.status !== 4) return undefined
  const plan = parseInstallerJson(result.stdout, 'issue_flow_install_plan_changed_invalid')
  return { fingerprint: plan.fingerprint || '', conflicts: plan.conflicts || [] }
}

async function planAndInstallFiles({ checkout, provider, token }) {
  const result = await runIssueFlowInstallScript(checkout, { provider: provider.id, token, args: ['--plan-json'] })
  const plan = parseInstallerJson(result.stdout, 'issue_flow_install_plan_invalid')
  if (Array.isArray(plan.conflicts) && plan.conflicts.length) return plan
  await runIssueFlowInstallScript(checkout, { provider: provider.id, token })
  return undefined
}

async function installFiles(context) {
  const { input, checkout, progress } = context
  progress({ id: 'install', status: 'running', label: '安装文件', detail: input.decisions ? '正在按冲突决策写入 issue-flow 文件' : '正在检查 issue-flow 文件冲突' })
  const plan = input.decisions ? await applyInstallDecisions(context) : await planAndInstallFiles(context)
  if (plan) {
    const detail = input.decisions ? '安装计划已变化，需要重新选择冲突处理方式' : `${plan.conflicts.length} 个文件需要确认`
    progress({ id: 'install', status: 'passed', label: '安装文件', detail })
    return { conflicts: true, plan }
  }
  configureIssueFlow(checkout, input)
  progress({ id: 'install', status: 'passed', label: '安装文件', detail: '安装文件已生成' })
}

async function commitFiles({ checkout, input, sourceBranch, token }) {
  const author = commitAuthor(input)
  if (!author.email) throw Object.assign(new Error('git commit author email is required'), { status: 400 })
  await runGit(checkout, ['config', 'user.name', author.name], token)
  await runGit(checkout, ['config', 'user.email', author.email], token)
  const message = String(input.commitMessage || '').trim() || `chore: ${input.operation === 'upgrade' ? 'upgrade' : 'install'} issue-flow plugin`
  await runGit(checkout, ['commit', '-m', message], token)
  await runGit(checkout, ['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], token)
}

async function publishChange(context, files) {
  const { input, provider, sourceBranch, targetBranch, progress } = context
  await commitFiles(context)
  progress({ id: 'commit', status: 'passed', label: '提交变更', detail: `${files.length} 个文件变更已推送` })
  progress({ id: 'mr', status: 'running', label: `发起 ${provider.changeName}`, detail: `正在创建 ${provider.changeName}` })
  const change = await provider.createChange({ ...input, sourceBranch, targetBranch })
  const mergeRequest = { id: String(change.id || ''), iid: String(change.iid || ''), webUrl: change.webUrl || '' }
  progress({ id: 'mr', status: 'passed', label: `发起 ${provider.changeName}`, detail: `${provider.changeName} ${mergeRequest.iid} 已创建`, mergeRequest })
  return { skipped: false, branch: targetBranch, sourceBranch, actionCount: files.length, files, mergeRequest }
}

async function submitFiles(context) {
  const { checkout, provider, token, targetBranch, sourceBranch, progress } = context
  progress({ id: 'commit', status: 'running', label: '提交变更', detail: '正在提交并推送分支' })
  await runGit(checkout, ['add', '-A', '--', ...provider.paths], token)
  const files = gitStatusFiles((await runGit(checkout, ['status', '--porcelain'], token)).stdout)
  if (files.length) return publishChange(context, files)
  progress({ id: 'commit', status: 'passed', label: '提交变更', detail: '没有新的文件变更' })
  progress({ id: 'mr', status: 'passed', label: `发起 ${provider.changeName}`, detail: `无需创建 ${provider.changeName}` })
  return { skipped: true, branch: targetBranch, sourceBranch, actions: [], files: [] }
}

// --- 工作区生命周期：冲突、失败和成功都在同一个出口清理 ---
export async function installPluginChange(input, provider) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-plugin-'))
  const context = {
    root, checkout: path.join(root, 'repo'), input, provider, token: input.token || '',
    targetBranch: input.branch || input.defaultBranch || 'main',
    sourceBranch: input.sourceBranch || `issue-flow/${input.operation === 'upgrade' ? 'upgrade' : 'install'}-${Date.now().toString(36)}`,
    progress: typeof input.onProgress === 'function' ? input.onProgress : () => {},
  }
  try {
    await prepareCheckout(context)
    const conflict = await installFiles(context)
    return conflict || await submitFiles(context)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
