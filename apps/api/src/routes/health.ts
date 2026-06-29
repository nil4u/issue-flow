import type { FastifyInstance } from "fastify"

export async function healthRoutes(app: FastifyInstance) {
  app.get("/api/health", async () => {
    if (app.issueFlowStore.ready) {
      await app.issueFlowStore.ready
    }
    return { ok: true }
  })

  app.get("/health", async () => {
    if (app.issueFlowStore.ready) {
      await app.issueFlowStore.ready
    }
    return { ok: true }
  })
}
