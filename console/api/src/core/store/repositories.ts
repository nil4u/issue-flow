// @ts-nocheck
import {
  nowIso,
  randomId,
  normalizeBaseUrl,
  normalizeApiUrl,
  normalizeAutomation,
  normalizeAgentrix,
  asDate,
  timestampValue,
  splitRepoFullName,
  normalizeRepoIdentity,
  jsonValue,
  emptyRepoSettings,
  repoSettingData,
  latestTimestamp,
  repoTaskKey,
} from "./shared.js"
import {
  ISSUE_FLOW_PLUGIN_KEY,
  pluginCacheWithLocalLatestVersion,
} from "../issue-flow-plugin.js"
import { fingerprintSecret } from "../sanitize.js"

function withRepositoryStore(Base) {
  return class RepositoryStore extends Base {
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
          settings.plugins.items.push(
            data.key === ISSUE_FLOW_PLUGIN_KEY
              ? pluginCacheWithLocalLatestVersion(data)
              : data,
          )
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
      const repoIds = accessRows.map((row) => isAdmin ? row.id : row.repoId)
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
        const currentPlugin = pluginCacheWithLocalLatestVersion(plugin)
        const installedVersion = currentPlugin.installedVersion || ""
        const latestVersion = currentPlugin.latestVersion || ""
        const needsUpgrade = currentPlugin.needsUpgrade
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
            detail: currentPlugin.detail || "",
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
  }
}

export { withRepositoryStore }
