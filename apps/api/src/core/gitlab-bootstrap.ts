// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import bootstrap from '../../../../skills/issue-flow/scripts/bootstrap.cjs'
import {
  createGitlabMergeRequest,
  createGitlabRepositoryCommit,
  getGitlabRepositoryFile,
} from './gitlab.js'

const { installGitlab } = bootstrap
const execFileAsync = promisify(execFile)
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

const ROOT_CI = '.gitlab-ci.yml';
const ISSUE_FLOW_CI = '.gitlab/issue-flow.gitlab-ci.yml';
const PROJECT_CI = '.gitlab/issue-flow-project.gitlab-ci.yml';

function listFiles(root) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current).sort()) {
      const target = path.join(current, entry);
      const stats = fs.statSync(target);
      if (stats.isDirectory()) {
        visit(target);
      } else if (stats.isFile()) {
        files.push(path.relative(root, target).split(path.sep).join('/'));
      }
    }
  };
  visit(root);
  return files;
}

function readGeneratedFiles(root) {
  return Object.fromEntries(listFiles(root).map((filePath) => [
    filePath,
    fs.readFileSync(path.join(root, filePath), 'utf8'),
  ]));
}

function rootCiContent(includeProjectCi = false) {
  const lines = [
    'include:',
    `  - local: ${ISSUE_FLOW_CI}`,
  ];
  if (includeProjectCi) {
    lines.push(`  - local: ${PROJECT_CI}`);
  }
  return `${lines.join('\n')}\n`;
}

function hasIssueFlowInclude(content = '') {
  return String(content || '').includes(ISSUE_FLOW_CI);
}

async function fileExists(input, filePath, branch) {
  return Boolean(await getGitlabRepositoryFile({
    ...input,
    filePath,
    ref: branch,
  }));
}

async function createUpsertAction(input, filePath, content, branch) {
  return {
    action: await fileExists(input, filePath, branch) ? 'update' : 'create',
    file_path: filePath,
    content,
  };
}

async function generateGitlabBootstrapFiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-gitlab-bootstrap-'));
  try {
    installGitlab({ cwd: root, force: true });
    return readGeneratedFiles(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function buildGitlabBootstrapActions(input = {}) {
  const branch = input.branch || input.defaultBranch || 'main';
  const generated = await generateGitlabBootstrapFiles();
  const apiInput = {
    apiUrl: input.apiUrl,
    token: input.token,
    authType: input.authType,
    projectIdOrPath: input.projectIdOrPath,
  };
  const actions = [];
  const existingRoot = await getGitlabRepositoryFile({
    ...apiInput,
    filePath: ROOT_CI,
    ref: branch,
  });
  const existingRootContent = existingRoot && existingRoot.content
    ? Buffer.from(existingRoot.content, existingRoot.encoding || 'base64').toString('utf8')
    : '';

  for (const [filePath, content] of Object.entries(generated)) {
    if (filePath === ROOT_CI) {
      continue;
    }
    actions.push(await createUpsertAction(apiInput, filePath, content, branch));
  }

  if (!existingRoot) {
    actions.push({
      action: 'create',
      file_path: ROOT_CI,
      content: generated[ROOT_CI] || rootCiContent(false),
    });
  } else if (!hasIssueFlowInclude(existingRootContent)) {
    const projectCiExists = await fileExists(apiInput, PROJECT_CI, branch);
    if (projectCiExists) {
      const error = new Error(`${PROJECT_CI} already exists; cannot safely wrap existing ${ROOT_CI}`);
      error.status = 409;
      throw error;
    }
    actions.push({
      action: 'create',
      file_path: PROJECT_CI,
      content: existingRootContent,
    });
    actions.push({
      action: 'update',
      file_path: ROOT_CI,
      content: rootCiContent(true),
    });
  }

  return {
    branch,
    actions,
    apiInput,
    generated,
    existingRoot: Boolean(existingRoot),
    hasIssueFlowInclude: hasIssueFlowInclude(existingRootContent),
  };
}

async function planGitlabBootstrap(input = {}) {
  const plan = await buildGitlabBootstrapActions(input);
  return {
    branch: plan.branch,
    required: plan.actions.length > 0,
    skipped: plan.actions.length === 0,
    actionCount: plan.actions.length,
    files: plan.actions.map((action) => action.file_path),
    actions: plan.actions.map((action) => ({
      action: action.action,
      filePath: action.file_path,
    })),
  };
}

async function installGitlabBootstrap(input = {}) {
  const { branch, actions, apiInput } = await buildGitlabBootstrapActions(input);
  if (actions.length === 0) {
    return {
      skipped: true,
      branch,
      actions: [],
    };
  }

  const commit = await createGitlabRepositoryCommit({
    ...apiInput,
    branch,
    commitMessage: input.commitMessage || 'Install issue-flow',
    actions,
  });
  return {
    skipped: false,
    branch,
    actionCount: actions.length,
    commitId: commit.id || commit.short_id || '',
    webUrl: commit.web_url || '',
  };
}

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

function writeActionFile(root, action = {}) {
  const filePath = String(action.file_path || '');
  if (!filePath) return;
  const target = path.join(root, filePath);
  if (action.action === 'delete') {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, action.content || '', 'utf8');
}

async function runIssueFlowInstallScript(cwd, input = {}) {
  const script = path.join(PACKAGE_ROOT, 'install.sh')
  try {
    return await execFileAsync('sh', [script, input.provider || 'gitlab', '--force'], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
      maxBuffer: 1024 * 1024 * 8,
    })
  } catch (error) {
    const detail = redact(error && (error.stderr || error.stdout || error.message) || '', input.token || '').trim()
    const failure = new Error(`issue-flow install failed${detail ? `: ${detail}` : ''}`)
    failure.status = 502
    throw failure
  }
}

async function installGitlabPluginMergeRequest(input = {}) {
  const targetBranch = input.branch || input.defaultBranch || 'main'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-gitlab-plugin-'))
  const checkout = path.join(root, 'repo')
  const sourceBranch = input.sourceBranch || `issue-flow/${input.operation === 'upgrade' ? 'upgrade' : 'install'}-${Date.now().toString(36)}`
  const token = input.token || ''
  try {
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

    await runIssueFlowInstallScript(checkout, { provider: 'gitlab', token })
    await runGit(checkout, ['add', '-A', '--', '.gitlab-ci.yml', '.gitlab', '.issue-flow', '.agentrix/plugins/issue-flow'], token)
    const status = await runGit(checkout, ['status', '--porcelain'], token)
    const files = gitStatusFiles(status.stdout)
    if (!files.length) {
      return {
        skipped: true,
        branch: targetBranch,
        sourceBranch,
        actions: [],
        files: [],
      }
    }

    await runGit(checkout, ['config', 'user.name', 'issue-flow'], token)
    await runGit(checkout, ['config', 'user.email', 'issue-flow@localhost'], token)
    await runGit(checkout, ['commit', '-m', input.commitMessage || 'Install issue-flow plugin'], token)
    await runGit(checkout, ['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], token)

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

async function installGitlabBootstrapMergeRequest(input = {}) {
  const { branch: targetBranch, actions } = await buildGitlabBootstrapActions(input);
  if (actions.length === 0) {
    return {
      skipped: true,
      branch: targetBranch,
      actions: [],
    };
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-gitlab-mr-'));
  const checkout = path.join(root, 'repo');
  const sourceBranch = input.sourceBranch || `issue-flow/install-${Date.now().toString(36)}`;
  const token = input.token || '';
  try {
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
    ], token);
    await tryGit(checkout, ['sparse-checkout', 'init', '--no-cone'], token);
    await tryGit(checkout, ['sparse-checkout', 'set', '.gitlab-ci.yml', '.gitlab/*', '.issue-flow/*'], token);
    await runGit(checkout, ['checkout', targetBranch], token);
    await runGit(checkout, ['checkout', '-b', sourceBranch], token);

    for (const action of actions) {
      writeActionFile(checkout, action);
    }

    await runGit(checkout, ['add', '--', ...actions.map((action) => action.file_path)], token);
    const status = await runGit(checkout, ['status', '--porcelain'], token);
    if (!String(status.stdout || '').trim()) {
      return {
        skipped: true,
        branch: targetBranch,
        actions: [],
      };
    }

    await runGit(checkout, ['config', 'user.name', 'issue-flow'], token);
    await runGit(checkout, ['config', 'user.email', 'issue-flow@localhost'], token);
    await runGit(checkout, ['commit', '-m', input.commitMessage || 'Install issue-flow'], token);
    await runGit(checkout, ['push', 'origin', `HEAD:refs/heads/${sourceBranch}`], token);

    const mergeRequest = await createGitlabMergeRequest({
      apiUrl: input.apiUrl,
      token,
      authType: input.authType,
      projectIdOrPath: input.projectIdOrPath,
      sourceBranch,
      targetBranch,
      title: input.mergeRequestTitle || 'Install issue-flow',
      description: input.mergeRequestDescription || [
        'Installs issue-flow bootstrap files.',
        '',
        'Direct API setup for variables, labels, and webhook is handled by issue-flow after this request is created.',
      ].join('\n'),
      removeSourceBranch: true,
    });

    return {
      skipped: false,
      branch: targetBranch,
      sourceBranch,
      actionCount: actions.length,
      actions: actions.map((action) => ({
        action: action.action,
        filePath: action.file_path,
      })),
      mergeRequest: {
        id: mergeRequest.id ? String(mergeRequest.id) : '',
        iid: mergeRequest.iid ? String(mergeRequest.iid) : '',
        webUrl: mergeRequest.web_url || mergeRequest.webUrl || '',
      },
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export {
  installGitlabBootstrap,
  installGitlabBootstrapMergeRequest,
  installGitlabPluginMergeRequest,
  planGitlabBootstrap,
}
