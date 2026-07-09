// @ts-nocheck
import { agentrixServiceConfig } from './common.js'
import {
  listAgentrixMachines,
  listAgentrixPrivateClouds,
  validateAgentrixApiKey,
} from './agentrix-api.js'

function userAgentrixKey(userId) {
  return userId ? `user:${userId}` : ''
}

// TODO(cleanup): 惰性键迁移,发布 2 个 minor 版本后删除。
// 旧键格式为 `${gitServerId}:${username}`,命中后搬到 `user:<userId>` 并删除旧行。
async function migrateLegacyUserAgentrixConfig(store, userId, user) {
  for (const account of user && user.accounts || []) {
    if (!account || !account.username) continue
    const legacyKey = `${account.gitServerId || account.provider || 'git'}:${account.username}`
    const legacy = await store.getUserAgentrixConfig(legacyKey, { includeSecret: true })
    if (!legacy) continue
    await store.saveUserAgentrixConfig(userAgentrixKey(userId), {
      automation: legacy.automation || {},
      agentrix: legacy.agentrix || {},
    })
    await store.deleteUserAgentrixConfig(legacyKey)
    return true
  }
  return false
}

async function loadUserAgentrixConfig(store, userId, user, options = {}) {
  const userKey = userAgentrixKey(userId)
  const saved = await store.getUserAgentrixConfig(userKey, options)
  if (saved) return saved
  const migrated = await migrateLegacyUserAgentrixConfig(store, userId, user)
  return migrated ? store.getUserAgentrixConfig(userKey, options) : undefined
}

async function savedAgentrixDefaults(store, userId, env = process.env) {
  const userKey = userAgentrixKey(userId);
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

async function getUserAgentrixConfig({ store, userId, user, env = process.env }) {
  if (!userId) {
    return { status: 401, body: { error: 'login_required' } };
  }
  const saved = await loadUserAgentrixConfig(store, userId, user);
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

async function updateUserAgentrixConfig({ store, userId, input = {}, env = process.env, logger = undefined }) {
  const userKey = userAgentrixKey(userId);
  if (!userKey) {
    return { status: 401, body: { error: 'login_required' } };
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

async function getUserAgentrixResources({ store, userId, user, env = process.env, logger = undefined }) {
  const userKey = userAgentrixKey(userId);
  if (!userKey) {
    return { status: 401, body: { error: 'login_required' } };
  }
  const saved = await loadUserAgentrixConfig(store, userId, user, { includeSecret: true });
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
  userAgentrixKey,
}
