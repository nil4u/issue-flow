// @ts-nocheck
import {
  nowIso,
  randomId,
  asDate,
  timestampValue,
  nullableDate,
} from "./shared.js"
import { normalizeTaskAction } from "../task-projection.js"

function withTaskStore(Base) {
  return class TaskStore extends Base {
    taskFromRecord(row) {
      if (!row) return undefined
      return {
        id: row.id,
        gitServerId: row.gitServerId || "",
        repositoryId: row.repositoryId || "",
        repositoryFullName: row.repositoryFullName || "",
        issueNumber: row.issueNumber || 0,
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

    async applyTaskIssueBackfill(row, issue, client = this.db) {
      if (!row || !issue) return row
      const conflict = (
        row.gitServerId && row.gitServerId !== issue.gitServerId
        || row.repositoryId && row.repositoryId !== issue.repositoryId
      )
      if (conflict) return row

      const sameIssue = !row.issueNumber || row.issueNumber === issue.issueNumber
      const creatorAction = sameIssue && !row.action && issue.createdByTaskId === row.taskId
        ? "create"
        : row.action
      if (row.issueNumber) {
        if (!creatorAction || creatorAction === row.action) return row
        const updated = await client.task.update({
          where: { id: row.id },
          data: { action: creatorAction, updatedAt: new Date() },
        })
        await this.syncTaskLinkDependents(updated, client)
        return updated
      }

      const updated = await client.task.updateMany({
        where: {
          id: row.id,
          gitServerId: row.gitServerId,
          repositoryId: row.repositoryId,
          issueNumber: 0,
        },
        data: {
          gitServerId: issue.gitServerId,
          repositoryId: issue.repositoryId,
          repositoryFullName: issue.repositoryFullName,
          issueNumber: issue.issueNumber,
          action: creatorAction,
          updatedAt: new Date(),
        },
      })
      if (!updated.count) return client.task.findUnique({ where: { id: row.id } })

      const linked = await client.task.findUnique({ where: { id: row.id } })
      await this.syncTaskLinkDependents(linked, client)
      return linked
    }

    async backfillTaskIssueFromCreator(issue, client = this.db) {
      if (!issue || !issue.createdByTaskId) return undefined
      let task = await client.task.findUnique({ where: { taskId: issue.createdByTaskId } })
      if (!task) {
        try {
          task = await client.task.create({
            data: {
              id: randomId("task"),
              taskId: issue.createdByTaskId,
              gitServerId: issue.gitServerId,
              repositoryId: issue.repositoryId,
              repositoryFullName: issue.repositoryFullName,
              issueNumber: issue.issueNumber,
              action: "create",
              status: "unknown",
              updatedAt: new Date(),
            },
          })
          await this.syncTaskLinkDependents(task, client)
          return task
        } catch (error) {
          if (!error || error.code !== "P2002") throw error
          task = await client.task.findUnique({ where: { taskId: issue.createdByTaskId } })
        }
      }
      return this.applyTaskIssueBackfill(task, issue, client)
    }

    async backfillTaskIssueFromCreatedIssue(row, client = this.db) {
      if (!row || !row.taskId) return row
      if (row.issueNumber) {
        const issue = await client.issue.findUnique({
          where: {
            gitServerId_repositoryId_issueNumber: {
              gitServerId: row.gitServerId,
              repositoryId: row.repositoryId,
              issueNumber: row.issueNumber,
            },
          },
        })
        return issue && issue.createdByTaskId === row.taskId
          ? this.applyTaskIssueBackfill(row, issue, client)
          : row
      }
      const issues = await client.issue.findMany({
        where: { createdByTaskId: row.taskId },
        orderBy: { updatedAt: "desc" },
        take: 2,
      })
      if (issues.length !== 1) return row
      return this.applyTaskIssueBackfill(row, issues[0], client)
    }

    async syncTaskLinkDependents(row, client = this.db, options = {}) {
      if (!row || !row.issueNumber) return row
      await client.taskEvent.updateMany({
        where: options.replace ? { taskId: row.taskId } : { taskId: row.taskId, issueNumber: 0 },
        data: {
          gitServerId: row.gitServerId,
          repositoryId: row.repositoryId,
          repositoryFullName: row.repositoryFullName,
          issueNumber: row.issueNumber,
        },
      })
      this.scheduleIssueStatsRebuild({
        gitServerId: row.gitServerId,
        repositoryId: row.repositoryId,
        issueNumber: row.issueNumber,
      })
      return row
    }

    async upsertTaskMarkerLink(input = {}, client = this.db) {
      await this.ready
      const taskId = String(input.taskId || "").trim()
      const gitServerId = String(input.gitServerId || "").trim()
      const repositoryId = String(input.repositoryId || "").trim()
      const issueNumber = Number(input.issueNumber || 0)
      if (!taskId || !gitServerId || !repositoryId) {
        return { task: undefined, applied: false }
      }

      const issue = issueNumber
        ? await client.issue.findUnique({
          where: { gitServerId_repositoryId_issueNumber: { gitServerId, repositoryId, issueNumber } },
        })
        : undefined
      const before = await client.task.findUnique({ where: { taskId } })
      if (before) {
        const candidate = issue || {
          gitServerId,
          repositoryId,
          repositoryFullName: String(input.repositoryFullName || ""),
          issueNumber,
        }
        const row = await this.applyTaskIssueBackfill(before, candidate, client)
        return { task: this.taskFromRecord(row), applied: !before.issueNumber && Boolean(issueNumber) }
      }
      if (issue) {
        try {
          const row = await client.task.create({
            data: {
              id: input.id || randomId("task"),
              taskId,
              gitServerId,
              repositoryId,
              repositoryFullName: issue.repositoryFullName,
              issueNumber,
              action: issue.createdByTaskId === taskId ? "create" : "",
              status: "unknown",
              updatedAt: new Date(),
            },
          })
          await this.syncTaskLinkDependents(row, client)
          return { task: this.taskFromRecord(row), applied: true }
        } catch (error) {
          if (!error || error.code !== "P2002") throw error
          const existing = await client.task.findUnique({ where: { taskId } })
          const row = await this.applyTaskIssueBackfill(existing, issue, client)
          return { task: this.taskFromRecord(row), applied: true }
        }
      }

      try {
        const row = await client.task.create({
          data: {
            id: input.id || randomId("task"),
            taskId,
            gitServerId,
            repositoryId,
            repositoryFullName: String(input.repositoryFullName || ""),
            issueNumber,
            status: "unknown",
            updatedAt: new Date(),
          },
        })
        return { task: this.taskFromRecord(row), applied: true }
      } catch (error) {
        if (!error || error.code !== "P2002") throw error
        const row = await client.task.findUnique({ where: { taskId } })
        const linked = await this.applyTaskIssueBackfill(row, {
          gitServerId,
          repositoryId,
          repositoryFullName: String(input.repositoryFullName || ""),
          issueNumber,
        }, client)
        return { task: this.taskFromRecord(linked), applied: Boolean(row && !row.issueNumber && issueNumber) }
      }
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
      const issueChanged = Boolean(existing && issueNumber && (
        existing.gitServerId !== (gitServerId || existing.gitServerId)
        || existing.repositoryId !== (repositoryId || existing.repositoryId)
        || existing.issueNumber !== issueNumber
      ))
      const data = {
        gitServerId: gitServerId || existing && existing.gitServerId || "",
        repositoryId: repositoryId || existing && existing.repositoryId || "",
        repositoryFullName: issue
          ? issue.repositoryFullName
          : issueChanged ? "" : existing && existing.repositoryFullName || "",
        issueNumber: issueNumber || existing && existing.issueNumber || 0,
        action: normalizeTaskAction(input.action)
          || existing && existing.action
          || issue && issue.createdByTaskId === taskId && "create"
          || "",
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
      row = await this.backfillTaskIssueFromCreatedIssue(row, client)
      await this.syncTaskLinkDependents(row, client, { replace: issueChanged })
      if (issueChanged && existing.issueNumber) {
        this.scheduleIssueStatsRebuild({
          gitServerId: existing.gitServerId,
          repositoryId: existing.repositoryId,
          issueNumber: existing.issueNumber,
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
      row = await this.backfillTaskIssueFromCreatedIssue(row, client)
      if (row.issueNumber) {
        this.scheduleIssueStatsRebuild({
          gitServerId: row.gitServerId,
          repositoryId: row.repositoryId,
          issueNumber: row.issueNumber,
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
      if (task && task.issueNumber) {
        this.scheduleIssueStatsRebuild({
          gitServerId: task.gitServerId,
          repositoryId: task.repositoryId,
          issueNumber: task.issueNumber,
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
      if (task && task.issueNumber) {
        this.scheduleIssueStatsRebuild({
          gitServerId: task.gitServerId,
          repositoryId: task.repositoryId,
          issueNumber: task.issueNumber,
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
  }
}

export { withTaskStore }
