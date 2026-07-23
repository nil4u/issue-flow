// @ts-nocheck
import { gitServerInputFromSetup, gitServerMissingFields } from "./setup.js"

async function requireAdmin({ store, userId }) {
  const user = await store.getUser(userId)
  if (user?.role === "admin") return user
  return undefined
}

async function listGitServers({ store }) {
  return {
    status: 200,
    body: {
      gitServers: await store.listGitServers(),
    },
  };
}

async function saveGitServer({ store, userId, input = {} }) {
  if (!await requireAdmin({ store, userId })) {
    return { status: 403, body: { error: "admin_required" } }
  }
  const setupStyle = !String(input.id || "").trim()
  const gitServerInput = setupStyle ? gitServerInputFromSetup(input) : input
  if (setupStyle) {
    const missing = gitServerMissingFields(gitServerInput)
    if (missing.length) {
      return { status: 400, body: { error: "git_server_incomplete", missing } }
    }
  }
  const gitServer = await store.ensureGitServer(gitServerInput)
  return {
    status: 200,
    body: {
      gitServer: store.publicGitServer(gitServer),
    },
  }
}

async function deleteGitServer({ store, userId, gitServerId = "" }) {
  if (!await requireAdmin({ store, userId })) {
    return { status: 403, body: { error: "admin_required" } }
  }
  if (!gitServerId) {
    return { status: 400, body: { error: "git_server_id_required" } }
  }
  const deleted = await store.deleteGitServer(gitServerId)
  return {
    status: deleted ? 200 : 404,
    body: deleted ? { ok: true } : { error: "git_server_not_found" },
  }
}

export {
  deleteGitServer,
  listGitServers,
  saveGitServer,
}
