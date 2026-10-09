import type { FastifyReply, FastifyRequest } from "fastify"
import { allowedOrigin } from "../../utils/http.js"

type InstallResult = { status: number; body: unknown }

export async function streamPluginInstall(
  request: FastifyRequest,
  reply: FastifyReply,
  install: (onProgress: (step: unknown) => void) => Promise<InstallResult>,
) {
  reply.hijack()
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": allowedOrigin(String(request.headers.origin || "")),
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  })
  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  try {
    const result = await install((step) => send("progress", step))
    const conflict = result.status === 409 && Array.isArray((result.body as { conflicts?: unknown }).conflicts)
    send(result.status < 400 ? "complete" : conflict ? "conflicts" : "error", result.body)
  } catch (error) {
    send("error", { error: error instanceof Error ? error.message : "install_plugin_stream_failed" })
  } finally {
    reply.raw.end()
  }
}
