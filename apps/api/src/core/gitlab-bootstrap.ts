// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bootstrap from '../../../../skills/issue-flow/scripts/bootstrap.cjs'
import {
  createGitlabRepositoryCommit,
  getGitlabRepositoryFile,
} from './gitlab.js'

const { installGitlab } = bootstrap

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

async function installGitlabBootstrap(input = {}) {
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

export {
  installGitlabBootstrap,
}
