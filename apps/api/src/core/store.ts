// @ts-nocheck
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { db as prismaDb, prismaClient } from "../storage/db.js"
import { fingerprintSecret } from "./sanitize.js"

const DEFAULT_STATE_DIR = ".issue-flow-service"

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

function normalizeGitServer(input = {}, fingerprints = {}) {
  const type = input.type || "gitlab"
  const id = String(input.id || "").trim()
  const baseUrl = normalizeBaseUrl(input.baseUrl || "")
  const oauth = input.oauth || {}
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
      redirectUri: oauth.redirectUri || "",
      scopes: oauth.scopes || "",
      clientSecretFingerprint: fingerprints.oauthClientSecretFingerprint || "",
    },
    webhook: {
      secretFingerprint: fingerprints.webhookSecretFingerprint || "",
    },
    agentrixGitServerId,
    adminPatFingerprint: fingerprints.adminPatFingerprint || "",
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
    variables: { items: [], checkedAt: "" },
    webhook: {},
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
    this.ready = Promise.resolve()
  }

  async close() {
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
    }
  }

  publicUser(user, accounts = []) {
    if (!user) return undefined
    return {
      id: user.id,
      displayName: user.displayName || "",
      email: user.email || "",
      avatarUrl: user.avatarUrl || "",
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
    const existingAccount = await this.findUserGitAccount(account)
    const currentUser = input.currentUserId ? await this.getUser(input.currentUserId) : undefined
    const user = currentUser
      || (existingAccount && await this.getUser(existingAccount.userId))
      || await this.createUser({
        displayName: account.displayName || account.username,
        email: account.email,
        avatarUrl: account.avatarUrl,
      })
    const savedAccount = await this.upsertUserGitAccount(user.id, account)
    return {
      user: await this.getUser(user.id, { includeAccounts: true }),
      account: savedAccount,
    }
  }

  gitServerFromRecord(row, options = {}) {
    if (!row) return undefined
    const oauthClientSecret = String(row.oauthClientSecret || "")
    const webhookSecret = String(row.webhookSecret || "")
    const adminPat = String(row.adminPat || "")
    const server = {
      id: row.id,
      type: row.type || "gitlab",
      name: row.name || row.baseUrl || row.id,
      baseUrl: normalizeBaseUrl(row.baseUrl || ""),
      apiUrl: normalizeApiUrl(row.baseUrl || "", row.apiUrl || ""),
      tokenAuth: row.tokenAuth || "bearer",
      oauth: {
        clientId: row.oauthClientId || "",
        redirectUri: row.oauthRedirectUri || "",
        scopes: row.oauthScopes || "",
        clientSecretFingerprint: fingerprintSecret(oauthClientSecret),
      },
      webhook: {
        secretFingerprint: fingerprintSecret(webhookSecret),
      },
      agentrixGitServerId: row.agentrixGitServerId || row.agentrix_git_server_id || "",
      adminPatFingerprint: fingerprintSecret(adminPat),
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
    if (options.includeSecret) {
      server.oauth.clientSecret = oauthClientSecret
      server.webhook.secret = webhookSecret
      server.adminPat = adminPat
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
    const hasAgentrixGitServerId = Object.prototype.hasOwnProperty.call(input, "agentrixGitServerId")
      || Object.prototype.hasOwnProperty.call(input, "agentrix_git_server_id")
      || Boolean(input.agentrix && Object.prototype.hasOwnProperty.call(input.agentrix, "gitServerId"))
    const existing = await this.getGitServer(normalized.id, { includeSecret: true })
    const oauthClientSecret = hasOauthSecret ? (input.oauth && input.oauth.clientSecret || "") : (existing && existing.oauth && existing.oauth.clientSecret || "")
    const webhookSecret = hasWebhookSecret ? (input.webhook && input.webhook.secret || "") : (existing && existing.webhook && existing.webhook.secret || "")
    const adminPat = hasAdminPat ? (input.adminPat || input.admin_pat || "") : (existing && existing.adminPat || "")
    const agentrixGitServerId = hasAgentrixGitServerId ? normalized.agentrixGitServerId : (existing && existing.agentrixGitServerId || normalized.agentrixGitServerId)
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
        oauthRedirectUri: normalized.oauth.redirectUri,
        oauthScopes: normalized.oauth.scopes,
        webhookSecret,
        agentrixGitServerId,
        adminPat,
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
        oauthRedirectUri: normalized.oauth.redirectUri,
        oauthScopes: normalized.oauth.scopes,
        webhookSecret,
        agentrixGitServerId,
        adminPat,
        updatedAt: now,
      },
    })
    return this.getGitServer(normalized.id, { includeSecret: true })
  }

  repoSettingsFromItems(rows = []) {
    const empty = emptyRepoSettings()
    const settings = {
      variables: { ...empty.variables, items: [] },
      webhook: {},
    }
    for (const row of rows || []) {
      const data = repoSettingData(row)
      const checkedAt = timestampValue(row.checkedAt)
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
      }
    }
    settings.variables.items.sort((a, b) => String(a.key || "").localeCompare(String(b.key || "")))
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
    if (!userId) return []
    const accessRows = await this.db.userRepoAccess.findMany({
      where: {
        userId,
        ...(options.gitServerId ? { gitServerId: options.gitServerId } : {}),
      },
      select: { repoId: true },
    })
    const repoIds = accessRows.map((row) => row.repoId)
    if (!repoIds.length) return []
    const where = {
      id: { in: repoIds },
      ...(options.gitServerId ? { gitServerId: options.gitServerId } : {}),
    }
    const rows = await this.db.repo.findMany({ where, orderBy: { fullName: "asc" } })
    const settingRows = rows.length
      ? await this.db.repoSettingItem.findMany({ where: { repoId: { in: rows.map((row) => row.id) } } })
      : []
    const settingsById = new Map()
    for (const item of settingRows) {
      if (!settingsById.has(item.repoId)) settingsById.set(item.repoId, [])
      settingsById.get(item.repoId).push(item)
    }
    const gitServers = await this.listGitServers()
    const serverById = new Map(gitServers.map((server) => [server.id, server]))
    return rows.map((row) => this.repoFromRecord(row, settingsById.get(row.id), serverById.get(row.gitServerId || "")))
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
      type: row.type || "",
      priority: row.priority || "",
      size: row.size || "",
      automation: row.automation || "off",
      status: row.status || "active",
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
      type: String(input.type || ""),
      priority: String(input.priority || ""),
      size: String(input.size || ""),
      automation: String(input.automation || "off"),
      status: String(input.status || "active"),
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

  async listIssues(repoId) {
    await this.ready
    const repo = await this.db.repo.findUnique({ where: { id: repoId } })
    if (!repo || !repo.gitServerId || !repo.serverRepoId) return []
    const rows = await this.db.issue.findMany({
      where: {
        gitServerId: repo.gitServerId,
        repositoryId: repo.serverRepoId,
      },
      orderBy: { issueNumber: "asc" },
    })
    return rows.map((row) => this.issueFromRecord(row))
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
    const createdAt = nowIso()
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
      createdAt,
      updatedAt: createdAt,
    }
    await this.db.oAuthSession.create({
      data: {
        id: session.id,
        userId: session.userId || null,
        accessToken: this.encrypt(input.token || ""),
        refreshToken: this.encrypt(input.refreshToken || ""),
        data: session,
        expiresAt: session.expiresAt ? asDate(session.expiresAt) : null,
        createdAt: asDate(session.createdAt),
        updatedAt: asDate(session.updatedAt),
      },
    })
    return session
  }

  async getSession(id, options = {}) {
    await this.ready
    if (!id) return undefined
    const row = await this.db.oAuthSession.findUnique({ where: { id } })
    if (!row) return undefined
    if (!options.allowExpired && row.expiresAt && row.expiresAt <= new Date()) return undefined
    return {
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
    const expiresAt = input.expiresAt || ""
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
        accessToken: this.encrypt(input.token || ""),
        refreshToken: this.encrypt(input.refreshToken || ""),
        data: session,
        expiresAt: expiresAt ? asDate(expiresAt) : null,
        updatedAt: asDate(updatedAt),
      },
    })
    return this.getSession(id, { allowExpired: true })
  }

  async updateSessionIdentity(id, identity = {}) {
    await this.ready
    const existing = await this.getSession(id, { allowExpired: true })
    if (!existing) return undefined
    const updatedAt = nowIso()
    const session = {
      ...existing,
      userId: identity.userId || existing.userId || "",
      user: identity.user || existing.user || {},
      account: identity.account || existing.account || {},
      updatedAt,
    }
    delete session.token
    delete session.accessToken
    delete session.refreshToken
    await this.db.oAuthSession.update({
      where: { id },
      data: {
        userId: session.userId || null,
        data: session,
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

  async saveUserAgentrixConfig(userKey, input = {}) {
    await this.ready
    const existing = await this.getUserAgentrixConfig(userKey, { includeSecret: true })
    const apiKey = input.agentrix && input.agentrix.apiKey
      ? String(input.agentrix.apiKey)
      : existing && existing.agentrix && existing.agentrix.apiKey || ""
    const now = nowIso()
    const config = {
      userKey,
      automation: normalizeAutomation({
        ...(existing && existing.automation || {}),
        ...(input.automation || {}),
      }),
      agentrix: {
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
}

export {
  IssueFlowStore,
  normalizeApiUrl,
  normalizeBaseUrl,
  nowIso,
}
