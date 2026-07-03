// @ts-nocheck
import { agentrixServiceConfig, sessionUserKey } from './common.js'

async function savedAgentrixDefaults(store, session, env = process.env) {
  const userKey = sessionUserKey(session);
  const saved = userKey ? await store.getUserAgentrixConfig(userKey, { includeSecret: true }) : undefined;
  return {
    automation: saved && saved.automation || {},
    agentrix: {
      ...(saved && saved.agentrix || {}),
      baseUrl: agentrixServiceConfig(env).baseUrl,
    },
  };
}

function mergeAgentrixInstallInput(input = {}, defaults = {}, env = process.env) {
  return {
    automation: {
      ...(defaults.automation || {}),
      ...(input.automation || {}),
    },
    agentrix: {
      apiKey: input.agentrix && input.agentrix.apiKey || defaults.agentrix && defaults.agentrix.apiKey || '',
      runnerId: input.agentrix && input.agentrix.runnerId !== undefined
        ? input.agentrix.runnerId || ''
        : defaults.agentrix && defaults.agentrix.runnerId || '',
      baseUrl: input.agentrix && input.agentrix.baseUrl || agentrixServiceConfig(env).baseUrl,
    },
  };
}

async function getUserAgentrixConfig({ store, session, env = process.env }) {
  const userKey = sessionUserKey(session);
  if (!userKey) {
    return { status: 401, body: { error: 'gitlab_login_required' } };
  }
  const saved = await store.getUserAgentrixConfig(userKey);
  return {
    status: 200,
    body: {
      config: {
        automation: saved && saved.automation || {
          autoDefault: 'triage',
          reviewEnabled: false,
          agent: 'codex',
          runnerId: '',
          responseMode: 'async',
        },
        agentrix: {
          ...(saved && saved.agentrix || {}),
          baseUrl: agentrixServiceConfig(env).baseUrl,
          apiKeyFingerprint: saved && saved.agentrix && saved.agentrix.apiKeyFingerprint || '',
        },
      },
    },
  };
}

async function updateUserAgentrixConfig({ store, session, input = {}, env = process.env }) {
  const userKey = sessionUserKey(session);
  if (!userKey) {
    return { status: 401, body: { error: 'gitlab_login_required' } };
  }
  const saved = await store.saveUserAgentrixConfig(userKey, {
    automation: input.automation || {},
    agentrix: {
      apiKey: input.agentrix && input.agentrix.apiKey || '',
      runnerId: input.agentrix && input.agentrix.runnerId || '',
      baseUrl: agentrixServiceConfig(env).baseUrl,
    },
  });
  return {
    status: 200,
    body: {
      config: {
        ...saved,
        agentrix: {
          ...(saved.agentrix || {}),
          baseUrl: agentrixServiceConfig(env).baseUrl,
        },
      },
    },
  };
}

export {
  getUserAgentrixConfig,
  mergeAgentrixInstallInput,
  savedAgentrixDefaults,
  updateUserAgentrixConfig,
}
