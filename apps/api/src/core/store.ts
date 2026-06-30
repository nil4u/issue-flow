// @ts-nocheck
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { db as prismaDb, prismaClient } from "../storage/db.js"
import { fingerprintSecret, sanitizeError } from "./sanitize.js"

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
    return {
      ...repo,
      credentialStatus: repo.credentialStatus || {},
      webhook: {
        secretFingerprint: repo.webhook && repo.webhook.secretFingerprint || "",
        lastRotatedAt: repo.webhook && repo.webhook.lastRotatedAt || "",
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
    }
  }

  gitServerFromRecord(row, options = {}) {
    if (!row) return undefined
    const oauthClientSecret = String(row.oauthClientSecret || "")
    const webhookSecret = String(row.webhookSecret || "")
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
      createdAt: timestampValue(row.createdAt),
      updatedAt: timestampValue(row.updatedAt),
    }
    if (options.includeSecret) {
      server.oauth.clientSecret = oauthClientSecret
      server.webhook.secret = webhookSecret
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
    const existing = await this.getGitServer(normalized.id, { includeSecret: true })
    const oauthClientSecret = hasOauthSecret ? (input.oauth && input.oauth.clientSecret || "") : (existing && existing.oauth && existing.oauth.clientSecret || "")
    const webhookSecret = hasWebhookSecret ? (input.webhook && input.webhook.secret || "") : (existing && existing.webhook && existing.webhook.secret || "")
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
        updatedAt: now,
      },
    })
    return this.getGitServer(normalized.id, { includeSecret: true })
  }

  async insertRepository(repo, client = this.db) {
    await client.repository.create({
      data: {
        id: repo.id,
        gitServerId: repo.gitServerId || null,
        oauthSessionId: repo.oauthSessionId || null,
        data: repo,
        createdAt: asDate(repo.createdAt),
        updatedAt: asDate(repo.updatedAt),
      },
    })
  }

  async saveRepository(repo, client = this.db) {
    await this.ready
    repo.updatedAt = repo.updatedAt || nowIso()
    await client.repository.update({
      where: { id: repo.id },
      data: {
        gitServerId: repo.gitServerId || null,
        oauthSessionId: repo.oauthSessionId || null,
        data: repo,
        updatedAt: asDate(repo.updatedAt),
      },
    })
  }

  async listRepositories() {
    await this.ready
    const rows = await this.db.repository.findMany({ orderBy: { createdAt: "desc" } })
    return rows.map(rowData).map((repo) => this.publicRepository(repo))
  }

  async getRepository(id) {
    await this.ready
    const row = await this.db.repository.findUnique({ where: { id } })
    return rowData(row)
  }

  async findRepositoryByProject(project = {}) {
    const projectId = project.projectId ? String(project.projectId) : ""
    const projectPath = String(project.projectPath || "").trim()
    const gitServerId = String(project.gitServerId || "").trim()
    const repos = await this.listRepositories()
    return repos.find((repo) => (!gitServerId || repo.gitServerId === gitServerId) && ((
      projectId && String(repo.projectId || "") === projectId
    ) || (
      projectPath && repo.projectPath === projectPath
    )))
  }

  async getCredentials(repoId) {
    await this.ready
    const credentials = await this.db.credential.findUnique({ where: { repoId } }) || {}
    return {
      providerToken: "",
      webhookSecret: this.decrypt(credentials.webhookSecret || ""),
      agentrixApiKey: this.decrypt(credentials.agentrixApiKey || ""),
    }
  }

  async createRepository(input = {}, validation = {}) {
    await this.ready
    const id = input.id || randomId("repo")
    const createdAt = nowIso()
    const webhookSecret = input.webhookSecret || crypto.randomBytes(24).toString("hex")
    const repo = {
      id,
      provider: input.provider || "",
      gitServerId: input.gitServerId || "",
      oauthSessionId: input.oauthSessionId || "",
      tokenAuth: input.tokenAuth || "bearer",
      baseUrl: normalizeBaseUrl(input.baseUrl || "https://gitlab.com"),
      apiUrl: normalizeApiUrl(input.baseUrl || "https://gitlab.com", input.apiUrl),
      projectPath: String(input.projectPath || "").trim(),
      projectId: validation.projectId ? String(validation.projectId) : "",
      defaultBranch: validation.defaultBranch || input.defaultBranch || "",
      installMode: input.installMode || "server-side",
      install: {
        status: input.installStatus || "not_installed",
        mode: input.installMode || "server-side",
        version: input.installVersion || "",
        bootstrap: input.bootstrap || {},
        lastCheckedAt: input.installCheckedAt || "",
      },
      automation: normalizeAutomation(input.automation || {}),
      agentrix: normalizeAgentrix(input.agentrix || {}, fingerprintSecret(input.agentrix && input.agentrix.apiKey)),
      credentialStatus: {
        tokenFingerprint: "",
        username: validation.username || "",
        scopes: validation.scopes || [],
        status: validation.status || "unchecked",
        lastValidatedAt: validation.lastValidatedAt || "",
        errorCode: validation.errorCode || "",
      },
      webhook: {
        secretFingerprint: fingerprintSecret(webhookSecret),
        lastRotatedAt: createdAt,
      },
      lastDeliveryAt: "",
      lastDispatchAt: "",
      lastError: "",
      createdAt,
      updatedAt: createdAt,
    }

    await this.db.$transaction(async (tx) => {
      await this.insertRepository(repo, tx)
      await tx.credential.create({
        data: {
          repoId: id,
          webhookSecret: this.encrypt(webhookSecret),
          agentrixApiKey: this.encrypt(input.agentrix && input.agentrix.apiKey || ""),
          updatedAt: asDate(createdAt),
        },
      })
    })

    return { repo: this.publicRepository(repo), webhookSecret }
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
    if (input.oauthSessionId !== undefined) {
      repo.oauthSessionId = input.oauthSessionId || ""
    }
    repo.agentrix = normalizeAgentrix(input.agentrix || repo.agentrix || {}, fingerprintSecret(input.agentrix && input.agentrix.apiKey))
    repo.updatedAt = nowIso()

    await this.db.$transaction(async (tx) => {
      if (input.agentrix && Object.prototype.hasOwnProperty.call(input.agentrix, "apiKey")) {
        await tx.credential.update({
          where: { repoId },
          data: {
            agentrixApiKey: this.encrypt(input.agentrix.apiKey || ""),
            updatedAt: asDate(repo.updatedAt),
          },
        })
      }
      await this.saveRepository(repo, tx)
    })
    return this.publicRepository(repo)
  }

  async updateInstallStatus(repoId, patch = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    repo.install = {
      ...(repo.install || {}),
      ...patch,
      lastCheckedAt: patch.lastCheckedAt || nowIso(),
    }
    repo.installMode = repo.install.mode || repo.installMode
    repo.updatedAt = nowIso()
    await this.saveRepository(repo)
    return this.publicRepository(repo)
  }

  async updateTokenValidation(repoId, validation = {}) {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    repo.credentialStatus = {
      ...(repo.credentialStatus || {}),
      username: validation.username || "",
      scopes: validation.scopes || [],
      status: validation.status || "unchecked",
      lastValidatedAt: validation.lastValidatedAt || nowIso(),
      errorCode: validation.errorCode || "",
    }
    repo.projectId = validation.projectId ? String(validation.projectId) : repo.projectId
    repo.defaultBranch = validation.defaultBranch || repo.defaultBranch
    repo.updatedAt = nowIso()
    await this.saveRepository(repo)
    return this.publicRepository(repo)
  }

  async rotateWebhookSecret(repoId, explicitSecret = "") {
    const repo = await this.getRepository(repoId)
    if (!repo) return undefined
    const secret = explicitSecret || crypto.randomBytes(24).toString("hex")
    const updatedAt = nowIso()
    await this.db.$transaction(async (tx) => {
      await tx.credential.update({
        where: { repoId },
        data: {
          webhookSecret: this.encrypt(secret),
          updatedAt: asDate(updatedAt),
        },
      })
      repo.webhook = {
        secretFingerprint: fingerprintSecret(secret),
        lastRotatedAt: updatedAt,
      }
      repo.updatedAt = updatedAt
      await this.saveRepository(repo, tx)
    })
    return { repo: this.publicRepository(repo), webhookSecret: secret }
  }

  async findDelivery(repoId, deliveryKey, consumer = "dispatch") {
    await this.ready
    const rows = await this.db.webhookDelivery.findMany({
      where: { repoId, deliveryKey, consumer },
      orderBy: { createdAt: "asc" },
      take: 20,
    })
    return rows.map(rowData).find((delivery) => delivery.status !== "rejected" && !delivery.duplicate)
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

  async createDelivery(input = {}) {
    await this.ready
    const createdAt = nowIso()
    const delivery = {
      id: input.id || randomId("delivery"),
      repoId: input.repoId,
      deliveryKey: input.deliveryKey,
      deliveryId: input.deliveryId || input.deliveryKey,
      consumer: input.consumer || "dispatch",
      event: input.event || "",
      routeAction: input.routeAction || "",
      status: input.status || "received",
      duplicate: Boolean(input.duplicate),
      payloadSummary: input.payloadSummary || {},
      resultSummary: input.resultSummary || {},
      error: input.error ? sanitizeError(input.error) : undefined,
      createdAt,
      updatedAt: createdAt,
    }
    await this.db.webhookDelivery.create({
      data: {
        id: delivery.id,
        repoId: delivery.repoId,
        deliveryKey: delivery.deliveryKey,
        consumer: delivery.consumer,
        data: delivery,
        createdAt: asDate(delivery.createdAt),
        updatedAt: asDate(delivery.updatedAt),
      },
    })
    await this.markRepositoryDelivery(delivery.repoId, delivery.updatedAt, delivery.error)
    return delivery
  }

  async updateDelivery(id, patch = {}) {
    await this.ready
    const row = await this.db.webhookDelivery.findUnique({ where: { id } })
    const delivery = rowData(row)
    if (!delivery) return undefined
    Object.assign(delivery, patch, {
      error: patch.error ? sanitizeError(patch.error) : patch.error === null ? undefined : delivery.error,
      updatedAt: nowIso(),
    })
    await this.db.webhookDelivery.update({
      where: { id },
      data: {
        data: delivery,
        updatedAt: asDate(delivery.updatedAt),
      },
    })
    await this.markRepositoryDelivery(delivery.repoId, delivery.updatedAt, delivery.error)
    return delivery
  }

  async markRepositoryDelivery(repoId, timestamp, error) {
    const repo = await this.getRepository(repoId)
    if (!repo) return
    repo.lastDeliveryAt = timestamp
    repo.lastError = error ? error.message : ""
    repo.updatedAt = timestamp
    await this.saveRepository(repo)
  }

  async createDispatchRun(input = {}) {
    await this.ready
    const createdAt = nowIso()
    const run = {
      id: input.id || randomId("run"),
      repoId: input.repoId,
      deliveryId: input.deliveryId || "",
      routeAction: input.routeAction || "",
      status: input.status || "started",
      resultSummary: input.resultSummary || {},
      error: input.error ? sanitizeError(input.error) : undefined,
      createdAt,
      updatedAt: createdAt,
    }
    await this.db.dispatchRun.create({
      data: {
        id: run.id,
        repoId: run.repoId,
        deliveryId: run.deliveryId,
        data: run,
        createdAt: asDate(run.createdAt),
        updatedAt: asDate(run.updatedAt),
      },
    })
    return run
  }

  async updateDispatchRun(id, patch = {}) {
    await this.ready
    const row = await this.db.dispatchRun.findUnique({ where: { id } })
    const run = rowData(row)
    if (!run) return undefined
    Object.assign(run, patch, {
      error: patch.error ? sanitizeError(patch.error) : patch.error === null ? undefined : run.error,
      updatedAt: nowIso(),
    })
    await this.db.dispatchRun.update({
      where: { id },
      data: {
        data: run,
        updatedAt: asDate(run.updatedAt),
      },
    })
    const repo = await this.getRepository(run.repoId)
    if (repo) {
      repo.lastDispatchAt = run.updatedAt
      repo.lastError = run.error ? run.error.message : ""
      repo.updatedAt = run.updatedAt
      await this.saveRepository(repo)
    }
    return run
  }

  async listDeliveries(repoId) {
    await this.ready
    const rows = await this.db.webhookDelivery.findMany({
      where: { repoId },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
    return rows.map(rowData)
  }

  async listDispatchRuns(repoId) {
    await this.ready
    const rows = await this.db.dispatchRun.findMany({
      where: { repoId },
      orderBy: { createdAt: "desc" },
      take: 500,
    })
    return rows.map(rowData)
  }

  async createSession(input = {}) {
    await this.ready
    const createdAt = nowIso()
    const session = {
      id: input.id || randomId("session"),
      provider: input.provider || input.gitServer && input.gitServer.type || "gitlab",
      gitServerId: input.gitServerId || "",
      gitServer: input.gitServer || {},
      user: input.user || {},
      scopes: input.scopes || [],
      expiresAt: input.expiresAt || "",
      createdAt,
      updatedAt: createdAt,
    }
    await this.db.oAuthSession.create({
      data: {
        id: session.id,
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
