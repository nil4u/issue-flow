import type { FastifyInstance } from 'fastify'
import { configureGithubActionExecution } from "../core/github/action-execution.js"
import { listGithubProjectsWithInstallStatus, getGithubProjectRole } from '../core/github/projects.js'
import { contextFromRequest, sessionFromRequest } from '../services/issue-flow.js'

export async function githubRoutes(app: FastifyInstance) {
  for (const action of ['read', 'submit']) {
    app.post(`/api/github/action-execution/${action}`, async (request, reply) => {
      const input = (request.body || {}) as Record<string, unknown>
      const session = await sessionFromRequest(request, String(input.gitServerId || ''))
      const result = await configureGithubActionExecution({ ...contextFromRequest(request), input, session, save: action === 'submit' })
      return reply.code(result.status).send(result.body)
    })
  }
  for (const [path, action] of [['projects', listGithubProjectsWithInstallStatus], ['project-role', getGithubProjectRole]] as const) {
    app.post(`/api/github/${path}`, async (request, reply) => {
      const input = (request.body || {}) as Record<string, unknown>
      const session = await sessionFromRequest(request, String(input.gitServerId || ''))
      const result = await action({ ...contextFromRequest(request), input, session })
      return reply.code(result.status).send(result.body)
    })
  }
}
