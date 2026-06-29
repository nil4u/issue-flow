import dotenv from "dotenv"

import { createApp } from "./app.js"

const envFile = process.env.ISSUE_FLOW_ENV_FILE || (process.env.NODE_ENV === "production" ? ".env" : ".env.dev")
dotenv.config({ path: envFile })

const DEFAULT_HOST = "127.0.0.1"
const DEFAULT_PORT = 8788

async function start() {
  const host = process.env.ISSUE_FLOW_API_HOST || process.env.HOST || DEFAULT_HOST
  const port = Number(process.env.ISSUE_FLOW_API_PORT || process.env.PORT || DEFAULT_PORT)
  const app = await createApp()

  await app.listen({ host, port })

  const shutdown = async () => {
    await app.close()
    await app.issueFlowStore.close()
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  app.log.info({ host, port }, "issue-flow API started")
}

start().catch((error) => {
  console.error("issue-flow API failed to start", error && error.message ? error.message : error)
  process.exitCode = 1
})
