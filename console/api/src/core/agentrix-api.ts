import {
  GetPrivateCloudRunnerSecretResponseSchema,
  ListMachinesResponseSchema,
  ListPrivateCloudsResponseSchema,
  UserProfileResponseSchema,
} from '@agentrix/shared'
import { agentrixServiceConfig } from './common.js'

type AgentrixError = Error & {
  status?: number
  code?: string
  body?: unknown
}

function agentrixError(message: string, status: number, code: string, body?: unknown): AgentrixError {
  const error = new Error(message) as AgentrixError
  error.status = status
  error.code = code
  if (body !== undefined) error.body = body
  return error
}

async function agentrixRequest({ env = process.env, apiKey = '', path = '', schema = undefined }) {
  const baseUrl = agentrixServiceConfig(env).baseUrl
  const token = String(apiKey || '').trim()
  if (!token) {
    throw agentrixError('Agentrix API key is required', 400, 'agentrix_api_key_required')
  }
  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })
  const text = await response.text()
  let body: any = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { message: text }
    }
  }
  if (!response.ok) {
    throw agentrixError(
      body && (body.message || body.error) || `Agentrix request failed (${response.status})`,
      response.status,
      response.status === 401 || response.status === 403 ? 'agentrix_api_key_invalid' : 'agentrix_request_failed',
      body,
    )
  }
  if (!schema) return body
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data
  throw agentrixError(`Agentrix response schema mismatch for ${path}`, 502, 'agentrix_response_invalid', parsed.error.flatten())
}

function publicAgentrixUser(profile) {
  const user = profile.user
  return {
    id: String(user.id),
    username: String(user.username),
    email: String(user.email || ''),
    avatar: user.avatar || '',
    role: user.role || '',
    createdAt: user.createdAt || '',
  }
}

async function validateAgentrixApiKey({ env = process.env, apiKey = '' }) {
  const profile = await agentrixRequest({ env, apiKey, path: '/v1/auth/me', schema: UserProfileResponseSchema })
  const user = publicAgentrixUser(profile)
  return {
    status: 'valid',
    user,
    checkedAt: new Date().toISOString(),
  }
}

async function listAgentrixMachines({ env = process.env, apiKey = '' }) {
  const result = await agentrixRequest({ env, apiKey, path: '/v1/machines', schema: ListMachinesResponseSchema })
  return {
    clouds: result.clouds,
    localMachines: result.localMachines,
  }
}

async function listAgentrixPrivateClouds({ env = process.env, apiKey = '' }) {
  const result = await agentrixRequest({ env, apiKey, path: '/v1/private-clouds', schema: ListPrivateCloudsResponseSchema })
  return {
    clouds: result.clouds,
    entitlement: result.entitlement,
  }
}

async function getAgentrixPrivateCloudRunnerSecret({ env = process.env, apiKey = '', cloudId = '' }) {
  const id = String(cloudId || '').trim()
  if (!id) {
    throw agentrixError('cloud id is required', 400, 'cloud_id_required')
  }
  const result = await agentrixRequest({
    env,
    apiKey,
    path: `/v1/private-clouds/${encodeURIComponent(id)}/runner-secret`,
    schema: GetPrivateCloudRunnerSecretResponseSchema,
  })
  return result.secret
}

export {
  agentrixRequest,
  getAgentrixPrivateCloudRunnerSecret,
  listAgentrixMachines,
  listAgentrixPrivateClouds,
  publicAgentrixUser,
  validateAgentrixApiKey,
}
