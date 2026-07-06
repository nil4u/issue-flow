// @ts-nocheck
import crypto from "node:crypto"
import { createGitlabOAuthAuthorize } from "./gitlab-auth.js"

const DEFAULT_GITLAB_OAUTH_SCOPES = "api read_repository write_repository openid profile email"
let generatedSetupCode = ""
let generatedSetupCodeLogged = false

function configuredSetupCode(env = process.env) {
  return String(env.ISSUE_FLOW_SETUP_CODE || "").trim()
}

function randomSetupCode() {
  return `issue-flow-${crypto.randomBytes(16).toString("hex")}`
}

function setupCode(env = process.env) {
  const code = configuredSetupCode(env)
  if (code) return code
  if (!generatedSetupCode) {
    generatedSetupCode = randomSetupCode()
  }
  return generatedSetupCode
}

type SetupCodeLogger = {
  warn: (bindings: Record<string, unknown>, message: string) => void
}

function ensureSetupCode(options: { env?: NodeJS.ProcessEnv; logger?: SetupCodeLogger } = {}) {
  const { env = process.env, logger } = options
  const configured = configuredSetupCode(env)
  if (configured) return { code: configured, generated: false }

  const code = setupCode(env)
  env.ISSUE_FLOW_SETUP_CODE = code
  if (!generatedSetupCodeLogged && logger) {
    logger.warn({ setupCode: code }, "ISSUE_FLOW_SETUP_CODE is not set; generated temporary setup code")
    generatedSetupCodeLogged = true
  }
  return { code, generated: true }
}

function timingSafeEqualString(a = "", b = "") {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
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
    if (!server.commitAuthor?.name) missing.push("commitAuthor.name")
    if (!server.commitAuthor?.email) missing.push("commitAuthor.email")
  }
  return missing
}

function normalizedUrl(value = "") {
  return String(value || "").trim().replace(/\/+$/, "")
}

function gitlabHost(baseUrl = "") {
  try {
    return new URL(normalizedUrl(baseUrl)).hostname
  } catch {
    return ""
  }
}

function defaultGitlabId(baseUrl = "") {
  const host = gitlabHost(baseUrl)
  return host ? `gitlab-${host.replace(/\./g, "-")}` : ""
}

function defaultGitlabApiUrl(baseUrl = "") {
  const root = normalizedUrl(baseUrl)
  return root ? `${root}/api/v4` : ""
}

function defaultCommitAuthorEmail(baseUrl = "") {
  const parts = gitlabHost(baseUrl).split(".").filter(Boolean)
  const domain = parts.length >= 2 ? parts.slice(-2).join(".") : parts[0] || ""
  return domain ? `issue-flow@${domain}` : ""
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

async function initializeSetup({ store, basePublicUrl, appUrl, input = {}, env = process.env }) {
  const expectedCode = setupCode(env)
  if (!timingSafeEqualString(String(input.setupCode || ""), expectedCode)) {
    return { status: 401, body: { error: "setup_code_invalid" } }
  }

  const current = await getSetupStatus({ store, env })
  if (current.body.initialized) {
    return { status: 409, body: { error: "setup_already_initialized" } }
  }

  const baseUrl = normalizedUrl(input.baseUrl)
  const host = gitlabHost(baseUrl)
  const gitServer = await store.ensureGitServer({
    id: input.id || defaultGitlabId(baseUrl),
    type: input.type || "gitlab",
    name: input.name || host,
    baseUrl,
    apiUrl: normalizedUrl(input.apiUrl) || defaultGitlabApiUrl(baseUrl),
    tokenAuth: input.tokenAuth || "bearer",
    oauth: {
      clientId: input.oauth?.clientId || input.oauthClientId,
      clientSecret: input.oauth?.clientSecret || input.oauthClientSecret,
      scopes: input.oauth?.scopes || input.oauthScopes || DEFAULT_GITLAB_OAUTH_SCOPES,
    },
    webhook: {
      secret: input.webhook?.secret || input.webhookSecret || crypto.randomBytes(32).toString("hex"),
    },
    agentrixGitServerId: input.agentrixGitServerId,
    adminPat: input.adminPat,
    commitAuthor: {
      name: input.commitAuthor?.name || input.commitAuthorName || "issue-flow",
      email: input.commitAuthor?.email || input.commitAuthorEmail || defaultCommitAuthorEmail(baseUrl),
    },
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

  const authorize = await createGitlabOAuthAuthorize({
    store,
    basePublicUrl,
    appUrl,
    input: {
      gitServerId: gitServer.id,
      returnTo: "/repos",
      setupAdminEligible: true,
    },
  })

  return {
    status: 201,
    body: {
      ok: true,
      gitServer: store.publicGitServer(gitServer),
      authorizeUrl: authorize.authorizeUrl,
    },
  }
}

export {
  ensureSetupCode,
  getSetupStatus,
  initializeSetup,
}
