// @ts-nocheck
import crypto from 'node:crypto'
import { recordGitEvent, applyRepositoryChange } from '../events/consume.js'
import { githubEventFacts, githubPullRequestChange } from '../events/github.js'
import { applyOptimizationIssueLifecycle, optimizationIssueLifecycle } from '../optimization-lifecycle.js'
import { githubError, githubProject, installationClient } from './api.js'
import { githubRepositoryLifecycle } from './lifecycle.js'

export function verifyGithubSignature(secret, rawBody, signature) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(String(signature || ''))) return false
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

async function webhookServer(store, headers, rawBody) {
  const servers = await store.listGitServers({ includeSecret: true })
  return servers.find((server) => server.type === 'github'
    && (!headers['x-github-hook-installation-target-id'] || String(server.githubApp?.appId) === String(headers['x-github-hook-installation-target-id']))
    && verifyGithubSignature(server.webhook?.secret, rawBody, headers['x-hub-signature-256']))
}

async function consumeRepositoryEvent(store, server, repo, eventName, payload) {
  if (eventName === 'pull_request') await applyRepositoryChange({ store, repo, change: githubPullRequestChange(payload) })
  const lifecycle = eventName === 'issues' && !payload.issue?.pull_request ? optimizationIssueLifecycle(payload.issue) : undefined
  if (lifecycle) {
    const { client } = await installationClient(server, repo.fullName)
    await applyOptimizationIssueLifecycle({ server: client, repo, lifecycle })
  }
  if (eventName === 'repository' && payload.action === 'deleted') {
    await store.db.userRepoAccess.deleteMany({ where: { gitServerId: server.id, repoId: repo.id } })
  }
}

// --- App webhook 只同步事实；Actions 独立响应仓库事件 ---
export async function handleGithubWebhook({ store, headers, rawBody }) {
  const server = await webhookServer(store, headers, rawBody)
  if (!server) throw githubError('github_webhook_signature_invalid', 401)
  const deliveryId = String(headers['x-github-delivery'] || '')
  const eventName = String(headers['x-github-event'] || '')
  if (!deliveryId || !eventName) throw githubError('github_webhook_headers_required')
  const payload = JSON.parse(rawBody.toString('utf8'))
  if (eventName === 'ping') return { status: 200, body: { ok: true } }
  let repo
  if (payload.repository) {
    const project = githubProject(payload.repository)
    const row = await store.upsertRepo({ ...project, id: undefined, gitServerId: server.id })
    repo = await store.getRepository(row.id)
  }
  const subject = payload.comment || payload.pull_request || payload.issue || payload.workflow_run || payload.repository || {}
  await recordGitEvent(store, {
    repoId: repo?.id, gitServerId: server.id, repositoryId: String(payload.repository?.id || ''), repositoryFullName: payload.repository?.full_name || '',
    deliveryId, eventName, action: payload.action || '', objectId: String(subject.id || ''), objectType: eventName,
    payload, normalizedEvents: [{ eventName, eventAction: payload.action || '', provider: 'github' }],
  }, githubEventFacts)
  if (['installation', 'installation_repositories'].includes(eventName)) await githubRepositoryLifecycle(store, server, eventName, payload)
  if (repo) await consumeRepositoryEvent(store, server, repo, eventName, payload)
  return { status: 200, body: { ok: true, deliveryId } }
}
