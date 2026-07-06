// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  createGitlabMergeRequest,
} from './gitlab.js'
import { issueFlowInstallScriptPath } from './plugin-paths.js'

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

function gitlabRemoteUrl(input = {}) {
  const url = new URL(input.baseUrl || '');
  const rootPath = url.pathname.replace(/\/+$/, '');
  const projectPath = String(input.projectPath || '').replace(/^\/+/, '');
  url.pathname = `${rootPath}/${projectPath}.git`;
  url.username = 'oauth2';
  url.password = input.token || '';
  return url.toString();
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
  const args = [script, input.provider || 'gitlab', ...(input.args || [])]
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

async function installGitlabPluginMergeRequest(input = {}) {
  const targetBranch = input.branch || input.defaultBranch || 'main'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-gitlab-plugin-'))
  const checkout = path.join(root, 'repo')
  const sourceBranch = input.sourceBranch || `issue-flow/${input.operation === 'upgrade' ? 'upgrade' : 'install'}-${Date.now().toString(36)}`
  const token = input.token || ''
  const progress = typeof input.onProgress === 'function' ? input.onProgress : () => {}
  try {
    progress({ id: 'clone', status: 'running', label: '克隆仓库', detail: `正在克隆 ${targetBranch}` })
    await runGit(root, [
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--depth',
      '1',
      '--branch',
      targetBranch,
      gitlabRemoteUrl(input),
      checkout,
    ], token)
    await tryGit(checkout, ['sparse-checkout', 'init', '--no-cone'], token)
    await tryGit(checkout, [
      'sparse-checkout',
      'set',
      '.gitlab-ci.yml',
      '.gitlab/**',
      '.issue-flow/**',
      '.agentrix/plugins/issue-flow/**',
    ], token)
    await runGit(checkout, ['checkout', targetBranch], token)
    await runGit(checkout, ['checkout', '-b', sourceBranch], token)
    progress({ id: 'clone', status: 'passed', label: '克隆仓库', detail: `已创建分支 ${sourceBranch}` })

    progress({ id: 'install', status: 'running', label: '安装文件', detail: input.decisions ? '正在按冲突决策写入 issue-flow 文件' : '正在检查 issue-flow 文件冲突' })
    if (input.decisions) {
      const decisionFile = path.join(root, 'install-decisions.json')
      fs.writeFileSync(decisionFile, `${JSON.stringify(input.decisions)}\n`, 'utf8')
      const install = await runIssueFlowInstallScript(checkout, {
        provider: 'gitlab',
        token,
        args: ['--decision-file', decisionFile],
        allowPlanChanged: true,
      })
      if (install.status === 4) {
        const plan = parseInstallerJson(install.stdout, 'issue_flow_install_plan_changed_invalid')
        progress({ id: 'install', status: 'passed', label: '安装文件', detail: '安装计划已变化，需要重新选择冲突处理方式' })
        return {
          conflicts: true,
          plan: {
            fingerprint: plan.fingerprint || '',
            conflicts: plan.conflicts || [],
          },
        }
      }
    } else {
      const planResult = await runIssueFlowInstallScript(checkout, {
        provider: 'gitlab',
        token,
        args: ['--plan-json'],
      })
      const plan = parseInstallerJson(planResult.stdout, 'issue_flow_install_plan_invalid')
      if (Array.isArray(plan.conflicts) && plan.conflicts.length) {
        progress({ id: 'install', status: 'passed', label: '安装文件', detail: `${plan.conflicts.length} 个文件需要确认` })
        return {
          conflicts: true,
          plan,
        }
      }
      await runIssueFlowInstallScript(checkout, { provider: 'gitlab', token })
    }
    progress({ id: 'install', status: 'passed', label: '安装文件', detail: '安装文件已生成' })

    progress({ id: 'commit', status: 'running', label: '提交变更', detail: '正在提交并推送分支' })
    await runGit(checkout, ['add', '-A', '--', '.gitlab-ci.yml', '.gitlab', '.issue-flow', '.agentrix/plugins/issue-flow'], token)
    const status = await runGit(checkout, ['status', '--porcelain'], token)
    const files = gitStatusFiles(status.stdout)
    if (!files.length) {
      progress({ id: 'commit', status: 'passed', label: '提交变更', detail: '没有新的文件变更' })
      progress({ id: 'mr', status: 'passed', label: '发起 MR', detail: '无需创建 MR' })
      return {
        skipped: true,
        branch: targetBranch,
        sourceBranch,
        actions: [],
        files: [],
      }
    }

    const author = commitAuthor(input)
    if (!author.email) {
      const failure = new Error('git commit author email is required')
      failure.status = 400
      throw failure
    }
    await runGit(checkout, ['config', 'user.name', author.name], token)
    await runGit(checkout, ['config', 'user.email', author.email], token)
    await runGit(checkout, ['commit', '-m', input.commitMessage || 'Install issue-flow plugin'], token)
    await runGit(checkout, ['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], token)
    progress({ id: 'commit', status: 'passed', label: '提交变更', detail: `${files.length} 个文件变更已推送` })

    progress({ id: 'mr', status: 'running', label: '发起 MR', detail: '正在创建 Merge Request' })
    const mergeRequest = await createGitlabMergeRequest({
      apiUrl: input.apiUrl,
      token,
      authType: input.authType,
      projectIdOrPath: input.projectIdOrPath,
      sourceBranch,
      targetBranch,
      title: input.mergeRequestTitle || 'Install issue-flow plugin',
      description: input.mergeRequestDescription || [
        `${input.operation === 'upgrade' ? 'Upgrades' : 'Installs'} issue-flow plugin files.`,
        '',
        'Merge this request, then issue-flow will refresh the plugin status from .issue-flow/install-manifest.json.',
      ].join('\n'),
      removeSourceBranch: true,
    })
    progress({
      id: 'mr',
      status: 'passed',
      label: '发起 MR',
      detail: mergeRequest.iid ? `MR !${mergeRequest.iid} 已创建` : 'Merge Request 已创建',
      mergeRequest: {
        id: mergeRequest.id ? String(mergeRequest.id) : '',
        iid: mergeRequest.iid ? String(mergeRequest.iid) : '',
        webUrl: mergeRequest.web_url || mergeRequest.webUrl || '',
      },
    })

    return {
      skipped: false,
      branch: targetBranch,
      sourceBranch,
      actionCount: files.length,
      files,
      mergeRequest: {
        id: mergeRequest.id ? String(mergeRequest.id) : '',
        iid: mergeRequest.iid ? String(mergeRequest.iid) : '',
        webUrl: mergeRequest.web_url || mergeRequest.webUrl || '',
      },
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export {
  installGitlabPluginMergeRequest,
}
