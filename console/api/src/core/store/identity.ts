// @ts-nocheck
import {
  nowIso,
  randomId,
  normalizeBaseUrl,
  normalizeApiUrl,
  normalizeOauthScopes,
  normalizeGitServer,
  asDate,
  timestampValue,
  normalizeUser,
  normalizeGitAccount,
} from "./shared.js"
import { fingerprintSecret } from "../sanitize.js"

function withIdentityStore(Base) {
  return class IdentityStore extends Base {
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
  }
}

export { withIdentityStore }
