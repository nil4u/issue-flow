// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dispatch from '../../../../skills/issue-flow/scripts/dispatch.cjs'
import { sanitize, sanitizeError } from './sanitize.js'

function writeEventTemp(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-service-event-'));
  const eventPath = path.join(dir, 'event.json');
  fs.writeFileSync(eventPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return {
    eventPath,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function buildDispatchOptions(repo, credentials) {
  const automation = repo.automation || {};
  const agentrix = repo.agentrix || {};
  return {
    provider: 'gitlab',
    repo: repo.projectPath,
    gitServerId: repo.gitServerId || '',
    gitlabProject: repo.projectId || repo.projectPath,
    gitlabUrl: repo.baseUrl,
    gitlabApiUrl: repo.apiUrl,
    gitlabToken: credentials.providerToken,
    gitlabTokenAuth: repo.tokenAuth || 'bearer',
    autoDefault: automation.autoDefault || 'triage',
    reviewEnabled: automation.reviewEnabled ? 'true' : 'false',
    runtime: 'agentrix',
    baseUrl: agentrix.baseUrl || '',
    apiKey: credentials.agentrixApiKey || '',
    agent: automation.agent || '',
    runnerId: automation.runnerId || agentrix.runnerId || '',
    responseMode: automation.responseMode || '',
  };
}

async function dispatchGitlabEvent(routeAction, repo, credentials, payload) {
  if (routeAction === 'ignored') {
    return {
      action: 'ignored',
      skipped: true,
    };
  }

  const temp = writeEventTemp(payload);
  const options = {
    ...buildDispatchOptions(repo, credentials),
    event: temp.eventPath,
  };

  try {
    switch (routeAction) {
      case 'auto':
        return await dispatch.runAuto(options);
      case 'comment':
        return await dispatch.runComment(options);
      case 'review':
        return await dispatch.runReview(options);
      case 'review-comment':
        return await dispatch.runReviewComment(options);
      case 'pr-merged':
        return await dispatch.runPrMerged(options);
      case 'pipeline-failed':
        return await dispatch.runPipelineFailed(options);
      default:
        return {
          action: 'ignored',
          reason: `unsupported_route:${routeAction}`,
        };
    }
  } finally {
    temp.cleanup();
  }
}

function summarizeDispatchResult(result = {}) {
  return sanitize({
    action: result.action || result.transition && result.transition.action || '',
    skipped: Boolean(result.skipped),
    reason: result.reason || result.transition && result.transition.reason || '',
    selectedAction: result.selectedAction || '',
    runId: result.result && result.result.runId || result.autoResume && result.autoResume.result && result.autoResume.result.runId || '',
    issue: result.issue || result.sourceIssue || result.pullRequest || '',
    taskId: result.taskId || '',
    failureIntakeAction: result.failureIntake && result.failureIntake.action || '',
  });
}

function summarizeDispatchError(error) {
  return sanitizeError(error);
}

export {
  buildDispatchOptions,
  dispatchGitlabEvent,
  summarizeDispatchError,
  summarizeDispatchResult,
};
