// @ts-nocheck
import {
  nowIso,
  randomId,
  normalizeBaseUrl,
  normalizeAutomation,
  normalizeRunnerId,
  asDate,
  timestampValue,
  rowData,
} from "./shared.js"
import {
  CONSOLE_SESSION_TTL_MS,
  TOUCH_INTERVAL_MS,
  hashConsoleSessionToken,
  newConsoleSessionToken,
} from "../console-session.js"
import { fingerprintSecret } from "../sanitize.js"

function withCredentialStore(Base) {
  return class CredentialStore extends Base {
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
}

export { withCredentialStore }
