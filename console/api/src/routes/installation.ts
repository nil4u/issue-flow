import type { FastifyInstance, FastifyRequest } from "fastify"
import { repositoryInstaller } from "../core/installation/registry.js"
import { checkProjectInstall, configureInstallStep, installPlan, installProjectPlugin } from "../core/installation/workflow.js"
import { contextFromRequest, sessionFromRequest } from "../services/issue-flow.js"
import { streamPluginInstall } from "./installation/stream.js"

async function installRequest(request: FastifyRequest) {
  const input = (request.body || {}) as Record<string, unknown>
  const session = await sessionFromRequest(request, String(input.gitServerId || ""))
  if (!session) throw Object.assign(new Error("git_login_required"), { status: 401 })
  const options = { ...contextFromRequest(request), input, session }
  return { options, adapter: await repositoryInstaller(options) }
}

export async function installationRoutes(app: FastifyInstance) {
  app.post("/api/installation/plan", async (request) => {
    const { adapter } = await installRequest(request)
    return installPlan(adapter)
  })
  for (const [path, action] of [
    ["check", checkProjectInstall],
    ["configure", configureInstallStep],
    ["plugin", installProjectPlugin],
  ] as const) {
    app.post(`/api/installation/${path}`, async (request, reply) => {
      const { options, adapter } = await installRequest(request)
      const result = await action(options, adapter)
      return reply.code(result.status).send(result.body)
    })
  }
  app.post("/api/installation/plugin/stream", async (request, reply) => {
    const { options, adapter } = await installRequest(request)
    return streamPluginInstall(request, reply, (onProgress) => installProjectPlugin({
      ...options, input: { ...options.input, onProgress },
    }, adapter))
  })
}
