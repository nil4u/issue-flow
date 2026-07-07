// @ts-nocheck
import { agentrixServiceConfig } from './common.js'

async function agentrixRequest({ env = process.env, apiKey = '', path = '' }) {
  const baseUrl = agentrixServiceConfig(env).baseUrl
  const token = String(apiKey || '').trim()
  if (!token) {
    const error = new Error('Agentrix API key is required')
    error.status = 400
    error.code = 'agentrix_api_key_required'
    throw error
  }
  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })
  const text = await response.text()
  let body = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { message: text }
    }
  }
  if (!response.ok) {
    const error = new Error(body && (body.message || body.error) || `Agentrix request failed (${response.status})`)
    error.status = response.status
    error.code = response.status === 401 || response.status === 403 ? 'agentrix_api_key_invalid' : 'agentrix_request_failed'
    error.body = body
    throw error
  }
  return body
}

function publicAgentrixUser(profile = {}) {
  const user = profile.user || profile
  return {
    id: String(user.id || user.userId || ''),
    username: String(user.username || ''),
    email: String(user.email || ''),
    avatar: user.avatar || '',
    role: user.role || '',
    createdAt: user.createdAt || '',
  }
}

async function validateAgentrixApiKey({ env = process.env, apiKey = '' }) {
  const profile = await agentrixRequest({ env, apiKey, path: '/v1/auth/me' })
  const user = publicAgentrixUser(profile)
  if (!user.id) {
    const error = new Error('Agentrix did not return a user profile')
    error.status = 502
    error.code = 'agentrix_profile_invalid'
    throw error
  }
  return {
    status: 'valid',
    user,
    checkedAt: new Date().toISOString(),
  }
}

async function listAgentrixMachines({ env = process.env, apiKey = '' }) {
  const result = await agentrixRequest({ env, apiKey, path: '/v1/machines' })
  return {
    clouds: Array.isArray(result.clouds) ? result.clouds : [],
    localMachines: Array.isArray(result.localMachines) ? result.localMachines : [],
  }
}

async function listAgentrixPrivateClouds({ env = process.env, apiKey = '' }) {
  const result = await agentrixRequest({ env, apiKey, path: '/v1/private-clouds' })
  return {
    clouds: Array.isArray(result.clouds) ? result.clouds : [],
    entitlement: result.entitlement || {},
  }
}

async function getAgentrixPrivateCloudRunnerSecret({ env = process.env, apiKey = '', cloudId = '' }) {
  const id = String(cloudId || '').trim()
  if (!id) {
    const error = new Error('cloud id is required')
    error.status = 400
    error.code = 'cloud_id_required'
    throw error
  }
  const result = await agentrixRequest({
    env,
    apiKey,
    path: `/v1/private-clouds/${encodeURIComponent(id)}/runner-secret`,
  })
  return String(result.secret || '')
}

export {
  agentrixRequest,
  getAgentrixPrivateCloudRunnerSecret,
  listAgentrixMachines,
  listAgentrixPrivateClouds,
  publicAgentrixUser,
  validateAgentrixApiKey,
}
