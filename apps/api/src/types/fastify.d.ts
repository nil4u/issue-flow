import type { IssueFlowStore } from "../storage/store.js"

declare module "fastify" {
  interface FastifyInstance {
    issueFlowStore: IssueFlowStore
  }

  interface FastifyRequest {
    rawBody?: Buffer
    cookies: Record<string, string>
  }
}
