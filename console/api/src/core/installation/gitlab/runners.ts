// @ts-nocheck
import { enableGitlabRunnerForProject, getGitlabRunner, listGitlabProjectRunners, listGitlabRunners, updateGitlabProjectRunnerSettings } from '../../gitlab.js'
import { resolveGitlabProjectAccess, gitlabInstallContext } from './context.js'
import { installStep } from '../steps.js'

const ISSUE_FLOW_RUNNER_TAG = 'issue-flow'

function gitlabRunnerAvailable(runner = {}) {
  const status = String(runner.status || '').toLowerCase();
  return runner.active !== false
    && runner.paused !== true
    && status !== 'offline'
    && status !== 'not_connected'
    && status !== 'never_contacted';
}

function gitlabRunnerMatchesIssueFlow(runner = {}) {
  const tags = Array.isArray(runner.tagList) ? runner.tagList : [];
  return gitlabRunnerAvailable(runner) && tags.includes(ISSUE_FLOW_RUNNER_TAG);
}

function gitlabRunnerName(runner = {}) {
  return String(runner.description || runner.name || (runner.id ? `#${runner.id}` : '')).trim();
}

function gitlabRunnerCache(runner = {}, status = 'needs_action', detail = '') {
  return {
    key: ISSUE_FLOW_RUNNER_TAG,
    source: 'gitlab',
    runnerId: runner.id || '',
    name: gitlabRunnerName(runner),
    description: runner.description || '',
    shortToken: runner.shortToken || '',
    runnerType: runner.runnerType || '',
    gitlabStatus: runner.status || '',
    active: runner.active !== false,
    paused: runner.paused === true,
    tagList: Array.isArray(runner.tagList) ? runner.tagList : [],
    status,
    detail,
  };
}

async function cacheGitlabRunnerCheck(store, existing, step) {
  if (!existing) return;
  await store.updateRepositorySettingsCache(existing.id, {
    runners: {
      items: step.runners || [],
      checkedAt: new Date().toISOString(),
    },
  });
}

function runnerSettingsUrl(project = {}) {
  const webUrl = String(project.webUrl || '').replace(/\/+$/, '');
  return webUrl ? `${webUrl}/-/settings/ci_cd#js-runners-settings` : '';
}

async function listAssignableIssueFlowRunners(apiInput) {
  try {
    const runners = await listGitlabRunners(apiInput, { tag_list: ISSUE_FLOW_RUNNER_TAG, type: 'project_type' });
    return runners.filter((runner) => gitlabRunnerMatchesIssueFlow(runner) && runner.runnerType === 'project_type' && !runner.locked);
  } catch (error) {
    if (error && (error.status === 401 || error.status === 403 || error.status === 404)) return [];
    throw error;
  }
}

async function runnerDetails(apiInput, runner = {}) {
  if (!runner.id || runner.tagList && runner.tagList.length) return runner;
  try {
    const detail = await getGitlabRunner(apiInput, runner.id);
    return { ...runner, ...detail, description: detail.description || runner.description || '' };
  } catch (error) {
    if (error && (error.status === 401 || error.status === 403 || error.status === 404)) return runner;
    throw error;
  }
}

async function checkGitlabIssueFlowRunner({ apiInput, project }) {
  const runners = await Promise.all((await listGitlabProjectRunners(apiInput)).map((runner) => runnerDetails(apiInput, runner)));
  const matches = runners.filter(gitlabRunnerMatchesIssueFlow);
  if (matches.length) {
    const matched = matches[0];
    const names = matches.map(gitlabRunnerName).filter(Boolean).join(', ');
    const detail = names ? `已找到可用 issue-flow runner：${names}` : `已找到 ${matches.length} 个可用 issue-flow runner`;
    return installStep(
      'runners',
      'api',
      'GitLab Runner',
      'passed',
      detail,
      {
        runners: matches.map((runner) => gitlabRunnerCache(runner, 'passed', detail)),
        value: gitlabRunnerName(matched),
      }
    );
  }
  const canEnableScope = project.sharedRunnersEnabled === false || project.groupRunnersEnabled === false;
  const assignable = await listAssignableIssueFlowRunners(apiInput);
  const detail = canEnableScope
    ? '可自动开启当前项目的 group/instance runner 开关'
    : assignable.length
      ? '可自动启用匹配 issue-flow tag 的 project runner'
      : `请在 GitLab 项目或上级 group 启用可用 runner，并添加 ${ISSUE_FLOW_RUNNER_TAG} tag`;
  return installStep(
    'runners',
    'api',
    'GitLab Runner',
    'needs_action',
    detail,
    {
      value: ISSUE_FLOW_RUNNER_TAG,
      valueHref: runnerSettingsUrl(project),
      runners: [gitlabRunnerCache({ tagList: [ISSUE_FLOW_RUNNER_TAG] }, 'needs_action', detail)],
    }
  );
}

async function setGitlabProjectInstallRunner({ store, input = {}, session, env = process.env, logger = undefined }) {
  let context;
  try {
    context = await gitlabInstallContext({ store, input, session, env, logger });
  } catch (error) {
    return {
      status: error && error.status || 500,
      body: {
        error: error && error.code || 'gitlab_runner_set_failed',
        validation: error && error.validation || undefined,
      },
    };
  }
  const { project, existing, apiInput, user } = context;
  const access = await resolveGitlabProjectAccess({ project, apiInput, user });
  if (!access.canManage) {
    return { status: 403, body: { error: 'gitlab_project_permission_required', access } };
  }

  let currentProject = project;
  let step = await checkGitlabIssueFlowRunner({ apiInput, project: currentProject });
  if (step.status === 'passed') {
    await cacheGitlabRunnerCheck(store, existing, step);
    return { status: 200, body: { repository: existing ? await store.getRepository(existing.id) : null, access, step, steps: [step], installable: true } };
  }

  const settings = {};
  if (currentProject.sharedRunnersEnabled === false) settings.sharedRunnersEnabled = true;
  if (currentProject.groupRunnersEnabled === false) settings.groupRunnersEnabled = true;
  if (Object.keys(settings).length) {
    currentProject = await updateGitlabProjectRunnerSettings(apiInput, settings);
    step = await checkGitlabIssueFlowRunner({ apiInput, project: currentProject });
    if (step.status === 'passed') {
      await cacheGitlabRunnerCheck(store, existing, step);
      return { status: 200, body: { repository: existing ? await store.getRepository(existing.id) : null, access, project: currentProject, step, steps: [step], installable: true } };
    }
  }

  const assignable = await listAssignableIssueFlowRunners(apiInput);
  for (const runner of assignable) {
    try {
      await enableGitlabRunnerForProject(apiInput, runner.id);
      step = await checkGitlabIssueFlowRunner({ apiInput, project: currentProject });
      if (step.status === 'passed') {
        await cacheGitlabRunnerCheck(store, existing, step);
        return { status: 200, body: { repository: existing ? await store.getRepository(existing.id) : null, access, project: currentProject, step, steps: [step], installable: true } };
      }
    } catch (error) {
      if (!error || (error.status !== 400 && error.status !== 403 && error.status !== 404 && error.status !== 409)) {
        throw error;
      }
    }
  }

  await cacheGitlabRunnerCheck(store, existing, step);
  return { status: 200, body: { repository: existing ? await store.getRepository(existing.id) : null, access, project: currentProject, step, steps: [step], installable: false } };
}

async function checkRunners({ store, basePublicUrl, env, config, project, existing, installConfig, apiInput }) {
  const runnerStep = await checkGitlabIssueFlowRunner({ apiInput, project });

  await cacheGitlabRunnerCheck(store, existing, runnerStep);

  return runnerStep;

}

export { checkRunners, setGitlabProjectInstallRunner }
