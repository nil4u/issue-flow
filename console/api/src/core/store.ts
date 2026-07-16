// @ts-nocheck
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { db as prismaDb, prismaClient } from "../storage/db.js"
import {
  METRICS_MAX_ROWS,
  METRICS_STATEMENT_TIMEOUT_MS,
  assertReadOnlyMetricsSql,
  bindMetricsParams,
  metricsResultFromRows,
} from "./metrics-sql.js"
import {
  CONSOLE_SESSION_TTL_MS,
  TOUCH_INTERVAL_MS,
  hashConsoleSessionToken,
  newConsoleSessionToken,
} from "./console-session.js"
import { fingerprintSecret } from "./sanitize.js"
import { normalizeTaskAction } from "./task-projection.js"
import { LATEST_ISSUE_FLOW_VERSION, pluginNeedsUpgrade } from "./issue-flow-plugin.js"

const DEFAULT_STATE_DIR = ".issue-flow-service"
const TASK_SPAN_FLOW_BY_ACTION = {
  triage: "triage",
  plan: "plan",
  build: "build",
  review: "approve",
}

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "")
}

function normalizeApiUrl(baseUrl, apiUrl) {
  const explicit = normalizeBaseUrl(apiUrl)
  if (explicit) return explicit
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  return normalizedBaseUrl ? `${normalizedBaseUrl}/api/v4` : ""
}

function hostFromBaseUrl(baseUrl = "") {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname
  } catch {
    return ""
  }
}

function primaryDomainFromBaseUrl(baseUrl = "") {
  const parts = hostFromBaseUrl(baseUrl).split(".").filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join(".") : parts[0] || ""
}

function normalizeOauthScopes(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope && scope !== "read_user")
    .join(" ")
}

function normalizeAutomation(input = {}) {
  return {
    autoDefault: input.autoDefault || "triage",
    reviewEnabled: Boolean(input.reviewEnabled),
    agent: input.agent || "codex",
    runnerId: input.runnerId || "",
    responseMode: input.responseMode || "async",
  }
}

function normalizeAgentrix(input = {}, apiKeyFingerprint = "") {
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl || ""),
    apiKeyFingerprint,
    runnerId: input.runnerId || "",
  }
}

function normalizeRunnerId(value = "") {
  return String(value || "").trim()
}

function normalizeGitServer(input = {}, fingerprints = {}) {
  const type = input.type || "gitlab"
  const id = String(input.id || "").trim()
  const baseUrl = normalizeBaseUrl(input.baseUrl || "")
  const oauth = input.oauth || {}
  const commitAuthor = input.commitAuthor || input.commit_author || {}
  const commitAuthorName = String(commitAuthor.name || input.commitAuthorName || input.commit_author_name || "issue-flow").trim()
  const commitAuthorEmail = String(
    commitAuthor.email
      || input.commitAuthorEmail
      || input.commit_author_email
      || (primaryDomainFromBaseUrl(baseUrl) ? `issue-flow@${primaryDomainFromBaseUrl(baseUrl)}` : "")
  ).trim()
  const agentrixGitServerId = input.agentrixGitServerId || input.agentrix_git_server_id || input.agentrix && input.agentrix.gitServerId || ""
  return {
    id,
    type,
    name: input.name || baseUrl || id,
    baseUrl,
    apiUrl: normalizeApiUrl(baseUrl, input.apiUrl),
    tokenAuth: input.tokenAuth || "bearer",
    oauth: {
      clientId: oauth.clientId || "",
      scopes: normalizeOauthScopes(oauth.scopes),
      clientSecretFingerprint: fingerprints.oauthClientSecretFingerprint || "",
    },
    webhook: {
      secretFingerprint: fingerprints.webhookSecretFingerprint || "",
    },
    agentrixGitServerId,
    adminPatFingerprint: fingerprints.adminPatFingerprint || "",
    botPatFingerprint: fingerprints.botPatFingerprint || "",
    commitAuthor: {
      name: commitAuthorName,
      email: commitAuthorEmail,
    },
  }
}

function asDate(value) {
  return value ? new Date(value) : new Date()
}

function timestampValue(value) {
  return value instanceof Date ? value.toISOString() : value || ""
}

function rowData(row) {
  if (!row) return undefined
  if (typeof row.data === "string") return JSON.parse(row.data)
  return row.data
}

function normalizeUser(input = {}) {
  return {
    displayName: input.displayName || input.name || input.username || "",
    email: input.email || "",
    avatarUrl: input.avatarUrl || "",
    role: input.role || "member",
  }
}

function normalizeGitAccount(input = {}) {
  const provider = input.provider || input.gitServer && input.gitServer.type || "gitlab"
  const gitServerId = input.gitServerId || input.gitServer && input.gitServer.id || ""
  const providerUserId = String(input.providerUserId || input.id || input.username || "").trim()
  return {
    provider,
    gitServerId,
    providerUserId,
    username: input.username || "",
    displayName: input.displayName || input.name || input.username || "",
    email: input.email || "",
    avatarUrl: input.avatarUrl || "",
    scopes: input.scopes || [],
  }
}

function splitRepoFullName(fullName = "") {
  const parts = String(fullName || "").split("/").filter(Boolean)
  return {
    owner: parts[0] || "",
    name: parts[parts.length - 1] || "",
  }
}

function normalizeRepoIdentity(input = {}) {
  const fullName = String(
    input.fullName
    || input.projectPath
    || input.pathWithNamespace
    || ""
  ).trim()
  const split = splitRepoFullName(fullName)
  return {
    id: input.id || "",
    gitServerId: input.gitServerId || "",
    serverRepoId: String(input.serverRepoId || input.projectId || input.remoteId || input.id || fullName).trim(),
    owner: input.owner || split.owner,
    name: input.name || split.name,
    fullName,
    defaultBranch: input.defaultBranch || "",
    url: input.url || input.webUrl || "",
  }
}

function jsonValue(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }
  return value
}

function emptyRepoSettings() {
  return {
    permissions: { items: [], checkedAt: "" },
    variables: { items: [], checkedAt: "" },
    webhook: {},
    plugins: { items: [], checkedAt: "" },
    runners: { items: [], checkedAt: "" },
  }
}

function repoSettingData(row) {
  const data = rowData(row) || {}
  return {
    ...data,
    key: data.key || row.key || "",
    source: data.source || row.source || "",
  }
}

function latestTimestamp(current = "", next = "") {
  if (!next) return current
  if (!current) return next
  return String(next) > String(current) ? next : current
}

function repoTaskKey(row = {}) {
  return `${String(row.gitServerId || "")}::${String(row.repositoryId || "")}`
}

function nullableDate(value) {
  return value ? new Date(value) : null
}

class IssueFlowStore {
  constructor(options = {}) {
    const stateDir = path.resolve(process.cwd(), DEFAULT_STATE_DIR)
    this.stateDir = options.stateDir || process.env.ISSUE_FLOW_SERVICE_STATE_DIR || stateDir
    this.keyPath = options.keyPath || process.env.ISSUE_FLOW_SERVICE_KEY_FILE || path.join(this.stateDir, "key")
    this.key = options.key || process.env.ISSUE_FLOW_SERVICE_KEY || ""
    this.db = options.db || prismaDb
    this.ownsDb = !options.db
    this.metricsSchema = options.metricsSchema || process.env.ISSUE_FLOW_DB_SCHEMA || ""
    this.issueStatsDebounceMs = Number(options.issueStatsDebounceMs ?? process.env.ISSUE_FLOW_STATS_DEBOUNCE_MS ?? 2000)
    this.pendingIssueStatsRebuilds = new Map()
    this.issueStatsRebuildTimer = null
    this.issueStatsRebuildRun = Promise.resolve()
    this.ready = Promise.resolve()
  }

  async close() {
    await this.flushIssueStatsRebuilds()
    if (this.ownsDb) {
      await prismaClient.$disconnect()
    }
  }

  resolveCryptoKey() {
    const explicit = String(this.key || "").trim()
    if (explicit) {
      const hex = explicit.match(/^[0-9a-f]{64}$/i) ? Buffer.from(explicit, "hex") : undefined
      if (hex) return hex
      return crypto.createHash("sha256").update(explicit).digest()
    }

    ensureDir(this.stateDir)
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, `${crypto.randomBytes(32).toString("hex")}\n`, { mode: 0o600 })
    }
    return Buffer.from(fs.readFileSync(this.keyPath, "utf8").trim(), "hex")
  }

  encrypt(value) {
    if (!value) return ""
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", this.resolveCryptoKey(), iv)
    const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`
  }

  decrypt(value) {
    if (!value) return ""
    const [version, iv, tag, ciphertext] = String(value).split(":")
    if (version !== "v1" || !iv || !tag || !ciphertext) {
      throw new Error("Unsupported encrypted credential format")
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.resolveCryptoKey(), Buffer.from(iv, "base64"))
    decipher.setAuthTag(Buffer.from(tag, "base64"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8")
  }

  publicRepository(repo) {
    if (!repo) return undefined
    const projectPath = repo.projectPath || repo.fullName || repo.pathWithNamespace || ""
    const projectId = repo.projectId || repo.serverRepoId || ""
    const webhook = repo.webhook || {}
    const {
      install,
      installed,
      installedRepoId,
      oauthSessionId,
      ...publicRepo
    } = repo
    return {
      ...publicRepo,
      projectId,
      projectPath,
      pathWithNamespace: projectPath,
      fullName: repo.fullName || projectPath,
      name: repo.name || splitRepoFullName(projectPath).name,
      webUrl: repo.webUrl || repo.url || "",
      webhook: {
        ...webhook,
        hookId: webhook.hookId || "",
        secretFingerprint: webhook.secretFingerprint || "",
        lastRotatedAt: webhook.lastRotatedAt || "",
        bootstrapCommitId: webhook.bootstrapCommitId || "",
        bootstrapMergeRequest: webhook.bootstrapMergeRequest,
      },
      agentrix: {
        ...(repo.agentrix || {}),
        apiKeyFingerprint: repo.agentrix && repo.agentrix.apiKeyFingerprint || "",
      },
    }
  }

  publicRepositorySummary(row) {
    if (!row) return undefined
    const fullName = row.fullName || ""
    const split = splitRepoFullName(fullName)
    return this.publicRepository({
      id: row.id,
      gitServerId: row.gitServerId || "",
      serverRepoId: row.serverRepoId || "",
      projectId: row.serverRepoId || "",
      owner: row.owner || split.owner,
      name: row.name || split.name,
      fullName,
      projectPath: fullName,
      pathWithNamespace: fullName,
      defaultBranch: row.defaultBranch || "",
      url: row.url || "",
      webUrl: row.url || "",
      settings: undefined,
      webhook: {},
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    })
  }

  publicGitServer(server) {
    if (!server) return undefined
    return {
      ...server,
      oauth: {
        ...(server.oauth || {}),
        clientSecret: undefined,
        clientSecretFingerprint: server.oauth && server.oauth.clientSecretFingerprint || "",
      },
      webhook: {
        ...(server.webhook || {}),
        secret: undefined,
        secretFingerprint: server.webhook && server.webhook.secretFingerprint || "",
      },
      adminPat: undefined,
      adminPatFingerprint: server.adminPatFingerprint || "",
      botPat: undefined,
      botPatFingerprint: server.botPatFingerprint || "",
    }
  }

  publicUser(user, accounts = []) {
    if (!user) return undefined
    return {
      id: user.id,
      displayName: user.displayName || "",
      email: user.email || "",
      avatarUrl: user.avatarUrl || "",
      role: user.role || "member",
      createdAt: timestampValue(user.createdAt),
      updatedAt: timestampValue(user.updatedAt),
      accounts,
    }
  }

  userFromRecord(row, accounts = []) {
    if (!row) return undefined
    return this.publicUser({
      id: row.id,
      displayName: row.displayName || "",
      email: row.email || "",
      avatarUrl: row.avatarUrl || "",
      role: row.role || "member",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }, accounts)
  }

  userGitAccountFromRecord(row, gitServer) {
    if (!row) return undefined
    return {
      id: row.id,
      userId: row.userId,
      gitServerId: row.gitServerId,
      provider: row.provider || gitServer && gitServer.type || "gitlab",
      providerUserId: row.providerUserId || "",
      username: row.username || "",
      displayName: row.displayName || "",
      email: row.email || "",
      avatarUrl: row.avatarUrl || "",
      scopes: row.scopes || [],
      gitServer: gitServer ? this.publicGitServer(gitServer) : undefined,
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  async getUser(id, options = {}) {
    await this.ready
    if (!id) return undefined
    const row = await this.db.user.findUnique({ where: { id } })
    if (!row) return undefined
    const accounts = options.includeAccounts ? await this.listUserGitAccounts(id) : []
    return this.userFromRecord(row, accounts)
  }

  async createUser(input = {}) {
    await this.ready
    const id = input.id || randomId("user")
    const profile = normalizeUser(input)
    const createdAt = nowIso()
    const row = await this.db.user.create({
      data: {
        id,
        displayName: profile.displayName,
        email: profile.email,
        avatarUrl: profile.avatarUrl,
        role: profile.role,
        data: {
          displayName: profile.displayName,
          email: profile.email,
          avatarUrl: profile.avatarUrl,
        },
        createdAt: asDate(createdAt),
        updatedAt: asDate(createdAt),
      },
    })
    return this.userFromRecord(row)
  }

  async findUserGitAccount(input = {}) {
    await this.ready
    const account = normalizeGitAccount(input)
    if (!account.provider || !account.gitServerId || !account.providerUserId) return undefined
    const row = await this.db.userGitAccount.findUnique({
      where: {
        provider_gitServerId_providerUserId: {
          provider: account.provider,
          gitServerId: account.gitServerId,
          providerUserId: account.providerUserId,
        },
      },
    })
    if (!row) return undefined
    const gitServer = await this.getGitServer(row.gitServerId)
    return this.userGitAccountFromRecord(row, gitServer)
  }

  async listUserGitAccounts(userId) {
    await this.ready
    if (!userId) return []
    const rows = await this.db.userGitAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    })
    const gitServers = await this.listGitServers()
    const serverById = new Map(gitServers.map((server) => [server.id, server]))
    return rows.map((row) => this.userGitAccountFromRecord(row, serverById.get(row.gitServerId)))
  }

  async getUserGitAccount(userId, gitServerId) {
    await this.ready
    if (!userId || !gitServerId) return undefined
    const row = await this.db.userGitAccount.findUnique({
      where: {
        userId_gitServerId: { userId, gitServerId },
      },
    })
    if (!row) return undefined
    const gitServer = await this.getGitServer(row.gitServerId)
    return this.userGitAccountFromRecord(row, gitServer)
  }

  publicUserGitPat(row, options = {}) {
    if (!row) return undefined
    const data = row.personalAccessData && typeof row.personalAccessData === "object"
      ? row.personalAccessData
      : {}
    const result = {
      gitServerId: row.gitServerId,
      gitlabUserId: data.gitlabUserId || "",
      gitlabUsername: data.gitlabUsername || row.username || "",
      tokenFingerprint: data.tokenFingerprint || "",
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
      status: data.status || (data.tokenFingerprint ? "valid" : "missing"),
      checkedAt: data.checkedAt || "",
      expiresAt: data.expiresAt || "",
    }
    if (options.includeSecret) {
      result.token = this.decrypt(row.personalAccessToken || "")
    }
    return result
  }

  async getUserGitPat(userId, gitServerId, options = {}) {
    await this.ready
    if (!userId || !gitServerId) return undefined
    const row = await this.db.userGitAccount.findUnique({
      where: {
        userId_gitServerId: { userId, gitServerId },
      },
    })
    return this.publicUserGitPat(row, options)
  }

  async saveUserGitPat(userId, gitServerId, input = {}) {
    await this.ready
    const token = String(input.token || "").trim()
    if (!userId || !gitServerId || !token) {
      const error = new Error("user Git PAT requires user, Git server, and token")
      error.status = 400
      error.code = "user_git_pat_required"
      throw error
    }
    const data = {
      gitServerId,
      gitlabUserId: String(input.gitlabUserId || ""),
      gitlabUsername: String(input.gitlabUsername || ""),
      tokenFingerprint: fingerprintSecret(token),
      scopes: input.scopes || [],
      status: input.status || "valid",
      checkedAt: input.checkedAt || nowIso(),
      expiresAt: input.expiresAt || "",
    }
    const row = await this.db.userGitAccount.update({
      where: {
        userId_gitServerId: { userId, gitServerId },
      },
      data: {
        personalAccessToken: this.encrypt(token),
        personalAccessData: data,
      },
    })
    return this.publicUserGitPat(row, { includeSecret: true })
  }

  async deleteUserGitPat(userId, gitServerId) {
    await this.ready
    if (!userId || !gitServerId) return false
    const result = await this.db.userGitAccount.updateMany({
      where: { userId, gitServerId },
      data: {
        personalAccessToken: "",
        personalAccessData: {},
      },
    })
    return result.count > 0
  }

  async upsertUserGitAccount(userId, input = {}) {
    await this.ready
    const account = normalizeGitAccount(input)
    if (!userId || !account.gitServerId || !account.providerUserId) {
      const error = new Error("git account identity is required")
      error.status = 400
      error.code = "git_account_identity_required"
      throw error
    }
    const now = nowIso()
    const existingForUserServer = await this.db.userGitAccount.findUnique({
      where: {
        userId_gitServerId: {
          userId,
          gitServerId: account.gitServerId,
        },
      },
    })
    const data = {
      userId,
      gitServerId: account.gitServerId,
      provider: account.provider,
      providerUserId: account.providerUserId,
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      avatarUrl: account.avatarUrl,
      scopes: account.scopes,
      data: account,
      updatedAt: asDate(now),
    }
    const row = existingForUserServer
      ? await this.db.userGitAccount.update({
        where: { id: existingForUserServer.id },
        data,
      })
      : await this.db.userGitAccount.upsert({
      where: {
        provider_gitServerId_providerUserId: {
          provider: account.provider,
          gitServerId: account.gitServerId,
          providerUserId: account.providerUserId,
        },
      },
      create: {
        id: input.id || randomId("gitacct"),
        ...data,
        createdAt: asDate(now),
      },
      update: data,
    })
    const gitServer = await this.getGitServer(account.gitServerId)
    return this.userGitAccountFromRecord(row, gitServer)
  }

  async resolveUserForGitAccount(input = {}) {
    await this.ready
    const account = normalizeGitAccount(input.account || input)
    const result = await this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('issue_flow_first_admin'))")
      const existingAccount = account.provider && account.gitServerId && account.providerUserId
        ? await tx.userGitAccount.findUnique({
          where: {
            provider_gitServerId_providerUserId: {
              provider: account.provider,
              gitServerId: account.gitServerId,
              providerUserId: account.providerUserId,
            },
          },
        })
        : undefined
      const currentUser = input.currentUserId
        ? await tx.user.findUnique({ where: { id: input.currentUserId } })
        : undefined
      let user = currentUser
        || (existingAccount ? await tx.user.findUnique({ where: { id: existingAccount.userId } }) : undefined)
      if (!user) {
        const userCount = await tx.user.count()
        const role = input.setupAdminEligible && userCount === 0 ? "admin" : "member"
        const id = input.id || randomId("user")
        const profile = normalizeUser({
          displayName: account.displayName || account.username,
          email: account.email,
          avatarUrl: account.avatarUrl,
          role,
        })
        const createdAt = asDate(nowIso())
        user = await tx.user.create({
          data: {
            id,
            displayName: profile.displayName,
            email: profile.email,
            avatarUrl: profile.avatarUrl,
            role: profile.role,
            data: {
              displayName: profile.displayName,
              email: profile.email,
              avatarUrl: profile.avatarUrl,
            },
            createdAt,
            updatedAt: createdAt,
          },
        })
      }

      const now = asDate(nowIso())
      const existingForUserServer = await tx.userGitAccount.findUnique({
        where: {
          userId_gitServerId: {
            userId: user.id,
            gitServerId: account.gitServerId,
          },
        },
      })
      const data = {
        userId: user.id,
        gitServerId: account.gitServerId,
        provider: account.provider,
        providerUserId: account.providerUserId,
        username: account.username,
        displayName: account.displayName,
        email: account.email,
        avatarUrl: account.avatarUrl,
        scopes: account.scopes,
        data: account,
        updatedAt: now,
      }
      const accountCreated = !existingAccount && !existingForUserServer
      const savedAccount = existingForUserServer
        ? await tx.userGitAccount.update({
          where: { id: existingForUserServer.id },
          data,
        })
        : await tx.userGitAccount.upsert({
          where: {
            provider_gitServerId_providerUserId: {
              provider: account.provider,
              gitServerId: account.gitServerId,
              providerUserId: account.providerUserId,
            },
          },
          create: {
            id: input.account?.id || randomId("gitacct"),
            ...data,
            createdAt: now,
          },
          update: data,
        })
      return { userId: user.id, accountId: savedAccount.id, accountCreated }
    })
    const savedAccount = await this.findUserGitAccount(account)
    return {
      user: await this.getUser(result.userId, { includeAccounts: true }),
      account: savedAccount,
      accountCreated: Boolean(result.accountCreated),
    }
  }

  gitServerFromRecord(row, options = {}) {
    if (!row) return undefined
    const oauthClientSecret = String(row.oauthClientSecret || "")
    const webhookSecret = String(row.webhookSecret || "")
    const adminPat = String(row.adminPat || "")
    const botPat = String(row.botPat || "")
    const server = {
      id: row.id,
      type: row.type || "gitlab",
      name: row.name || row.baseUrl || row.id,
      baseUrl: normalizeBaseUrl(row.baseUrl || ""),
      apiUrl: normalizeApiUrl(row.baseUrl || "", row.apiUrl || ""),
      tokenAuth: row.tokenAuth || "bearer",
      oauth: {
        clientId: row.oauthClientId || "",
        scopes: normalizeOauthScopes(row.oauthScopes),
        clientSecretFingerprint: fingerprintSecret(oauthClientSecret),
      },
      webhook: {
        secretFingerprint: fingerprintSecret(webhookSecret),
      },
      agentrixGitServerId: row.agentrixGitServerId || row.agentrix_git_server_id || "",
      adminPatFingerprint: fingerprintSecret(adminPat),
      botPatFingerprint: fingerprintSecret(botPat),
      commitAuthor: {
        name: row.commitAuthorName || row.commit_author_name || "issue-flow",
        email: row.commitAuthorEmail || row.commit_author_email || "",
      },
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
    if (options.includeSecret) {
      server.oauth.clientSecret = oauthClientSecret
      server.webhook.secret = webhookSecret
      server.adminPat = adminPat
      server.botPat = botPat
      return server
    }
    return this.publicGitServer(server)
  }

  async getGitServer(id, options = {}) {
    await this.ready
    if (!id) return undefined
    const row = await this.db.gitServer.findUnique({ where: { id } })
    return this.gitServerFromRecord(row, options)
  }

  async listGitServers(options = {}) {
    await this.ready
    const rows = await this.db.gitServer.findMany({ orderBy: { createdAt: "desc" } })
    return rows.map((row) => this.gitServerFromRecord(row, options))
  }

  async ensureGitServer(input = {}) {
    await this.ready
    const normalized = normalizeGitServer(input)
    if (!normalized.id) {
      const error = new Error("git server id is required")
      error.status = 400
      throw error
    }
    if (!normalized.baseUrl || !normalized.apiUrl) {
      const error = new Error("git server base/api url is required")
      error.status = 400
      throw error
    }

    const hasOauthSecret = Boolean(input.oauth && Object.prototype.hasOwnProperty.call(input.oauth, "clientSecret"))
    const hasWebhookSecret = Boolean(input.webhook && Object.prototype.hasOwnProperty.call(input.webhook, "secret"))
    const hasAdminPat = Object.prototype.hasOwnProperty.call(input, "adminPat") || Object.prototype.hasOwnProperty.call(input, "admin_pat")
    const hasBotPat = Object.prototype.hasOwnProperty.call(input, "botPat") || Object.prototype.hasOwnProperty.call(input, "bot_pat")
    const hasAgentrixGitServerId = Object.prototype.hasOwnProperty.call(input, "agentrixGitServerId")
      || Object.prototype.hasOwnProperty.call(input, "agentrix_git_server_id")
      || Boolean(input.agentrix && Object.prototype.hasOwnProperty.call(input.agentrix, "gitServerId"))
    const hasCommitAuthor = Object.prototype.hasOwnProperty.call(input, "commitAuthor")
      || Object.prototype.hasOwnProperty.call(input, "commit_author")
      || Object.prototype.hasOwnProperty.call(input, "commitAuthorName")
      || Object.prototype.hasOwnProperty.call(input, "commitAuthorEmail")
      || Object.prototype.hasOwnProperty.call(input, "commit_author_name")
      || Object.prototype.hasOwnProperty.call(input, "commit_author_email")
    const existing = await this.getGitServer(normalized.id, { includeSecret: true })
    const oauthClientSecret = hasOauthSecret ? (input.oauth && input.oauth.clientSecret || "") : (existing && existing.oauth && existing.oauth.clientSecret || "")
    const webhookSecret = hasWebhookSecret ? (input.webhook && input.webhook.secret || "") : (existing && existing.webhook && existing.webhook.secret || "")
    const adminPat = hasAdminPat ? (input.adminPat || input.admin_pat || "") : (existing && existing.adminPat || "")
    const botPat = hasBotPat ? (input.botPat || input.bot_pat || "") : (existing && existing.botPat || "")
    const agentrixGitServerId = hasAgentrixGitServerId ? normalized.agentrixGitServerId : (existing && existing.agentrixGitServerId || normalized.agentrixGitServerId)
    const commitAuthor = hasCommitAuthor || !existing
      ? normalized.commitAuthor
      : existing.commitAuthor || normalized.commitAuthor
    const now = new Date()

    await this.db.gitServer.upsert({
      where: { id: normalized.id },
      create: {
        id: normalized.id,
        type: normalized.type,
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        apiUrl: normalized.apiUrl,
        tokenAuth: normalized.tokenAuth,
        oauthClientId: normalized.oauth.clientId,
        oauthClientSecret,
        oauthScopes: normalized.oauth.scopes,
        webhookSecret,
        agentrixGitServerId,
        adminPat,
        botPat,
        commitAuthorName: commitAuthor.name,
        commitAuthorEmail: commitAuthor.email,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        type: normalized.type,
        name: normalized.name,
        baseUrl: normalized.baseUrl,
        apiUrl: normalized.apiUrl,
        tokenAuth: normalized.tokenAuth,
        oauthClientId: normalized.oauth.clientId,
        oauthClientSecret,
        oauthScopes: normalized.oauth.scopes,
        webhookSecret,
        agentrixGitServerId,
        adminPat,
        botPat,
        commitAuthorName: commitAuthor.name,
        commitAuthorEmail: commitAuthor.email,
        updatedAt: now,
      },
    })
    return this.getGitServer(normalized.id, { includeSecret: true })
  }

  async deleteGitServer(id) {
    await this.ready
    const gitServerId = String(id || "").trim()
    if (!gitServerId) return false
    const existing = await this.getGitServer(gitServerId)
    if (!existing) return false
    await this.db.$transaction(async (tx) => {
      await tx.userRepoAccess.deleteMany({ where: { gitServerId } })
      await tx.oAuthSession.deleteMany({ where: { gitServerId } })
      await tx.gitServer.delete({ where: { id: gitServerId } })
    })
    return true
  }

  repoSettingsFromItems(rows = []) {
    const empty = emptyRepoSettings()
    const settings = {
      permissions: { ...empty.permissions, items: [] },
      variables: { ...empty.variables, items: [] },
      webhook: {},
      plugins: { ...empty.plugins, items: [] },
      runners: { ...empty.runners, items: [] },
    }
    for (const row of rows || []) {
      const data = repoSettingData(row)
      const checkedAt = timestampValue(row.checkedAt)
      if (row.kind === "permission") {
        settings.permissions.items.push(data)
        settings.permissions.checkedAt = latestTimestamp(settings.permissions.checkedAt, checkedAt)
        continue
      }
      if (row.kind === "variable") {
        settings.variables.items.push(data)
        settings.variables.checkedAt = latestTimestamp(settings.variables.checkedAt, checkedAt)
        continue
      }
      if (row.kind === "webhook") {
        settings.webhook = {
          ...settings.webhook,
          ...data,
          checkedAt: latestTimestamp(settings.webhook.checkedAt || "", checkedAt),
        }
        continue
      }
      if (row.kind === "plugin") {
        settings.plugins.items.push(data)
        settings.plugins.checkedAt = latestTimestamp(settings.plugins.checkedAt, checkedAt)
        continue
      }
      if (row.kind === "runner") {
        settings.runners.items.push(data)
        settings.runners.checkedAt = latestTimestamp(settings.runners.checkedAt, checkedAt)
      }
    }
    settings.permissions.items.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")))
    settings.variables.items.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")))
    settings.plugins.items.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")))
    settings.runners.items.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")))
    return settings
  }

  repoFromRecord(row, settingRows = [], gitServer) {
    if (!row) return undefined
    const settings = this.repoSettingsFromItems(settingRows)
    const identity = {
      id: row.id,
      provider: gitServer && gitServer.type || "",
      gitServerId: row.gitServerId || "",
      serverRepoId: row.serverRepoId || settings.projectId || "",
      projectId: row.serverRepoId || settings.projectId || "",
      owner: row.owner || splitRepoFullName(row.fullName).owner,
      name: row.name || splitRepoFullName(row.fullName).name,
      fullName: row.fullName || settings.projectPath || "",
      projectPath: row.fullName || settings.projectPath || "",
      pathWithNamespace: row.fullName || settings.projectPath || "",
      defaultBranch: row.defaultBranch || settings.defaultBranch || "",
      url: row.url || settings.webUrl || "",
      webUrl: row.url || settings.webUrl || "",
      baseUrl: gitServer && gitServer.baseUrl || "",
      apiUrl: gitServer && gitServer.apiUrl || "",
      tokenAuth: gitServer && gitServer.tokenAuth || "bearer",
      automation: normalizeAutomation({}),
      agentrix: normalizeAgentrix({}),
      webhook: settings.webhook || {},
      lastDeliveryAt: "",
      lastDispatchAt: "",
      lastError: "",
      settings,
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
    return this.publicRepository(identity)
  }

  settingItemInput(item = {}, checkedAt = nowIso()) {
    const data = item.data || item
    return {
      kind: String(item.kind || "").trim(),
      key: String(item.key || data.key || "").trim(),
      source: String(item.source || data.source || "").trim(),
      data: {
        ...data,
        key: data.key || item.key || "",
        source: data.source || item.source || "",
      },
      checkedAt: checkedAt ? asDate(checkedAt) : undefined,
    }
  }

  async upsertRepoSettingItem(repoId, item = {}, client = this.db) {
    const normalized = this.settingItemInput(item, item.checkedAt || nowIso())
    if (!repoId || !normalized.kind || !normalized.key) return undefined
    const now = new Date()
    return client.repoSettingItem.upsert({
      where: {
        repoId_kind_key: {
          repoId,
          kind: normalized.kind,
          key: normalized.key,
        },
      },
      create: {
        id: randomId("repo_setting"),
        repoId,
        kind: normalized.kind,
        key: normalized.key,
        source: normalized.source,
        data: normalized.data,
        checkedAt: normalized.checkedAt,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        source: normalized.source,
        data: normalized.data,
        checkedAt: normalized.checkedAt,
        updatedAt: now,
      },
    })
  }

  async replaceRepoSettingItems(repoId, kind, items = [], checkedAt = nowIso(), client = this.db) {
    if (!repoId || !kind) return { count: 0 }
    await client.repoSettingItem.deleteMany({ where: { repoId, kind } })
    const rows = (items || [])
      .map((item) => this.settingItemInput({ ...item, kind }, checkedAt))
      .filter((item) => item.key)
    if (!rows.length) return { count: 0 }
    const now = new Date()
    await client.repoSettingItem.createMany({
      data: rows.map((item) => ({
        id: randomId("repo_setting"),
        repoId,
        kind: item.kind,
        key: item.key,
        source: item.source,
        data: item.data,
        checkedAt: item.checkedAt,
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
    })
    return { count: rows.length }
  }

  async upsertRepo(input = {}, client = this.db) {
    const repo = normalizeRepoIdentity(input)
    if (!repo.gitServerId || !repo.serverRepoId) {
      const error = new Error("repo git server and remote id are required")
      error.status = 400
      error.code = "repo_identity_required"
      throw error
    }
    const now = new Date()
    const existing = await client.repo.findUnique({
      where: {
        gitServerId_serverRepoId: {
          gitServerId: repo.gitServerId,
          serverRepoId: repo.serverRepoId,
        },
      },
    }).catch((error) => {
      if (error && error.code === "P2025") return undefined
      throw error
    })
    const id = repo.id || existing && existing.id || randomId("repo")
    const data = {
      gitServerId: repo.gitServerId,
      serverRepoId: repo.serverRepoId,
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      url: repo.url,
      updatedAt: now,
    }
    const row = await client.repo.upsert({
      where: {
        gitServerId_serverRepoId: {
          gitServerId: repo.gitServerId,
          serverRepoId: repo.serverRepoId,
        },
      },
      create: {
        id,
        ...data,
        createdAt: now,
      },
      update: data,
    })
    return row
  }

  async grantUserRepoAccess(input = {}, client = this.db) {
    const userId = String(input.userId || "").trim()
    const gitServerId = String(input.gitServerId || "").trim()
    const repoId = String(input.repoId || "").trim()
    if (!userId || !gitServerId || !repoId) return undefined
    const now = new Date()
    return client.userRepoAccess.upsert({
      where: {
        userId_gitServerId_repoId: {
          userId,
          gitServerId,
          repoId,
        },
      },
      create: {
        userId,
        gitServerId,
        repoId,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        updatedAt: now,
      },
    })
  }

  async replaceUserRepoAccesses(input = {}, client = this.db) {
    const userId = String(input.userId || "").trim()
    const gitServerId = String(input.gitServerId || "").trim()
    if (!userId || !gitServerId) return { count: 0 }
    const repoIds = Array.from(new Set((input.repoIds || []).map((item) => String(item || "").trim()).filter(Boolean)))
    const now = new Date()
    await client.userRepoAccess.deleteMany({
      where: { userId, gitServerId },
    })
    if (!repoIds.length) return { count: 0 }
    await client.userRepoAccess.createMany({
      data: repoIds.map((repoId) => ({
        userId,
        gitServerId,
        repoId,
        createdAt: now,
        updatedAt: now,
      })),
      skipDuplicates: true,
    })
    return { count: repoIds.length }
  }

  async userCanAccessRepo(userId, repoId, gitServerId = "") {
    await this.ready
    const user = await this.getUser(userId)
    if (user?.role === "admin") return true
    const where = {
      userId: String(userId || "").trim(),
      repoId: String(repoId || "").trim(),
      ...(gitServerId ? { gitServerId: String(gitServerId || "").trim() } : {}),
    }
    if (!where.userId || !where.repoId) return false
    return (await this.db.userRepoAccess.count({ where })) > 0
  }

  async syncRepositories(input = {}) {
    await this.ready
    const gitServer = input.gitServerId ? await this.getGitServer(input.gitServerId) : undefined
    const projects = input.projects || input.repositories || []
    const rows = []
    for (const project of projects) {
      const row = await this.upsertRepo({
        gitServerId: input.gitServerId,
        serverRepoId: project.serverRepoId || project.id,
        owner: project.owner,
        name: project.name,
        fullName: project.fullName || project.pathWithNamespace,
        defaultBranch: project.defaultBranch,
        url: project.url || project.webUrl,
      })
      const settingRows = await this.db.repoSettingItem.findMany({ where: { repoId: row.id } })
      rows.push(this.repoFromRecord(row, settingRows, gitServer))
    }
    if (input.userId) {
      await this.replaceUserRepoAccesses({
        userId: input.userId,
        gitServerId: input.gitServerId,
        repoIds: rows.map((row) => row.id),
      })
    }
    return rows
  }

  async insertRepository(repo, client = this.db) {
    const identity = await this.upsertRepo(repo, client)
    repo.id = identity.id
    await this.saveRepositorySettingItems(repo, client)
  }

  async saveRepository(repo, client = this.db) {
    await this.ready
    repo.updatedAt = repo.updatedAt || nowIso()
    const identity = await this.upsertRepo(repo, client)
    repo.id = identity.id
    await this.saveRepositorySettingItems(repo, client)
  }

  async saveRepositorySettingItems(repo, client = this.db) {
    const checkedAt = repo.updatedAt || repo.createdAt || nowIso()
    const variables = repo.settings && repo.settings.variables && repo.settings.variables.items || []
    if (variables.length) {
      await this.replaceRepoSettingItems(repo.id, "variable", variables, repo.settings.variables.checkedAt || checkedAt, client)
    }
    const webhook = {
      ...(repo.settings && repo.settings.webhook || {}),
      ...(repo.webhook || {}),
    }
    if (Object.keys(webhook).length) {
      await this.upsertRepoSettingItem(repo.id, {
        kind: "webhook",
        key: webhook.key || "issue-flow",
        source: webhook.source || "gitlab",
        data: webhook,
        checkedAt,
      }, client)
    }
  }

  async listRepositories(options = {}) {
    await this.ready
    const userId = String(options.userId || "").trim()
    const user = userId ? await this.getUser(userId) : undefined
    const isAdmin = user?.role === "admin"
    const page = Math.max(1, Number(options.page || 1) || 1)
    const perPage = Math.min(100, Math.max(10, Number(options.perPage || 50) || 50))
    if (!userId) return { repositories: [], owners: [], page, perPage, total: 0, hasMore: false }
    const q = String(options.q || "").trim()
    const owner = String(options.owner || "").trim()
    const activeOwner = q ? "" : owner
    const selectedProjectId = String(options.selectedProjectId || "").trim()
    const accessRows = isAdmin
      ? await this.db.repo.findMany({
        where: options.gitServerId ? { gitServerId: options.gitServerId } : {},
        select: { id: true },
      })
      : await this.db.userRepoAccess.findMany({
        where: {
          userId,
          ...(options.gitServerId ? { gitServerId: options.gitServerId } : {}),
        },
        select: { repoId: true },
      })
    const repoIds = accessRows.map((row) => row.repoId)
    if (!repoIds.length) return { repositories: [], owners: [], page, perPage, total: 0, hasMore: false }
    const where = {
      id: { in: repoIds },
      ...(options.gitServerId ? { gitServerId: options.gitServerId } : {}),
      ...(activeOwner && activeOwner !== "all" ? { owner: activeOwner } : {}),
      ...(q ? { fullName: { contains: q } } : {}),
    }
    const [pageRows, total, ownerRows] = await Promise.all([
      this.db.repo.findMany({
        where,
        orderBy: { fullName: "asc" },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.db.repo.count({ where }),
      this.db.repo.findMany({
        where: {
          id: { in: repoIds },
          ...(options.gitServerId ? { gitServerId: options.gitServerId } : {}),
        },
        select: { owner: true, fullName: true },
        orderBy: { owner: "asc" },
      }),
    ])
    let rows = pageRows
    if (selectedProjectId && !rows.some((row) => row.id === selectedProjectId || row.serverRepoId === selectedProjectId)) {
      const selected = await this.db.repo.findFirst({
        where: {
          ...where,
          OR: [
            { id: selectedProjectId },
            { serverRepoId: selectedProjectId },
          ],
        },
      })
      if (selected) rows = [selected, ...rows]
    }
    const owners = Array.from(new Set(ownerRows.map((row) => row.owner || splitRepoFullName(row.fullName).owner).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    return {
      repositories: rows.map((row) => this.publicRepositorySummary(row)),
      owners,
      page,
      perPage,
      total,
      hasMore: page * perPage < total,
    }
  }

  async listInstalledAutomations(options = {}) {
    await this.ready
    const userId = String(options.userId || "").trim()
    const page = Math.max(1, Math.floor(Number(options.page || 1) || 1))
    const perPage = Math.min(100, Math.max(10, Math.floor(Number(options.perPage || 20) || 20)))
    const user = userId ? await this.getUser(userId) : undefined
    const isAdmin = user?.role === "admin"
    const accessRows = isAdmin
      ? []
      : await this.db.userRepoAccess.findMany({
        where: { userId },
        select: { repoId: true },
      })
    const accessibleRepoIds = new Set(accessRows.map((row) => row.repoId))
    const rows = await this.db.repo.findMany({
      include: { gitServer: true, settings: true },
      orderBy: { fullName: "asc" },
    })
    const scopedRows = isAdmin ? rows : rows.filter((row) => accessibleRepoIds.has(row.id))
    const pairs = scopedRows
      .filter((row) => row.gitServerId && row.serverRepoId)
      .map((row) => ({ gitServerId: row.gitServerId, repositoryId: row.serverRepoId }))
    const [aggregateRows, latestRows] = pairs.length
      ? await Promise.all([
        this.db.$queryRawUnsafe(`
          SELECT
            "git_server_id" AS "gitServerId",
            "repository_id" AS "repositoryId",
            COUNT(*)::int AS "total",
            COUNT(*) FILTER (WHERE "status" IN ('queued', 'running'))::int AS "active",
            COUNT(*) FILTER (WHERE "status" = 'failed')::int AS "failed",
            COUNT(*) FILTER (WHERE "status" = 'succeeded')::int AS "succeeded",
            MAX("updated_at") AS "lastTaskAt",
            MAX("updated_at") FILTER (WHERE "status" = 'succeeded') AS "lastSuccessAt",
            MAX("updated_at") FILTER (WHERE "status" = 'failed') AS "lastFailureAt"
          FROM "tasks"
          GROUP BY "git_server_id", "repository_id"
        `),
        this.db.$queryRawUnsafe(`
          SELECT DISTINCT ON ("git_server_id", "repository_id")
            "git_server_id" AS "gitServerId",
            "repository_id" AS "repositoryId",
            "task_id" AS "taskId",
            "issue_number" AS "issueNumber",
            "action",
            "status",
            "updated_at" AS "updatedAt"
          FROM "tasks"
          ORDER BY "git_server_id", "repository_id", "updated_at" DESC, "id" DESC
        `),
      ])
      : [[], []]
    const aggregateByRepo = new Map(aggregateRows.map((row) => [repoTaskKey(row), row]))
    const latestByRepo = new Map(latestRows.map((row) => [repoTaskKey(row), row]))
    const installations = scopedRows.map((row) => {
      const setting = (row.settings || []).find((item) => item.kind === "plugin" && item.key === "issue-flow")
      const plugin = jsonValue(setting && setting.data, {}) || {}
      if (!plugin.installed) return undefined
      const key = repoTaskKey({ gitServerId: row.gitServerId, repositoryId: row.serverRepoId })
      const aggregate = aggregateByRepo.get(key) || {}
      const latestTask = latestByRepo.get(key)
      const installedVersion = plugin.installedVersion || ""
      const latestVersion = LATEST_ISSUE_FLOW_VERSION
      const needsUpgrade = pluginNeedsUpgrade(installedVersion, latestVersion)
      return {
        id: row.id,
        gitServerId: row.gitServerId || "",
        projectId: row.serverRepoId || "",
        projectPath: row.fullName || "",
        name: row.name || row.fullName || "",
        webUrl: row.url || "",
        provider: row.gitServer && row.gitServer.type || "",
        serverName: row.gitServer && row.gitServer.name || "",
        plugin: {
          key: "issue-flow",
          installedVersion,
          latestVersion,
          status: needsUpgrade ? "needs_upgrade" : "passed",
          detail: plugin.detail || "",
          needsUpgrade,
          checkedAt: timestampValue(setting && setting.checkedAt),
        },
        tasks: {
          total: Number(aggregate.total || 0),
          active: Number(aggregate.active || 0),
          failed: Number(aggregate.failed || 0),
          succeeded: Number(aggregate.succeeded || 0),
          lastTaskAt: timestampValue(aggregate.lastTaskAt),
          lastSuccessAt: timestampValue(aggregate.lastSuccessAt),
          lastFailureAt: timestampValue(aggregate.lastFailureAt),
          latest: latestTask ? {
            taskId: latestTask.taskId || "",
            issueNumber: Number(latestTask.issueNumber || 0),
            action: latestTask.action || "",
            status: latestTask.status || "",
            updatedAt: timestampValue(latestTask.updatedAt),
          } : undefined,
        },
      }
    }).filter(Boolean)
    const total = installations.length
    const start = (page - 1) * perPage
    return {
      installations: installations.slice(start, start + perPage),
      page,
      perPage,
      total,
      hasMore: page * perPage < total,
    }
  }

  async getRepository(id) {
    await this.ready
    const row = await this.db.repo.findUnique({ where: { id } })
    if (!row) return undefined
    const settings = await this.db.repoSettingItem.findMany({ where: { repoId: id } })
    const gitServer = row.gitServerId ? await this.getGitServer(row.gitServerId) : undefined
    return this.repoFromRecord(row, settings, gitServer)
  }

  async findRepositoryByProject(project = {}) {
    const projectId = project.projectId ? String(project.projectId) : ""
    const projectPath = String(project.projectPath || "").trim()
    const gitServerId = String(project.gitServerId || "").trim()
    if (!projectId && !projectPath) return undefined
    const rows = await this.db.repo.findMany({
      where: {
        ...(gitServerId ? { gitServerId } : {}),
        OR: [
          ...(projectId ? [{ serverRepoId: projectId }] : []),
          ...(projectPath ? [{ fullName: projectPath }] : []),
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    })
    for (const row of rows) {
      const settings = await this.db.repoSettingItem.findMany({ where: { repoId: row.id } })
      const gitServer = row.gitServerId ? await this.getGitServer(row.gitServerId) : undefined
      return this.repoFromRecord(row, settings, gitServer)
    }
    return undefined
  }

  async createRepository(input = {}, validation = {}) {
    await this.ready
    const repoIdentity = normalizeRepoIdentity({
      id: input.id || "",
      gitServerId: input.gitServerId || "",
      serverRepoId: validation.projectId || input.projectId || "",
      fullName: input.projectPath || input.fullName || "",
      defaultBranch: validation.defaultBranch || input.defaultBranch || "",
      url: input.webUrl || input.url || "",
    })
    const existingRepo = repoIdentity.gitServerId && repoIdentity.serverRepoId
      ? await this.db.repo.findUnique({
        where: {
          gitServerId_serverRepoId: {
            gitServerId: repoIdentity.gitServerId,
            serverRepoId: repoIdentity.serverRepoId,
          },
        },
      })
      : undefined
    const id = input.id || existingRepo && existingRepo.id || randomId("repo")
    const createdAt = nowIso()
    const repo = {
      id,
      provider: input.provider || "",
      gitServerId: input.gitServerId || "",
      tokenAuth: input.tokenAuth || "bearer",
      baseUrl: normalizeBaseUrl(input.baseUrl || "https://gitlab.com"),
      apiUrl: normalizeApiUrl(input.baseUrl || "https://gitlab.com", input.apiUrl),
      projectPath: String(input.projectPath || "").trim(),
      projectId: validation.projectId ? String(validation.projectId) : "",
      defaultBranch: validation.defaultBranch || input.defaultBranch || "",
      automation: normalizeAutomation(input.automation || {}),
      agentrix: normalizeAgentrix(input.agentrix || {}, fingerprintSecret(input.agentrix && input.agentrix.apiKey)),
      webhook: {},
      lastDeliveryAt: "",
      lastDispatchAt: "",
      lastError: "",
      createdAt,
      updatedAt: createdAt,
    }

    await this.db.$transaction(async (tx) => {
      await this.insertRepository(repo, tx)
      if (input.userId) {
        await this.grantUserRepoAccess({
          userId: input.userId,
          gitServerId: repo.gitServerId,
          repoId: repo.id,
        }, tx)
      }
    })

    return { repo: this.publicRepository(repo) }
  }

  async updateRepositoryAutomation(repoId, input = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined

    repo.automation = normalizeAutomation({
      ...(repo.automation || {}),
      ...(input.automation || {}),
    })
    if (input.tokenAuth !== undefined) {
      repo.tokenAuth = input.tokenAuth || "bearer"
    }
    repo.agentrix = normalizeAgentrix(input.agentrix || repo.agentrix || {}, fingerprintSecret(input.agentrix && input.agentrix.apiKey))
    repo.updatedAt = nowIso()

    await this.saveRepository(repo)
    return this.publicRepository(repo)
  }

  async updateRepositoryWebhookCache(repoId, patch = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    repo.webhook = {
      ...(repo.webhook || {}),
      hookId: patch.hookId !== undefined ? patch.hookId || "" : repo.webhook && repo.webhook.hookId || "",
      bootstrapCommitId: patch.bootstrapCommitId !== undefined ? patch.bootstrapCommitId || "" : repo.webhook && repo.webhook.bootstrapCommitId || "",
      bootstrapMergeRequest: patch.bootstrapMergeRequest !== undefined ? patch.bootstrapMergeRequest : repo.webhook && repo.webhook.bootstrapMergeRequest,
    }
    repo.updatedAt = nowIso()
    await this.saveRepository(repo)
    return this.publicRepository(repo)
  }

  async updateTokenValidation(repoId, validation = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    repo.projectId = validation.projectId ? String(validation.projectId) : repo.projectId
    repo.defaultBranch = validation.defaultBranch || repo.defaultBranch
    repo.updatedAt = nowIso()
    await this.saveRepository(repo)
    return this.publicRepository(repo)
  }

  async updateRepositorySettingsCache(repoId, patch = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    const updatedAt = nowIso()
    await this.db.$transaction(async (tx) => {
      if (patch.variables) {
        await this.replaceRepoSettingItems(
          repoId,
          "variable",
          patch.variables.items || [],
          patch.variables.checkedAt || updatedAt,
          tx
        )
      }
      if (patch.permissions) {
        await this.replaceRepoSettingItems(
          repoId,
          "permission",
          patch.permissions.items || [],
          patch.permissions.checkedAt || updatedAt,
          tx
        )
      }
      if (Object.prototype.hasOwnProperty.call(patch, "webhook")) {
        if (patch.webhook) {
          await this.upsertRepoSettingItem(repoId, {
            kind: "webhook",
            key: patch.webhook.key || "issue-flow",
            source: patch.webhook.source || "gitlab",
            data: patch.webhook,
            checkedAt: patch.webhook.checkedAt || updatedAt,
          }, tx)
        } else {
          await tx.repoSettingItem.deleteMany({
            where: { repoId, kind: "webhook", key: "issue-flow" },
          })
        }
      }
      if (patch.plugins) {
        await this.replaceRepoSettingItems(
          repoId,
          "plugin",
          patch.plugins.items || [],
          patch.plugins.checkedAt || updatedAt,
          tx
        )
      }
      if (patch.runners) {
        await this.replaceRepoSettingItems(
          repoId,
          "runner",
          patch.runners.items || [],
          patch.runners.checkedAt || updatedAt,
          tx
        )
      }
      await tx.repo.update({
        where: { id: repoId },
        data: { updatedAt: asDate(updatedAt) },
      })
    })
    return this.getRepository(repoId)
  }

  async getWebhookBridgeState(repoId, key) {
    await this.ready
    const row = await this.db.webhookBridgeState.findUnique({
      where: { repoId_key: { repoId, key } },
    })
    if (!row) return null
    if (row.expiresAt && row.expiresAt <= new Date()) return null
    return row.value || null
  }

  async setWebhookBridgeState(repoId, key, value, options = {}) {
    await this.ready
    const ttlMs = Number(options.ttlMs || 0)
    const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs) : null
    await this.db.webhookBridgeState.upsert({
      where: { repoId_key: { repoId, key } },
      create: {
        repoId,
        key,
        value: String(value || ""),
        expiresAt,
        updatedAt: new Date(),
      },
      update: {
        value: String(value || ""),
        expiresAt,
        updatedAt: new Date(),
      },
    })
  }

  async deleteWebhookBridgeState(repoId, key) {
    await this.ready
    await this.db.webhookBridgeState.delete({ where: { repoId_key: { repoId, key } } }).catch((error) => {
      if (error && error.code !== "P2025") throw error
    })
  }

  gitEventFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId,
      repositoryId: row.repositoryId,
      repositoryFullName: row.repositoryFullName,
      deliveryId: row.deliveryId,
      eventName: row.eventName,
      action: row.action || "",
      objectType: row.objectType || "",
      objectId: row.objectId || "",
      payload: row.payload || {},
      normalizedEvents: row.normalizedEvents || [],
      receivedAt: timestampValue(row.receivedAt),
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  issueFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId,
      repositoryId: row.repositoryId,
      repositoryFullName: row.repositoryFullName,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      title: row.title || "",
      state: row.state || "",
      type: row.type || "",
      priority: row.priority || "",
      size: row.size || "",
      automation: row.automation || "off",
      status: row.status || "active",
      flow: row.flow || "",
      openedAt: timestampValue(row.openedAt),
      closedAt: timestampValue(row.closedAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  issueSpanFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId,
      repositoryId: row.repositoryId,
      repositoryFullName: row.repositoryFullName,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      flow: row.flow,
      enteredAt: timestampValue(row.enteredAt),
      exitedAt: timestampValue(row.exitedAt),
    }
  }

  async upsertIssueSnapshot(input = {}, client = this.db) {
    await this.ready
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const repositoryFullName = String(input.repositoryFullName || "").trim()
    const issueNumber = Number(input.issueNumber || 0)
    const issueId = String(input.issueId || issueNumber || "").trim()
    if (!gitServerId || !repositoryId || !issueId || !issueNumber) {
      return { issue: undefined, applied: false }
    }

    const incomingUpdatedAt = asDate(input.updatedAt || input.openedAt || nowIso())
    const existing = await client.issue.findUnique({
      where: {
        gitServerId_repositoryId_issueId: {
          gitServerId,
          repositoryId,
          issueId,
        },
      },
    })
    if (existing && existing.updatedAt > incomingUpdatedAt) {
      return { issue: this.issueFromRecord(existing), applied: false }
    }

    const data = {
      gitServerId,
      repositoryId,
      repositoryFullName,
      issueId,
      issueNumber,
      title: String(input.title || existing && existing.title || ""),
      state: String(input.state || ""),
      type: String(input.type || ""),
      priority: String(input.priority || ""),
      size: String(input.size || ""),
      automation: String(input.automation || "off"),
      status: String(input.status || "active"),
      flow: String(input.flow || ""),
      openedAt: asDate(input.openedAt || existing && existing.openedAt || incomingUpdatedAt),
      closedAt: nullableDate(input.closedAt),
      updatedAt: incomingUpdatedAt,
    }
    const row = await client.issue.upsert({
      where: {
        gitServerId_repositoryId_issueId: {
          gitServerId,
          repositoryId,
          issueId,
        },
      },
      create: {
        id: input.id || randomId("issue"),
        ...data,
      },
      update: data,
    })
    return { issue: this.issueFromRecord(row), applied: true }
  }

  async setIssueFlowSpan(input = {}, client = this.db) {
    await this.ready
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const repositoryFullName = String(input.repositoryFullName || "").trim()
    const issueNumber = Number(input.issueNumber || 0)
    const issueId = String(input.issueId || issueNumber || "").trim()
    const flow = String(input.flow || "").trim()
    if (!gitServerId || !repositoryId || !issueId || !issueNumber) return undefined

    const when = asDate(input.at || input.enteredAt || nowIso())
    const whereIssue = { gitServerId, repositoryId, issueId }
    const openRows = await client.issueSpan.findMany({
      where: { ...whereIssue, exitedAt: null },
      orderBy: { enteredAt: "asc" },
    })
    if (!flow) {
      if (openRows.length) {
        await client.issueSpan.updateMany({
          where: { ...whereIssue, exitedAt: null },
          data: { exitedAt: when },
        })
      }
      return undefined
    }

    const current = openRows.find((row) => row.flow === flow)
    const staleOpenIds = openRows
      .filter((row) => row.id !== (current && current.id))
      .map((row) => row.id)
    if (staleOpenIds.length) {
      await client.issueSpan.updateMany({
        where: { id: { in: staleOpenIds } },
        data: { exitedAt: when },
      })
    }
    if (current) return this.issueSpanFromRecord(current)

    const row = await client.issueSpan.create({
      data: {
        id: input.id || randomId("issue_span"),
        gitServerId,
        repositoryId,
        repositoryFullName,
        issueId,
        issueNumber,
        flow,
        enteredAt: when,
      },
    })
    return this.issueSpanFromRecord(row)
  }

  async closeIssueFlowSpans(input = {}, client = this.db) {
    await this.ready
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const issueId = String(input.issueId || input.issueNumber || "").trim()
    if (!gitServerId || !repositoryId || !issueId) return { count: 0 }
    const result = await client.issueSpan.updateMany({
      where: { gitServerId, repositoryId, issueId, exitedAt: null },
      data: { exitedAt: asDate(input.at || nowIso()) },
    })
    return { count: result.count || 0 }
  }

  pullRequestFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId,
      repositoryId: row.repositoryId,
      repositoryFullName: row.repositoryFullName,
      issueId: row.issueId || "",
      issueNumber: row.issueNumber || 0,
      openedByTaskId: row.openedByTaskId || "",
      pullRequestId: row.pullRequestId,
      prNumber: row.prNumber,
      kind: row.kind || "",
      state: row.state || "open",
      htmlUrl: row.htmlUrl || "",
      openedAt: timestampValue(row.openedAt),
      mergedAt: timestampValue(row.mergedAt),
      closedAt: timestampValue(row.closedAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  async upsertPullRequestSnapshot(input = {}, client = this.db) {
    await this.ready
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const repositoryFullName = String(input.repositoryFullName || "").trim()
    const prNumber = Number(input.prNumber || 0)
    const pullRequestId = String(input.pullRequestId || prNumber || "").trim()
    if (!gitServerId || !repositoryId || !pullRequestId || !prNumber) {
      return { pullRequest: undefined, applied: false }
    }

    const incomingUpdatedAt = asDate(input.updatedAt || input.openedAt || nowIso())
    const existing = await client.pullRequest.findUnique({
      where: {
        gitServerId_repositoryId_pullRequestId: {
          gitServerId,
          repositoryId,
          pullRequestId,
        },
      },
    })
    if (existing && existing.updatedAt > incomingUpdatedAt) {
      return { pullRequest: this.pullRequestFromRecord(existing), applied: false }
    }

    const issueNumber = Number(input.issueNumber || 0) || existing && existing.issueNumber || 0
    const issue = issueNumber
      ? await client.issue.findUnique({
        where: {
          gitServerId_repositoryId_issueNumber: {
            gitServerId,
            repositoryId,
            issueNumber,
          },
        },
      })
      : undefined
    const data = {
      gitServerId,
      repositoryId,
      repositoryFullName,
      issueId: issue && issue.issueId || existing && existing.issueId || "",
      issueNumber,
      openedByTaskId: String(input.openedByTaskId || existing && existing.openedByTaskId || ""),
      pullRequestId,
      prNumber,
      kind: String(input.kind || existing && existing.kind || ""),
      state: String(input.state || "open"),
      htmlUrl: String(input.htmlUrl || existing && existing.htmlUrl || ""),
      openedAt: asDate(input.openedAt || existing && existing.openedAt || incomingUpdatedAt),
      mergedAt: nullableDate(input.mergedAt || existing && existing.mergedAt),
      closedAt: nullableDate(input.closedAt),
      updatedAt: incomingUpdatedAt,
    }
    const row = await client.pullRequest.upsert({
      where: {
        gitServerId_repositoryId_pullRequestId: {
          gitServerId,
          repositoryId,
          pullRequestId,
        },
      },
      create: {
        id: input.id || randomId("pull_request"),
        ...data,
      },
      update: data,
    })
    if (issue) {
      this.scheduleIssueStatsRebuild({
        gitServerId,
        repositoryId,
        issueId: issue.issueId,
      })
    }
    return { pullRequest: this.pullRequestFromRecord(row), applied: true }
  }

  taskFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId || "",
      repositoryId: row.repositoryId || "",
      repositoryFullName: row.repositoryFullName || "",
      issueId: row.issueId || "",
      issueNumber: row.issueNumber || 0,
      issueSpanRowId: row.issueSpanRowId || "",
      taskId: row.taskId,
      action: row.action || "",
      agent: row.agent || "",
      model: row.model || "",
      turns: row.turns || 0,
      executionMs: row.executionMs || 0,
      status: row.status || "queued",
      result: row.result || "",
      queuedAt: timestampValue(row.queuedAt),
      startedAt: timestampValue(row.startedAt),
      finishedAt: timestampValue(row.finishedAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  taskEventFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      gitServerId: row.gitServerId || "",
      repositoryId: row.repositoryId || "",
      repositoryFullName: row.repositoryFullName || "",
      issueId: row.issueId || "",
      issueNumber: row.issueNumber || 0,
      taskId: row.taskId,
      chatId: row.chatId || "",
      eventId: row.eventId,
      sequence: row.sequence,
      eventType: row.eventType,
      eventData: row.eventData,
      createdAt: timestampValue(row.createdAt),
    }
  }

  async resolveTaskIssueSpan(row, client = this.db) {
    if (!row || row.issueSpanRowId) return row
    if (!row.gitServerId || !row.repositoryId || !row.issueId) return row
    const at = row.startedAt || row.queuedAt
    if (!at) return row
    const spans = await client.issueSpan.findMany({
      where: {
        gitServerId: row.gitServerId,
        repositoryId: row.repositoryId,
        issueId: row.issueId,
        enteredAt: { lte: at },
        OR: [
          { exitedAt: null },
          { exitedAt: { gte: at } },
        ],
      },
      orderBy: { enteredAt: "desc" },
    })
    if (!spans.length) return row
    const span = spans.find((item) => item.flow === TASK_SPAN_FLOW_BY_ACTION[row.action]) || spans[0]
    return client.task.update({
      where: { id: row.id },
      data: { issueSpanRowId: span.id, updatedAt: new Date() },
    })
  }

  async upsertTaskLink(input = {}, client = this.db) {
    await this.ready
    const taskId = String(input.taskId || "").trim()
    if (!taskId) return { task: undefined, applied: false }
    let gitServerId = String(input.gitServerId || "").trim()
    if (!gitServerId && input.agentrixGitServerId) {
      const server = await client.gitServer.findFirst({
        where: { agentrixGitServerId: String(input.agentrixGitServerId).trim() },
      })
      if (server) gitServerId = server.id
    }
    const repositoryId = String(input.repositoryId || "").trim()
    const issueNumber = Number(input.issueNumber || 0)
    const issue = gitServerId && repositoryId && issueNumber
      ? await client.issue.findUnique({
        where: {
          gitServerId_repositoryId_issueNumber: { gitServerId, repositoryId, issueNumber },
        },
      })
      : undefined

    const existing = await client.task.findUnique({ where: { taskId } })
    const data = {
      gitServerId: gitServerId || existing && existing.gitServerId || "",
      repositoryId: repositoryId || existing && existing.repositoryId || "",
      repositoryFullName: issue && issue.repositoryFullName || existing && existing.repositoryFullName || "",
      issueId: issue && issue.issueId || existing && existing.issueId || "",
      issueNumber: issueNumber || existing && existing.issueNumber || 0,
      action: normalizeTaskAction(input.action) || existing && existing.action || "",
      queuedAt: existing && existing.queuedAt || nullableDate(input.queuedAt),
      updatedAt: new Date(),
    }
    let row = await client.task.upsert({
      where: { taskId },
      create: {
        id: input.id || randomId("task"),
        taskId,
        ...data,
      },
      update: data,
    })
    row = await this.resolveTaskIssueSpan(row, client)
    if (row.issueId) {
      await client.taskEvent.updateMany({
        where: { taskId, issueId: "" },
        data: {
          gitServerId: row.gitServerId,
          repositoryId: row.repositoryId,
          repositoryFullName: row.repositoryFullName,
          issueId: row.issueId,
          issueNumber: row.issueNumber,
        },
      })
      this.scheduleIssueStatsRebuild({
        gitServerId: row.gitServerId,
        repositoryId: row.repositoryId,
        issueId: row.issueId,
      })
    }
    return { task: this.taskFromRecord(row), applied: true }
  }

  async upsertTaskRuntime(input = {}, client = this.db) {
    await this.ready
    const taskId = String(input.taskId || "").trim()
    if (!taskId) return { task: undefined, applied: false }
    const existing = await client.task.findUnique({ where: { taskId } })
    const turns = await client.taskEvent.count({ where: { taskId, eventType: "human_input" } })
    const executionMs = await this.taskExecutionMs(taskId, client)
    const data = {
      agent: existing && existing.agent || String(input.agent || ""),
      model: existing && existing.model || String(input.model || ""),
      turns,
      executionMs,
      status: String(input.status || existing && existing.status || "queued"),
      queuedAt: existing && existing.queuedAt || nullableDate(input.queuedAt),
      startedAt: existing && existing.startedAt || nullableDate(input.startedAt),
      finishedAt: nullableDate(input.finishedAt) || existing && existing.finishedAt || null,
      updatedAt: new Date(),
    }
    let row = await client.task.upsert({
      where: { taskId },
      create: {
        id: input.id || randomId("task"),
        taskId,
        ...data,
      },
      update: data,
    })
    row = await this.resolveTaskIssueSpan(row, client)
    if (row.issueId) {
      this.scheduleIssueStatsRebuild({
        gitServerId: row.gitServerId,
        repositoryId: row.repositoryId,
        issueId: row.issueId,
      })
    }
    return { task: this.taskFromRecord(row), applied: true }
  }

  async appendTaskUsageReport(input = {}, client = this.db) {
    await this.ready
    const taskId = String(input.taskId || "").trim()
    const eventId = String(input.eventId || "").trim()
    const reports = Array.isArray(input.reports) ? input.reports : []
    if (!taskId || !eventId || !reports.length) return { applied: false, count: 0 }
    const createdAt = asDate(input.createdAt || nowIso())
    const data = reports
      .map((report) => ({
        taskId,
        eventId,
        model: String(report.model || "").trim(),
        inputTokens: BigInt(report.inputTokens || 0),
        outputTokens: BigInt(report.outputTokens || 0),
        cacheReadInputTokens: BigInt(report.cacheReadInputTokens || 0),
        cacheCreationInputTokens: BigInt(report.cacheCreationInputTokens || 0),
        webSearchRequests: BigInt(report.webSearchRequests || 0),
        createdAt,
      }))
      .filter((report) => report.model)
    if (!data.length) return { applied: false, count: 0 }
    const result = await client.taskUsageReport.createMany({ data, skipDuplicates: true })
    return { applied: result.count > 0, count: result.count }
  }

  async appendTaskEvent(input = {}, client = this.db) {
    await this.ready
    const taskId = String(input.taskId || "").trim()
    const eventId = String(input.eventId || "").trim()
    const eventType = String(input.eventType || "").trim()
    if (!taskId || !eventId || !eventType) return { taskEvent: undefined, applied: false }
    const existing = await client.taskEvent.findUnique({ where: { eventId } })
    if (existing) {
      await this.syncTaskEventMetrics(existing, client)
      return { taskEvent: this.taskEventFromRecord(existing), applied: false }
    }
    const task = await client.task.findUnique({ where: { taskId } })
    for (let attempt = 0; ; attempt += 1) {
      const last = await client.taskEvent.findFirst({
        where: { taskId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      })
      try {
        const row = await client.taskEvent.create({
          data: {
            id: input.id || randomId("task_event"),
            gitServerId: task && task.gitServerId || "",
            repositoryId: task && task.repositoryId || "",
            repositoryFullName: task && task.repositoryFullName || "",
            issueId: task && task.issueId || "",
            issueNumber: task && task.issueNumber || 0,
            taskId,
            chatId: String(input.chatId || ""),
            eventId,
            sequence: (last && last.sequence || 0) + 1,
            eventType,
            eventData: input.eventData ?? {},
            createdAt: asDate(input.createdAt || nowIso()),
          },
        })
        await this.syncTaskEventMetrics(row, client)
        return { taskEvent: this.taskEventFromRecord(row), applied: true }
      } catch (error) {
        if (error && error.code === "P2002" && attempt < 3) {
          const duplicate = await client.taskEvent.findUnique({ where: { eventId } })
          if (duplicate) {
            await this.syncTaskEventMetrics(duplicate, client)
            return { taskEvent: this.taskEventFromRecord(duplicate), applied: false }
          }
          continue
        }
        throw error
      }
    }
  }

  async syncTaskTurns(taskId, client = this.db) {
    const turns = await client.taskEvent.count({ where: { taskId, eventType: "human_input" } })
    await client.task.updateMany({ where: { taskId }, data: { turns } })
    const task = await client.task.findUnique({ where: { taskId } })
    if (task && task.issueId) {
      this.scheduleIssueStatsRebuild({
        gitServerId: task.gitServerId,
        repositoryId: task.repositoryId,
        issueId: task.issueId,
      })
    }
    return turns
  }

  async taskExecutionMs(taskId, client = this.db) {
    const events = await client.taskEvent.findMany({
      where: { taskId, eventType: "worker_state" },
      select: { eventData: true },
    })
    return events.reduce((total, event) => {
      const data = event.eventData || {}
      const duration = Number(data.state === "ready" ? data.duration : 0)
      return total + (Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0)
    }, 0)
  }

  async syncTaskExecution(taskId, client = this.db) {
    const executionMs = await this.taskExecutionMs(taskId, client)
    await client.task.updateMany({ where: { taskId }, data: { executionMs } })
    const task = await client.task.findUnique({ where: { taskId } })
    if (task && task.issueId) {
      this.scheduleIssueStatsRebuild({
        gitServerId: task.gitServerId,
        repositoryId: task.repositoryId,
        issueId: task.issueId,
      })
    }
    return executionMs
  }

  async syncTaskEventMetrics(event, client = this.db) {
    if (event.eventType === "human_input") await this.syncTaskTurns(event.taskId, client)
    if (event.eventType === "worker_state") await this.syncTaskExecution(event.taskId, client)
  }

  async getTask(taskId) {
    await this.ready
    if (!taskId) return undefined
    const row = await this.db.task.findUnique({ where: { taskId: String(taskId) } })
    return this.taskFromRecord(row)
  }

  async listTasks(options = {}) {
    await this.ready
    const gitServerId = String(options.gitServerId || "").trim()
    const repositoryId = String(options.repositoryId || "").trim()
    const page = Math.max(1, Math.floor(Number(options.page || 1) || 1))
    const perPage = Math.min(100, Math.max(10, Math.floor(Number(options.perPage || 20) || 20)))
    if (!gitServerId || !repositoryId) {
      return { tasks: [], page, perPage, total: 0, hasMore: false }
    }
    const where = { gitServerId, repositoryId }
    const [rows, total] = await Promise.all([
      this.db.task.findMany({
        where,
        orderBy: [
          { updatedAt: "desc" },
          { id: "desc" },
        ],
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.db.task.count({ where }),
    ])
    return {
      tasks: rows.map((row) => this.taskFromRecord(row)),
      page,
      perPage,
      total,
      hasMore: page * perPage < total,
    }
  }

  async listTaskEvents(taskId) {
    await this.ready
    if (!taskId) return []
    const rows = await this.db.taskEvent.findMany({
      where: { taskId: String(taskId) },
      orderBy: { sequence: "asc" },
    })
    return rows.map((row) => this.taskEventFromRecord(row))
  }

  // Cursor routes mirror agentrix machine identity: machineId (deviceId) is
  // only unique within a cloud, so cursors key on `${cloudId}:${machineId}`.
  agentrixForwardRouteId(route = {}) {
    const machineId = String(route.machineId || "").trim()
    if (!machineId) return ""
    const cloudId = String(route.cloudId || "").trim()
    return `${cloudId}:${machineId}`
  }

  async getAgentrixForwardCursor(route = {}) {
    await this.ready
    const routeId = this.agentrixForwardRouteId(route)
    if (!routeId) return 0
    const row = await this.db.agentrixForwardCursor.findUnique({ where: { routeId } })
    return row ? Number(row.cursor) : 0
  }

  async setAgentrixForwardCursor(route = {}, cursor) {
    await this.ready
    const routeId = this.agentrixForwardRouteId(route)
    const value = Math.max(0, Math.floor(Number(cursor) || 0))
    if (!routeId || !value) return this.getAgentrixForwardCursor(route)
    const existing = await this.db.agentrixForwardCursor.findUnique({ where: { routeId } })
    if (existing && Number(existing.cursor) >= value) return Number(existing.cursor)
    const row = await this.db.agentrixForwardCursor.upsert({
      where: { routeId },
      create: {
        routeId,
        cloudId: String(route.cloudId || "").trim(),
        machineId: String(route.machineId || "").trim(),
        cursor: BigInt(value),
        updatedAt: new Date(),
      },
      update: { cursor: BigInt(value), updatedAt: new Date() },
    })
    return Number(row.cursor)
  }

  issueStatFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      openedAt: timestampValue(row.openedAt),
      cycleStartedAt: timestampValue(row.cycleStartedAt),
      closedAt: timestampValue(row.closedAt),
      doneAt: timestampValue(row.doneAt),
      dropAt: timestampValue(row.dropAt),
      triageSpanSeconds: row.triageSpanSeconds || 0,
      planSpanSeconds: row.planSpanSeconds || 0,
      buildSpanSeconds: row.buildSpanSeconds || 0,
      clarifySpanSeconds: row.clarifySpanSeconds || 0,
      approveSpanSeconds: row.approveSpanSeconds || 0,
      suspendSpanSeconds: row.suspendSpanSeconds || 0,
      triageTaskSeconds: row.triageTaskSeconds || 0,
      planTaskSeconds: row.planTaskSeconds || 0,
      buildTaskSeconds: row.buildTaskSeconds || 0,
      reviewTaskSeconds: row.reviewTaskSeconds || 0,
      triageTaskTurns: row.triageTaskTurns || 0,
      planTaskTurns: row.planTaskTurns || 0,
      buildTaskTurns: row.buildTaskTurns || 0,
      reviewTaskTurns: row.reviewTaskTurns || 0,
      pullRequestCount: row.pullRequestCount || 0,
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  scheduleIssueStatsRebuild(input = {}) {
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const issueId = String(input.issueId || input.issueNumber || "").trim()
    if (!gitServerId || !repositoryId || !issueId) return
    this.pendingIssueStatsRebuilds.set(`${gitServerId}\n${repositoryId}\n${issueId}`, {
      gitServerId,
      repositoryId,
      issueId,
    })
    if (this.issueStatsRebuildTimer) return
    this.issueStatsRebuildTimer = setTimeout(() => {
      void this.flushIssueStatsRebuilds()
    }, this.issueStatsDebounceMs)
    this.issueStatsRebuildTimer.unref?.()
  }

  async flushIssueStatsRebuilds() {
    if (this.issueStatsRebuildTimer) {
      clearTimeout(this.issueStatsRebuildTimer)
      this.issueStatsRebuildTimer = null
    }
    this.issueStatsRebuildRun = this.issueStatsRebuildRun.then(async () => {
      while (this.pendingIssueStatsRebuilds.size) {
        const batch = [...this.pendingIssueStatsRebuilds.values()]
        this.pendingIssueStatsRebuilds.clear()
        for (const item of batch) {
          try {
            await this.rebuildIssueStats(item)
          } catch (error) {
            this.lastIssueStatsRebuildError = error
          }
        }
      }
    })
    return this.issueStatsRebuildRun
  }

  async rebuildIssueStats(input = {}, client = this.db) {
    await this.ready
    const gitServerId = String(input.gitServerId || "").trim()
    const repositoryId = String(input.repositoryId || "").trim()
    const issueId = String(input.issueId || input.issueNumber || "").trim()
    if (!gitServerId || !repositoryId || !issueId) return undefined
    const issue = await client.issue.findUnique({
      where: {
        gitServerId_repositoryId_issueId: {
          gitServerId,
          repositoryId,
          issueId,
        },
      },
    })
    if (!issue) return undefined

    const spans = await client.issueSpan.findMany({
      where: { gitServerId, repositoryId, issueId, exitedAt: { not: null } },
    })
    const spanSeconds = { triage: 0, plan: 0, build: 0, clarify: 0, approve: 0, suspend: 0 }
    for (const span of spans) {
      if (!(span.flow in spanSeconds)) continue
      spanSeconds[span.flow] += Math.max(0, Math.round((span.exitedAt.getTime() - span.enteredAt.getTime()) / 1000))
    }
    const pullRequestCount = await client.pullRequest.count({
      where: {
        gitServerId,
        repositoryId,
        OR: [
          { issueId },
          { issueNumber: issue.issueNumber },
        ],
      },
    })
    const tasks = await client.task.findMany({
      where: { gitServerId, repositoryId, issueId },
    })
    const taskExecutionMs = { triage: 0, plan: 0, build: 0, review: 0 }
    const taskTurns = { triage: 0, plan: 0, build: 0, review: 0 }
    let cycleStartedAt = null
    for (const task of tasks) {
      if (task.startedAt && (!cycleStartedAt || task.startedAt < cycleStartedAt)) {
        cycleStartedAt = task.startedAt
      }
      if (!(task.action in taskExecutionMs)) continue
      taskExecutionMs[task.action] += task.executionMs || 0
      taskTurns[task.action] += task.turns || 0
    }
    const data = {
      openedAt: issue.openedAt,
      cycleStartedAt,
      closedAt: issue.closedAt,
      doneAt: issue.status === "done" ? issue.closedAt : null,
      dropAt: issue.status === "drop" ? issue.closedAt : null,
      triageSpanSeconds: spanSeconds.triage,
      planSpanSeconds: spanSeconds.plan,
      buildSpanSeconds: spanSeconds.build,
      clarifySpanSeconds: spanSeconds.clarify,
      approveSpanSeconds: spanSeconds.approve,
      suspendSpanSeconds: spanSeconds.suspend,
      triageTaskSeconds: Math.round(taskExecutionMs.triage / 1000),
      planTaskSeconds: Math.round(taskExecutionMs.plan / 1000),
      buildTaskSeconds: Math.round(taskExecutionMs.build / 1000),
      reviewTaskSeconds: Math.round(taskExecutionMs.review / 1000),
      triageTaskTurns: taskTurns.triage,
      planTaskTurns: taskTurns.plan,
      buildTaskTurns: taskTurns.build,
      reviewTaskTurns: taskTurns.review,
      pullRequestCount,
      updatedAt: new Date(),
    }
    const row = await client.issueStat.upsert({
      where: { id: issue.id },
      create: { id: issue.id, ...data },
      update: data,
    })
    return this.issueStatFromRecord(row)
  }

  async getIssueStats(issueRowId) {
    await this.ready
    if (!issueRowId) return undefined
    const row = await this.db.issueStat.findUnique({ where: { id: issueRowId } })
    return this.issueStatFromRecord(row)
  }

  dashboardFromRecord(row, variables = [], panels = []) {
    if (!row) return undefined
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description || "",
      isSystem: Boolean(row.isSystem),
      variables,
      panels,
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
  }

  dashboardVariableFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      defaultValue: row.defaultValue === undefined ? null : row.defaultValue,
      querySql: row.querySql || "",
      position: row.position || 0,
    }
  }

  dashboardPanelFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      title: row.title,
      querySql: row.querySql,
      chartType: row.chartType,
      xField: row.xField || "",
      yFields: jsonValue(row.yFields, []) || [],
      y2Fields: jsonValue(row.y2Fields, []) || [],
      seriesField: row.seriesField || "",
      stackField: row.stackField || "",
      visualConfig: jsonValue(row.visualConfig, {}) || {},
      drillQuerySql: row.drillQuerySql || "",
      drillConfig: jsonValue(row.drillConfig, {}) || {},
      position: jsonValue(row.position, {}) || {},
      refreshInterval: row.refreshInterval || 0,
    }
  }

  async listDashboards() {
    await this.ready
    const rows = await this.db.dashboard.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    return rows.map((row) => this.dashboardFromRecord(row))
  }

  async getDashboardBySlug(slug) {
    await this.ready
    if (!slug) return undefined
    const row = await this.db.dashboard.findUnique({ where: { slug } })
    if (!row) return undefined
    const [variableRows, panelRows] = await Promise.all([
      this.db.dashboardVariable.findMany({
        where: { dashboardId: row.id },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      }),
      this.db.dashboardPanel.findMany({
        where: { dashboardId: row.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ])
    return this.dashboardFromRecord(
      row,
      variableRows.map((variable) => this.dashboardVariableFromRecord(variable)),
      panelRows.map((panel) => this.dashboardPanelFromRecord(panel)),
    )
  }

  async runMetricsQuery(sql, params = {}) {
    await this.ready
    const normalized = assertReadOnlyMetricsSql(sql)
    const { text, values } = bindMetricsParams(normalized, params)
    const wrapped = `select * from (\n${text}\n) issue_flow_panel_rows limit ${METRICS_MAX_ROWS + 1}`
    const rows = await this.db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY")
      if (this.metricsSchema) {
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${String(this.metricsSchema).replace(/"/g, '""')}"`)
      }
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${METRICS_STATEMENT_TIMEOUT_MS}`)
      return tx.$queryRawUnsafe(wrapped, ...values)
    })
    return metricsResultFromRows(rows, METRICS_MAX_ROWS)
  }

  async listIssues(repoId) {
    await this.ready
    const repo = await this.db.repo.findUnique({ where: { id: repoId } })
    if (!repo || !repo.gitServerId || !repo.serverRepoId) return []
    const rows = await this.db.$transaction(async (tx) => {
      if (this.metricsSchema) {
        const schema = String(this.metricsSchema).replace(/"/g, '""')
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`)
      }
      return tx.$queryRawUnsafe(`
      select
        i."id" as "id",
        i."git_server_id" as "gitServerId",
        i."repository_id" as "repositoryId",
        i."repository_full_name" as "repositoryFullName",
        i."issue_id" as "issueId",
        i."issue_number" as "issueNumber",
        i."title" as "title",
        i."state" as "state",
        i."type" as "type",
        i."priority" as "priority",
        i."size" as "size",
        i."automation" as "automation",
        i."status" as "status",
        i."flow" as "flow",
        i."opened_at" as "openedAt",
        i."closed_at" as "closedAt",
        i."updated_at" as "updatedAt",
        coalesce(st."triage_task_turns", 0)
          + coalesce(st."plan_task_turns", 0)
          + coalesce(st."build_task_turns", 0)
          + coalesce(st."review_task_turns", 0) as "turnsCount",
        case
          when extract(epoch from (
            coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
            - coalesce(st."opened_at", i."opened_at")
          )) > 0 then round((
            coalesce(st."triage_task_seconds", 0)
              + coalesce(st."plan_task_seconds", 0)
              + coalesce(st."build_task_seconds", 0)
              + coalesce(st."review_task_seconds", 0)
          ) * 100.0 / extract(epoch from (
            coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
            - coalesce(st."opened_at", i."opened_at")
          )))::int
          else 0
        end as "agentTimeSharePct"
      from "issues" i
      left join "issue_stats" st on st."id" = i."id"
      where i."git_server_id" = $1
        and i."repository_id" = $2
      order by i."issue_number" asc
      `, repo.gitServerId, repo.serverRepoId)
    })

    return rows.map((row) => ({
      ...this.issueFromRecord(row),
      currentFlow: row.flow || "",
      turnsCount: Number(row.turnsCount || 0),
      agentTimeSharePct: Number(row.agentTimeSharePct || 0),
    }))
  }

  async listIssueSpans(repoId, issueId = "") {
    await this.ready
    const repo = await this.db.repo.findUnique({ where: { id: repoId } })
    if (!repo || !repo.gitServerId || !repo.serverRepoId) return []
    const rows = await this.db.issueSpan.findMany({
      where: {
        gitServerId: repo.gitServerId,
        repositoryId: repo.serverRepoId,
        ...(issueId ? { issueId: String(issueId) } : {}),
      },
      orderBy: { enteredAt: "asc" },
    })
    return rows.map((row) => this.issueSpanFromRecord(row))
  }

  async createGitEvent(input = {}) {
    await this.ready
    const createdAt = nowIso()
    const gitServerId = String(input.gitServerId || "").trim()
    const deliveryId = String(input.deliveryId || "").trim()
    if (!gitServerId || !deliveryId) return undefined
    const existing = await this.db.gitEvent.findUnique({
      where: { gitServerId_deliveryId: { gitServerId, deliveryId } },
    })
    if (existing) return this.gitEventFromRecord(existing)
    const row = await this.db.gitEvent.create({
      data: {
        id: input.id || randomId("git_event"),
        gitServerId,
        repositoryId: String(input.repositoryId || ""),
        repositoryFullName: String(input.repositoryFullName || ""),
        deliveryId,
        eventName: String(input.eventName || ""),
        action: String(input.action || ""),
        objectType: String(input.objectType || ""),
        objectId: String(input.objectId || ""),
        payload: input.payload || {},
        normalizedEvents: input.normalizedEvents || [],
        receivedAt: asDate(input.receivedAt || createdAt),
        createdAt: asDate(createdAt),
        updatedAt: asDate(createdAt),
      },
    })
    await this.markRepositoryGitEvent(input.repoId, createdAt)
    return this.gitEventFromRecord(row)
  }

  async markRepositoryGitEvent(repoId, timestamp) {
    await this.ready
    if (!repoId) return
    await this.db.repo.update({
      where: { id: repoId },
      data: { updatedAt: asDate(timestamp || nowIso()) },
    }).catch((error) => {
      if (error && error.code !== "P2025") throw error
    })
  }

  async listGitEvents(repoId) {
    await this.ready
    const repo = await this.db.repo.findUnique({ where: { id: repoId } })
    if (!repo || !repo.gitServerId || !repo.serverRepoId) return []
    const rows = await this.db.gitEvent.findMany({
      where: {
        gitServerId: repo.gitServerId,
        repositoryId: repo.serverRepoId,
      },
      orderBy: { receivedAt: "desc" },
      take: 500,
    })
    return rows.map((row) => this.gitEventFromRecord(row))
  }

  async createSession(input = {}) {
    await this.ready
    const now = nowIso()
    const session = {
      id: input.id || randomId("session"),
      userId: input.userId || input.user && input.user.id || "",
      provider: input.provider || input.gitServer && input.gitServer.type || "gitlab",
      gitServerId: input.gitServerId || "",
      gitServer: input.gitServer || {},
      user: input.user || {},
      account: input.account || {},
      scopes: input.scopes || [],
      expiresAt: input.expiresAt || "",
      createdAt: now,
      updatedAt: now,
    }
    const tokenData = {
      userId: session.userId || null,
      provider: session.provider,
      gitServerId: session.gitServerId,
      accessToken: this.encrypt(input.token || ""),
      refreshToken: this.encrypt(input.refreshToken || ""),
      expiresAt: session.expiresAt ? asDate(session.expiresAt) : null,
      updatedAt: asDate(now),
    }
    let row
    if (session.userId && session.gitServerId) {
      const existing = await this.db.oAuthSession.findUnique({
        where: {
          userId_gitServerId: {
            userId: session.userId,
            gitServerId: session.gitServerId,
          },
        },
      })
      const nextSession = {
        ...session,
        id: existing ? existing.id : session.id,
        createdAt: existing ? timestampValue(existing.createdAt) : session.createdAt,
      }
      row = existing
        ? await this.db.oAuthSession.update({
          where: { id: existing.id },
          data: {
            ...tokenData,
            data: nextSession,
          },
        })
        : await this.db.oAuthSession.create({
          data: {
            id: nextSession.id,
            ...tokenData,
            data: nextSession,
            createdAt: asDate(nextSession.createdAt),
          },
        })
    } else {
      row = await this.db.oAuthSession.create({
        data: {
          id: session.id,
          ...tokenData,
          data: session,
          createdAt: asDate(session.createdAt),
        },
      })
    }
    return this.getSession(row.id, { allowExpired: true })
  }

  async getSession(id, options = {}) {
    await this.ready
    if (!id) return undefined
    const row = await this.db.oAuthSession.findUnique({ where: { id } })
    if (!row) return undefined
    if (!options.allowExpired && row.expiresAt && row.expiresAt <= new Date()) return undefined
    return {
      provider: row.provider || "gitlab",
      gitServerId: row.gitServerId || "",
      userId: row.userId || "",
      ...rowData(row),
      token: this.decrypt(row.accessToken || ""),
      accessToken: this.decrypt(row.accessToken || ""),
      refreshToken: this.decrypt(row.refreshToken || ""),
    }
  }

  async updateSessionTokens(id, input = {}) {
    await this.ready
    const existing = await this.getSession(id, { allowExpired: true })
    if (!existing) return undefined
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt || "" : existing.expiresAt || ""
    const updatedAt = nowIso()
    const session = {
      ...existing,
      scopes: input.scopes || existing.scopes || [],
      expiresAt,
      updatedAt,
    }
    delete session.token
    delete session.accessToken
    delete session.refreshToken
    await this.db.oAuthSession.update({
      where: { id },
      data: {
        accessToken: this.encrypt(input.token || existing.token || ""),
        refreshToken: this.encrypt(input.refreshToken || existing.refreshToken || ""),
        data: session,
        expiresAt: expiresAt ? asDate(expiresAt) : null,
        updatedAt: asDate(updatedAt),
      },
    })
    return this.getSession(id, { allowExpired: true })
  }

  async deleteSession(id) {
    await this.ready
    if (!id) return
    await this.db.oAuthSession.delete({ where: { id } }).catch((error) => {
      if (error && error.code !== "P2025") throw error
    })
  }

  consoleSessionFromRecord(row) {
    if (!row) return undefined
    return {
      id: row.id,
      userId: row.userId,
      expiresAt: timestampValue(row.expiresAt),
      lastSeenAt: timestampValue(row.lastSeenAt),
      createdAt: timestampValue(row.createdAt),
    }
  }

  async createConsoleSession({ userId, userAgent = "", ip = "" }) {
    await this.ready
    // token 只在此处返回一次,数据库永远只存 hash。
    const token = newConsoleSessionToken()
    const now = Date.now()
    const row = await this.db.consoleSession.create({
      data: {
        id: randomId("csess"),
        tokenHash: hashConsoleSessionToken(token),
        userId,
        data: { userAgent: String(userAgent || ""), ip: String(ip || "") },
        expiresAt: new Date(now + CONSOLE_SESSION_TTL_MS),
        lastSeenAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      },
    })
    return { token, session: this.consoleSessionFromRecord(row) }
  }

  async getConsoleSessionByToken(token) {
    await this.ready
    if (!token) return undefined
    const row = await this.db.consoleSession.findUnique({
      where: { tokenHash: hashConsoleSessionToken(token) },
    })
    if (!row) return undefined
    const now = Date.now()
    if (!row.expiresAt || row.expiresAt.getTime() <= now) return undefined
    let current = row
    if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      // 滑动续期,按 TOUCH_INTERVAL_MS 节流写库。
      current = await this.db.consoleSession.update({
        where: { id: row.id },
        data: {
          lastSeenAt: new Date(now),
          expiresAt: new Date(now + CONSOLE_SESSION_TTL_MS),
          updatedAt: new Date(now),
        },
      })
    }
    return this.consoleSessionFromRecord(current)
  }

  async deleteConsoleSession(id) {
    await this.ready
    if (!id) return
    await this.db.consoleSession.deleteMany({ where: { id } })
  }

  async deleteConsoleSessionsForUser(userId) {
    await this.ready
    if (!userId) return
    await this.db.consoleSession.deleteMany({ where: { userId } })
  }

  async getGitCredential(userId, gitServerId, options = {}) {
    await this.ready
    if (!userId || !gitServerId) return undefined
    const row = await this.db.oAuthSession.findUnique({
      where: { userId_gitServerId: { userId, gitServerId } },
      select: { id: true },
    })
    if (!row) return undefined
    return this.getSession(row.id, options)
  }

  publicUserAgentrixConfig(config) {
    if (!config) {
      return {
        automation: normalizeAutomation({}),
        agentrix: {
          baseUrl: normalizeBaseUrl(config && config.agentrix && config.agentrix.baseUrl || ""),
          runnerId: "",
          apiKeyFingerprint: "",
        },
      }
    }
    return {
      ...config,
      automation: normalizeAutomation(config.automation || {}),
      agentrix: {
        ...(config.agentrix || {}),
        apiKeyFingerprint: config.agentrix && config.agentrix.apiKeyFingerprint || "",
      },
    }
  }

  async getUserAgentrixConfig(userKey, options = {}) {
    await this.ready
    if (!userKey) return undefined
    const row = await this.db.userAgentrixConfig.findUnique({ where: { userKey } })
    if (!row) return undefined
    const config = rowData(row)
    if (options.includeSecret) {
      return {
        ...config,
        automation: normalizeAutomation(config.automation || {}),
        agentrix: {
          ...(config.agentrix || {}),
          apiKey: this.decrypt(row.agentrixApiKey || ""),
          apiKeyFingerprint: config.agentrix && config.agentrix.apiKeyFingerprint || "",
        },
      }
    }
    return this.publicUserAgentrixConfig(config)
  }

  async deleteUserAgentrixConfig(userKey) {
    await this.ready
    if (!userKey) return
    await this.db.userAgentrixConfig.deleteMany({ where: { userKey } })
  }

  async saveUserAgentrixConfig(userKey, input = {}) {
    await this.ready
    const existing = await this.getUserAgentrixConfig(userKey, { includeSecret: true })
    const apiKey = input.agentrix && input.agentrix.apiKey
      ? String(input.agentrix.apiKey)
      : existing && existing.agentrix && existing.agentrix.apiKey || ""
    const publicAgentrixInput = { ...(input.agentrix || {}) }
    delete publicAgentrixInput.apiKey
    const now = nowIso()
    const config = {
      userKey,
      automation: normalizeAutomation({
        ...(existing && existing.automation || {}),
        ...(input.automation || {}),
      }),
      agentrix: {
        ...(existing && existing.agentrix || {}),
        ...publicAgentrixInput,
        baseUrl: normalizeBaseUrl(input.agentrix && input.agentrix.baseUrl || existing && existing.agentrix && existing.agentrix.baseUrl || ""),
        runnerId: input.agentrix && input.agentrix.runnerId !== undefined
          ? input.agentrix.runnerId || ""
          : existing && existing.agentrix && existing.agentrix.runnerId || "",
        apiKeyFingerprint: fingerprintSecret(apiKey),
      },
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
    }
    await this.db.userAgentrixConfig.upsert({
      where: { userKey },
      create: {
        userKey,
        agentrixApiKey: this.encrypt(apiKey),
        data: config,
        createdAt: asDate(config.createdAt),
        updatedAt: asDate(config.updatedAt),
      },
      update: {
        agentrixApiKey: this.encrypt(apiKey),
        data: config,
        updatedAt: asDate(config.updatedAt),
      },
    })
    return this.publicUserAgentrixConfig(config)
  }

  publicRunnerGitlabToken(row, options = {}) {
    if (!row) return undefined
    const result = {
      id: row.id,
      userId: row.userId,
      gitServerId: row.gitServerId,
      runnerId: row.runnerId,
      gitlabUserId: row.gitlabUserId || "",
      gitlabUsername: row.gitlabUsername || "",
      gitlabTokenId: row.gitlabTokenId || "",
      tokenFingerprint: row.tokenFingerprint || "",
      scopes: row.scopes || [],
      source: row.source || "",
      expiresAt: timestampValue(row.expiresAt),
      revokedAt: timestampValue(row.revokedAt),
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
    if (options.includeSecret) {
      result.token = this.decrypt(row.tokenCiphertext || "")
    }
    return result
  }

  async listRunnerGitlabTokens(options = {}) {
    await this.ready
    const userId = String(options.userId || "").trim()
    const gitServerId = String(options.gitServerId || "").trim()
    if (!userId) return []
    const rows = await this.db.runnerGitlabToken.findMany({
      where: {
        userId,
        ...(gitServerId ? { gitServerId } : {}),
      },
      orderBy: { updatedAt: "desc" },
    })
    return rows.map((row) => this.publicRunnerGitlabToken(row))
  }

  async getRunnerGitlabToken(options = {}) {
    await this.ready
    const userId = String(options.userId || "").trim()
    const gitServerId = String(options.gitServerId || "").trim()
    const runnerId = normalizeRunnerId(options.runnerId)
    if (!userId || !gitServerId || !runnerId) return undefined
    const row = await this.db.runnerGitlabToken.findUnique({
      where: {
        userId_gitServerId_runnerId: { userId, gitServerId, runnerId },
      },
    })
    return this.publicRunnerGitlabToken(row, options)
  }

  async saveRunnerGitlabToken(input = {}) {
    await this.ready
    const userId = String(input.userId || "").trim()
    const gitServerId = String(input.gitServerId || "").trim()
    const runnerId = normalizeRunnerId(input.runnerId)
    const token = String(input.token || "")
    if (!userId || !gitServerId || !runnerId || !token) {
      const error = new Error("runner GitLab token requires user, git server, runner id, and token")
      error.status = 400
      throw error
    }
    const now = nowIso()
    const saved = await this.db.runnerGitlabToken.upsert({
      where: {
        userId_gitServerId_runnerId: { userId, gitServerId, runnerId },
      },
      create: {
        id: randomId("runner_gitlab_token"),
        userId,
        gitServerId,
        runnerId,
        gitlabUserId: String(input.gitlabUserId || ""),
        gitlabUsername: String(input.gitlabUsername || ""),
        gitlabTokenId: String(input.gitlabTokenId || ""),
        tokenCiphertext: this.encrypt(token),
        tokenFingerprint: fingerprintSecret(token),
        scopes: input.scopes || [],
        source: input.source || "",
        expiresAt: input.expiresAt ? asDate(input.expiresAt) : null,
        revokedAt: input.revokedAt ? asDate(input.revokedAt) : null,
        createdAt: asDate(now),
        updatedAt: asDate(now),
      },
      update: {
        gitlabUserId: String(input.gitlabUserId || ""),
        gitlabUsername: String(input.gitlabUsername || ""),
        gitlabTokenId: String(input.gitlabTokenId || ""),
        tokenCiphertext: this.encrypt(token),
        tokenFingerprint: fingerprintSecret(token),
        scopes: input.scopes || [],
        source: input.source || "",
        expiresAt: input.expiresAt ? asDate(input.expiresAt) : null,
        revokedAt: input.revokedAt ? asDate(input.revokedAt) : null,
        updatedAt: asDate(now),
      },
    })
    return this.publicRunnerGitlabToken(saved, { includeSecret: true })
  }
}

export {
  IssueFlowStore,
  normalizeApiUrl,
  normalizeBaseUrl,
  nowIso,
}
