// @ts-nocheck
import crypto from "node:crypto"

const SETUP_COOKIE_NAME = "issue_flow_setup_verified"
const SETUP_OAUTH_COOKIE_NAME = "issue_flow_oauth_setup"
const SETUP_COOKIE_TTL_SECONDS = 10 * 60

function setupVerifiedCookieName() {
  return SETUP_COOKIE_NAME
}

function setupOAuthCookieName() {
  return SETUP_OAUTH_COOKIE_NAME
}

function setupCode(env = process.env) {
  return String(env.ISSUE_FLOW_SETUP_CODE || "").trim()
}

function requiredSetupCode(env = process.env) {
  const code = setupCode(env)
  if (!code) {
    const error = new Error("ISSUE_FLOW_SETUP_CODE is required")
    error.status = 500
    error.code = "setup_code_not_configured"
    throw error
  }
  return code
}

function timingSafeEqualString(a = "", b = "") {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function setupCookieSignature(payload, env = process.env) {
  return crypto
    .createHmac("sha256", requiredSetupCode(env))
    .update(payload)
    .digest("base64url")
}

function signSetupCookie(input = {}, env = process.env) {
  const payload = Buffer.from(JSON.stringify({
    gitServerId: input.gitServerId || "",
    nonce: crypto.randomBytes(12).toString("hex"),
    exp: Date.now() + SETUP_COOKIE_TTL_SECONDS * 1000,
  })).toString("base64url")
  return `${payload}.${setupCookieSignature(payload, env)}`
}

function validateSetupCookie(value = "", input = {}, env = process.env) {
  const [payload, signature] = String(value || "").split(".")
  if (!payload || !signature) return false
  const expected = setupCookieSignature(payload, env)
  if (!timingSafeEqualString(signature, expected)) return false
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return false
  }
  if (!parsed || Number(parsed.exp || 0) < Date.now()) return false
  const gitServerId = String(input.gitServerId || "").trim()
  return !gitServerId || parsed.gitServerId === gitServerId
}

function gitServerMissingFields(server = {}) {
  const missing = []
  if (!server.id) missing.push("id")
  if (!server.type) missing.push("type")
  if (!server.baseUrl) missing.push("baseUrl")
  if (!server.apiUrl) missing.push("apiUrl")
  if (server.type === "gitlab") {
    if (!server.oauth?.clientId) missing.push("oauth.clientId")
    if (!server.oauth?.clientSecret) missing.push("oauth.clientSecret")
    if (!server.webhook?.secret) missing.push("webhook.secret")
    if (!server.agentrixGitServerId) missing.push("agentrixGitServerId")
    if (!server.adminPat) missing.push("adminPat")
  }
  return missing
}

async function getSetupStatus({ store, env = process.env }) {
  const gitServers = await store.listGitServers({ includeSecret: true })
  const serverStates = gitServers.map((server) => ({ server, missing: gitServerMissingFields(server) }))
  const configured = serverStates.some((item) => item.missing.length === 0)
  const firstIncomplete = serverStates.find((item) => item.missing.length)
  return {
    status: 200,
    body: {
      initialized: configured,
      needsSetup: !configured,
      state: gitServers.length === 0 ? "uninitialized" : configured ? "configured" : "broken",
      setupCodeConfigured: Boolean(setupCode(env)),
      missing: firstIncomplete?.missing || [],
      gitServers: gitServers.map((server) => store.publicGitServer(server)),
    },
  }
}

async function initializeSetup({ store, input = {}, env = process.env }) {
  const expectedCode = requiredSetupCode(env)
  if (!timingSafeEqualString(String(input.setupCode || ""), expectedCode)) {
    return { status: 401, body: { error: "setup_code_invalid" } }
  }

  const current = await getSetupStatus({ store, env })
  if (current.body.initialized) {
    return { status: 409, body: { error: "setup_already_initialized" } }
  }

  const gitServer = await store.ensureGitServer({
    id: input.id,
    type: input.type || "gitlab",
    name: input.name,
    baseUrl: input.baseUrl,
    apiUrl: input.apiUrl,
    tokenAuth: input.tokenAuth || "bearer",
    oauth: {
      clientId: input.oauth?.clientId || input.oauthClientId,
      clientSecret: input.oauth?.clientSecret || input.oauthClientSecret,
      redirectUri: input.oauth?.redirectUri || input.oauthRedirectUri || "",
      scopes: input.oauth?.scopes || input.oauthScopes || "api read_user read_repository write_repository openid profile email",
    },
    webhook: {
      secret: input.webhook?.secret || input.webhookSecret,
    },
    agentrixGitServerId: input.agentrixGitServerId,
    adminPat: input.adminPat,
  })

  const missing = gitServerMissingFields(gitServer)
  if (missing.length) {
    return {
      status: 400,
      body: {
        error: "git_server_incomplete",
        missing,
      },
    }
  }

  return {
    status: 201,
    body: {
      ok: true,
      gitServer: store.publicGitServer(gitServer),
      setupToken: signSetupCookie({ gitServerId: gitServer.id }, env),
      setupTokenMaxAge: SETUP_COOKIE_TTL_SECONDS,
    },
  }
}

export {
  SETUP_COOKIE_TTL_SECONDS,
  getSetupStatus,
  initializeSetup,
  setupOAuthCookieName,
  setupVerifiedCookieName,
  signSetupCookie,
  validateSetupCookie,
}
