// @ts-nocheck
import {
  nowIso,
  randomId,
  asDate,
  timestampValue,
  nullableDate,
} from "./shared.js"

function withIssueStore(Base) {
  return class IssueStore extends Base {
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
        createdByTaskId: row.createdByTaskId || "",
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
        createdByTaskId: String(input.createdByTaskId || existing && existing.createdByTaskId || ""),
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
      await this.backfillTaskIssueFromCreator(row, client)
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
  }
}

export { withIssueStore }
