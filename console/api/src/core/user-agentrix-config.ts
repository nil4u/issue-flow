// @ts-nocheck
import { agentrixServiceConfig, sessionUserKey } from './common.js'
import {
  listAgentrixMachines,
  listAgentrixPrivateClouds,
  validateAgentrixApiKey,
} from './agentrix-api.js'

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

async function updateUserAgentrixConfig({ store, session, input = {}, env = process.env, logger = undefined }) {
  const userKey = sessionUserKey(session);
  if (!userKey) {
    return { status: 401, body: { error: 'gitlab_login_required' } };
  }
  const nextApiKey = input.agentrix && input.agentrix.apiKey
  let validation
  if (nextApiKey) {
    try {
      validation = await validateAgentrixApiKey({ env, apiKey: nextApiKey, logger })
    } catch (error) {
      return {
        status: error && error.status || 502,
        body: {
          error: error && error.code || 'agentrix_api_key_invalid',
          detail: error && error.message || '',
        },
      }
    }
  }
  const saved = await store.saveUserAgentrixConfig(userKey, {
    automation: input.automation || {},
    agentrix: {
      apiKey: nextApiKey || '',
      runnerId: input.agentrix && input.agentrix.runnerId || '',
      baseUrl: agentrixServiceConfig(env).baseUrl,
      user: validation && validation.user || input.agentrix && input.agentrix.user || undefined,
      checkedAt: validation && validation.checkedAt || input.agentrix && input.agentrix.checkedAt || undefined,
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

async function getUserAgentrixResources({ store, session, env = process.env, logger = undefined }) {
  const userKey = sessionUserKey(session);
  if (!userKey) {
    return { status: 401, body: { error: 'gitlab_login_required' } };
  }
  const saved = await store.getUserAgentrixConfig(userKey, { includeSecret: true });
  const apiKey = saved && saved.agentrix && saved.agentrix.apiKey || '';
  if (!apiKey) {
    return {
      status: 200,
      body: {
        configured: false,
        agentrix: {
          baseUrl: agentrixServiceConfig(env).baseUrl,
          apiKeyFingerprint: '',
        },
        privateClouds: [],
        localMachines: [],
        clouds: [],
      },
    };
  }
  try {
    const [validation, privateClouds, machines] = await Promise.all([
      validateAgentrixApiKey({ env, apiKey, logger }),
      listAgentrixPrivateClouds({ env, apiKey, logger }),
      listAgentrixMachines({ env, apiKey, logger }),
    ]);
    const updated = await store.saveUserAgentrixConfig(userKey, {
      agentrix: {
        apiKey,
        baseUrl: agentrixServiceConfig(env).baseUrl,
        runnerId: saved.agentrix && saved.agentrix.runnerId || '',
        user: validation.user,
        checkedAt: validation.checkedAt,
      },
    });
    return {
      status: 200,
      body: {
        configured: true,
        agentrix: updated.agentrix,
        privateClouds: privateClouds.clouds,
        entitlement: privateClouds.entitlement,
        localMachines: machines.localMachines,
        clouds: machines.clouds,
      },
    };
  } catch (error) {
    return {
      status: error && error.status || 502,
      body: {
        configured: true,
        error: error && error.code || 'agentrix_resources_failed',
        detail: error && error.message || '',
        agentrix: {
          ...(saved && saved.agentrix || {}),
          apiKey: undefined,
          baseUrl: agentrixServiceConfig(env).baseUrl,
        },
        privateClouds: [],
        localMachines: [],
        clouds: [],
      },
    };
  }
}

export {
  getUserAgentrixResources,
  getUserAgentrixConfig,
  mergeAgentrixInstallInput,
  savedAgentrixDefaults,
  updateUserAgentrixConfig,
}
