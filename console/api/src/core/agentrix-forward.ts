// @ts-nocheck
import crypto from "node:crypto"
import { WebSocketServer } from "ws"

import { applyForwardedEventToTaskFacts } from "./task-projection.js"

// Receiver for the agentrix CLI event-forward protocol: the CLI daemon dials
// AGENTRIX_EVENT_FORWARD_WS_URL as a WebSocket client and sends JSON frames
// (hello -> hello-ack, events -> cumulative ack). Delivery is at-least-once in
// cursor order per machine; task_events dedupe by eventId.
const FORWARD_PROTOCOL_VERSION = 1
const DEFAULT_FORWARD_PATH = "/webhooks/agentrix/forward"
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

function forwardServerConfig(env = process.env) {
  return {
    token: String(env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN || "").trim(),
    path: String(env.ISSUE_FLOW_AGENTRIX_FORWARD_PATH || DEFAULT_FORWARD_PATH),
  }
}

function createForwardSession({ store, logger, send, close }) {
  let machineId = ""
  let handshaken = false
  let queue = Promise.resolve()

  async function handleHello(frame) {
    if (Number(frame.protocolVersion) !== FORWARD_PROTOCOL_VERSION) {
      close(4400, "unsupported_protocol_version")
      return
    }
    machineId = String(frame.machineId || "").trim()
    if (!machineId) {
      close(4400, "machine_id_required")
      return
    }
    handshaken = true
    const cursor = await store.getAgentrixForwardCursor(machineId)
    send({ type: "hello-ack", ...(cursor > 0 ? { resumeFromCursor: cursor } : {}) })
  }

  async function handleEvents(frame) {
    if (!handshaken) {
      close(4400, "hello_required")
      return
    }
    if (frame.droppedBeforeCursor) {
      logger?.warn?.({ machineId, droppedBeforeCursor: frame.droppedBeforeCursor }, "agentrix forward reported dropped events")
    }
    const events = Array.isArray(frame.events) ? frame.events : []
    let cursor = 0
    for (const event of events) {
      if (!event || typeof event !== "object") continue
      await applyForwardedEventToTaskFacts(store, event)
      const eventCursor = Number(event.cursor || 0)
      if (eventCursor > cursor) cursor = eventCursor
    }
    if (cursor > 0) {
      await store.setAgentrixForwardCursor(machineId, cursor)
      send({ type: "ack", cursor })
    }
  }

  function handleMessage(text) {
    queue = queue.then(async () => {
      let frame
      try {
        frame = JSON.parse(text)
      } catch {
        close(4400, "invalid_json")
        return
      }
      if (!frame || typeof frame !== "object") return
      if (frame.type === "hello") return handleHello(frame)
      if (frame.type === "events") return handleEvents(frame)
      return undefined
    }).catch((error) => {
      logger?.error?.({ err: error, machineId }, "agentrix forward processing failed")
      close(1011, "processing_failed")
    })
    return queue
  }

  return {
    handleMessage,
    machineId: () => machineId,
  }
}

function bearerTokenMatches(request, token) {
  const header = String(request.headers && request.headers.authorization || "")
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const provided = Buffer.from(match[1].trim())
  const expected = Buffer.from(token)
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function attachAgentrixForwardServer(app, options = {}) {
  const config = forwardServerConfig(options.env || process.env)
  if (!config.token) return undefined
  const store = app.issueFlowStore
  const logger = app.log
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

  app.server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://issue-flow.local").pathname
    if (pathname !== config.path) {
      rejectUpgrade(socket, 404, "Not Found")
      return
    }
    if (!bearerTokenMatches(request, config.token)) {
      rejectUpgrade(socket, 401, "Unauthorized")
      return
    }
    wss.handleUpgrade(request, socket, head, (connection) => {
      wss.emit("connection", connection, request)
    })
  })

  wss.on("connection", (connection) => {
    const session = createForwardSession({
      store,
      logger,
      send: (frame) => {
        if (connection.readyState === connection.OPEN) connection.send(JSON.stringify(frame))
      },
      close: (code, reason) => connection.close(code, reason),
    })
    connection.on("message", (data) => {
      void session.handleMessage(String(data))
    })
    connection.on("error", (error) => {
      logger.warn({ err: error, machineId: session.machineId() }, "agentrix forward websocket error")
    })
  })

  const close = () => {
    for (const client of wss.clients) {
      client.terminate()
    }
    wss.close()
  }
  app.addHook("onClose", async () => close())
  return { path: config.path, close }
}

export {
  attachAgentrixForwardServer,
  createForwardSession,
  forwardServerConfig,
}
