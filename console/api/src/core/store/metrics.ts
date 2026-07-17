// @ts-nocheck
import {
  timestampValue,
  jsonValue,
} from "./shared.js"
import {
  METRICS_MAX_ROWS,
  METRICS_STATEMENT_TIMEOUT_MS,
  assertReadOnlyMetricsSql,
  bindMetricsParams,
  metricsResultFromRows,
} from "../metrics-sql.js"

function withMetricsStore(Base) {
  return class MetricsStore extends Base {
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
        createTaskSeconds: row.createTaskSeconds || 0,
        generalTaskSeconds: row.generalTaskSeconds || 0,
        triageTaskSeconds: row.triageTaskSeconds || 0,
        planTaskSeconds: row.planTaskSeconds || 0,
        buildTaskSeconds: row.buildTaskSeconds || 0,
        reviewTaskSeconds: row.reviewTaskSeconds || 0,
        totalTaskSeconds: row.totalTaskSeconds || 0,
        createTaskTurns: row.createTaskTurns || 0,
        generalTaskTurns: row.generalTaskTurns || 0,
        triageTaskTurns: row.triageTaskTurns || 0,
        planTaskTurns: row.planTaskTurns || 0,
        buildTaskTurns: row.buildTaskTurns || 0,
        reviewTaskTurns: row.reviewTaskTurns || 0,
        totalTaskTurns: row.totalTaskTurns || 0,
        pullRequestCount: row.pullRequestCount || 0,
        updatedAt: timestampValue(row.updatedAt),
      }
    }

    scheduleIssueStatsRebuild(input = {}) {
      const gitServerId = String(input.gitServerId || "").trim()
      const repositoryId = String(input.repositoryId || "").trim()
      const issueId = String(input.issueId || "").trim()
      const issueNumber = Number(input.issueNumber || 0)
      if (!gitServerId || !repositoryId || (!issueId && !issueNumber)) return
      const issueKey = issueId ? `id:${issueId}` : `number:${issueNumber}`
      this.pendingIssueStatsRebuilds.set(`${gitServerId}\n${repositoryId}\n${issueKey}`, {
        gitServerId,
        repositoryId,
        issueId,
        issueNumber,
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
      const requestedIssueId = String(input.issueId || "").trim()
      const requestedIssueNumber = Number(input.issueNumber || 0)
      if (!gitServerId || !repositoryId || (!requestedIssueId && !requestedIssueNumber)) return undefined
      const issue = requestedIssueId
        ? await client.issue.findUnique({
          where: {
            gitServerId_repositoryId_issueId: {
              gitServerId,
              repositoryId,
              issueId: requestedIssueId,
            },
          },
        })
        : await client.issue.findUnique({
          where: {
            gitServerId_repositoryId_issueNumber: {
              gitServerId,
              repositoryId,
              issueNumber: requestedIssueNumber,
            },
          },
        })
      if (!issue) return undefined
      const issueId = issue.issueId

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
        where: { gitServerId, repositoryId, issueNumber: issue.issueNumber },
      })
      const taskExecutionMs = { create: 0, general: 0, triage: 0, plan: 0, build: 0, review: 0 }
      const taskTurns = { create: 0, general: 0, triage: 0, plan: 0, build: 0, review: 0 }
      let totalTaskExecutionMs = 0
      let totalTaskTurns = 0
      let cycleStartedAt = null
      for (const task of tasks) {
        if (task.startedAt && (!cycleStartedAt || task.startedAt < cycleStartedAt)) {
          cycleStartedAt = task.startedAt
        }
        totalTaskExecutionMs += task.executionMs || 0
        totalTaskTurns += task.turns || 0
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
        createTaskSeconds: Math.round(taskExecutionMs.create / 1000),
        generalTaskSeconds: Math.round(taskExecutionMs.general / 1000),
        triageTaskSeconds: Math.round(taskExecutionMs.triage / 1000),
        planTaskSeconds: Math.round(taskExecutionMs.plan / 1000),
        buildTaskSeconds: Math.round(taskExecutionMs.build / 1000),
        reviewTaskSeconds: Math.round(taskExecutionMs.review / 1000),
        totalTaskSeconds: Math.round(totalTaskExecutionMs / 1000),
        createTaskTurns: taskTurns.create,
        generalTaskTurns: taskTurns.general,
        triageTaskTurns: taskTurns.triage,
        planTaskTurns: taskTurns.plan,
        buildTaskTurns: taskTurns.build,
        reviewTaskTurns: taskTurns.review,
        totalTaskTurns,
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
          i."created_by_task_id" as "createdByTaskId",
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
          coalesce(st."total_task_turns", 0) as "turnsCount",
          case
            when extract(epoch from (
              coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
              - least(
                  coalesce(st."cycle_started_at", st."opened_at", i."opened_at"),
                  coalesce(st."opened_at", i."opened_at")
                )
            )) > 0 then round((
              coalesce(st."total_task_seconds", 0)
            ) * 100.0 / extract(epoch from (
              coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
              - least(
                  coalesce(st."cycle_started_at", st."opened_at", i."opened_at"),
                  coalesce(st."opened_at", i."opened_at")
                )
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
  }
}

export { withMetricsStore }
