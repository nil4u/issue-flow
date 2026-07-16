// @ts-nocheck

async function listInstalledAutomations({ store, userId = "", page, perPage }) {
  const user = await store.getUser(userId)
  if (!user) {
    return { status: 401, body: { error: "login_required" } }
  }
  return {
    status: 200,
    body: await store.listInstalledAutomations({ userId, page, perPage }),
  }
}

export { listInstalledAutomations }
