import type { DashboardDatabase } from './db.ts';
import { listProjectOptions, type ProjectOption } from './projects.ts';
import { FLOW_STAGES, STAGE_SECONDS_FIELD, type FlowStageKey } from './stages.ts';

type TotalsRow = {
  created_count: number;
  completed_count: number;
  human_intervention_total: number;
  automation_action_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  token_cost_usd: number;
  first_close_duration_avg: number | null;
  bug_count: number;
  reopened_bug_count: number;
  completed_bug_count: number;
};

type HumanRow = {
  issue_flow_gate_count: number;
  agentrix_user_message_count: number;
  agentrix_question_answer_count: number;
};

type StageSecondsRow = Record<`stage_${FlowStageKey}_sec`, number>;

type RawIssueRow = {
  project_id: string;
  project_name: string | null;
  project_path: string | null;
  iid: number;
  title: string | null;
  author: string | null;
  assignee: string | null;
  state: string | null;
  current_flow_stage: string | null;
  issue_type: string | null;
  priority: string | null;
  human_intervention_total: number;
  automation_action_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  token_cost_usd: number;
  created_at: number | null;
  first_closed_at: number | null;
  first_close_duration_sec: number | null;
  reopen_count: number;
  stage_triage_sec: number;
  stage_plan_sec: number;
  stage_build_sec: number;
  stage_clarify_sec: number;
  stage_approve_sec: number;
  stage_unknown_sec: number;
  updated_at: number | null;
  collected_at: number | null;
  agentrix_task_count: number;
};

export type IssueRow = Omit<RawIssueRow, 'agentrix_task_count'> & {
  agentrixTaskCount: number;
  projectName: string | null;
  projectPath: string | null;
};

type AgentrixTaskTotalsRow = {
  task_count: number;
  unlinked_task_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
};

type AgentrixTaskRow = {
  task_id: string;
  runner_id: string | null;
  project_id: string | null;
  issue_iid: number | null;
  action: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  last_sequence: number | null;
  collected_at: number | null;
};

export type WindowDays = 7 | 14 | 30;

type SummaryOptions = {
  now?: number;
  windowDays?: WindowDays | 'all';
  windowStart?: number | null;
  windowEnd?: number | null;
  projectId?: string | null;
  stageClosedOnly?: boolean;
  trendGrain?: 'day' | 'week' | 'month';
};

type WindowInfo = {
  mode: 'all' | 'preset' | 'custom';
  days: number | null;
  since: number | null;
  until: number;
  label: string;
};

type OpenIssueSummaryRow = {
  current_flow_stage: string | null;
  issue_type: string | null;
};

export type Quantiles = {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  n: number;
};

export type StageShare = {
  total: {
    totalSeconds: number;
    total_seconds: number;
    issueCount: number;
    issue_count: number;
    averageSeconds: number | null;
    average_seconds: number | null;
    stages: Record<
      FlowStageKey,
      {
        seconds: number;
        averageSeconds: number | null;
        average_seconds: number | null;
        share: number | null;
        visited: number;
      }
    >;
  };
};

export type TrendPoint = {
  key: string;
  label: string;
  shortLabel: string;
  short_label: string;
  bucketStart: number;
  bucketEnd: number;
  created: number;
  completed: number;
  unfinished: number;
  firstCloseP50: number | null;
  first_close_p50: number | null;
  firstCloseP75: number | null;
  first_close_p75: number | null;
  firstCloseP90: number | null;
  first_close_p90: number | null;
  firstCloseN: number;
  first_close_n: number;
  newBugs: number;
  new_bugs: number;
  newBugRatio: number | null;
  new_bug_ratio: number | null;
  cumulativeBugs: number;
  cumulative_bugs: number;
  cumulativeCreated: number;
  cumulative_created: number;
  cumulativeBugRatio: number | null;
  cumulative_bug_ratio: number | null;
};

export type IssueListFilter = {
  projectId?: string | null;
  type?: string | null;
  state?: 'opened' | 'closed' | null;
  createdSince?: number | null;
  createdUntil?: number | null;
  onlyReopened?: boolean;
  page: number;
  pageSize: number;
  orderBy: 'created_at' | 'first_closed_at' | 'first_close_duration_sec' | 'reopen_count' | 'token_total' | 'token_cost_usd' | 'human_intervention_total';
  order: 'asc' | 'desc';
};

function coerceNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function localDate(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseLocalDateRange(startDate?: string | null, endDate?: string | null) {
  if (!startDate || !endDate) return null;
  const start = Date.parse(`${startDate}T00:00:00`);
  const end = Date.parse(`${endDate}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { since: start, until: end + 24 * 60 * 60 * 1000 };
}

function getWindowInfo(options: SummaryOptions = {}): WindowInfo {
  const until = options.now ?? Date.now();
  if (options.windowStart != null && options.windowEnd != null && options.windowEnd > options.windowStart) {
    return {
      mode: 'custom',
      days: null,
      since: options.windowStart,
      until: options.windowEnd,
      label: `${localDate(options.windowStart)} 至 ${localDate(options.windowEnd - 1)}`
    };
  }
  if (!options.windowDays || options.windowDays === 'all') {
    return { mode: 'all', days: null, since: null, until, label: '全量累计' };
  }
  return {
    mode: 'preset',
    days: options.windowDays,
    since: until - options.windowDays * 24 * 60 * 60 * 1000,
    until,
    label: `最近 ${options.windowDays} 天`
  };
}

function issueWindowWhere(window: WindowInfo, alias = 'issues') {
  if (window.since == null) {
    return { sql: '1=1', params: [] as unknown[] };
  }
  return {
    sql: `${alias}.created_at >= ? and ${alias}.created_at < ?`,
    params: [window.since, window.until] as unknown[]
  };
}

function projectWhere(projectId?: string | null, alias = 'issues') {
  if (!projectId) return { sql: '1=1', params: [] as unknown[] };
  return { sql: `${alias}.project_id = ?`, params: [projectId] as unknown[] };
}

function combineWhere(...parts: Array<{ sql: string; params: unknown[] }>) {
  return {
    sql: parts.map((part) => `(${part.sql})`).join(' and '),
    params: parts.flatMap((part) => part.params)
  };
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function quantiles(values: Array<number | null | undefined>): Quantiles {
  const arr = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    p50: percentile(arr, 0.5),
    p75: percentile(arr, 0.75),
    p90: percentile(arr, 0.9),
    n: arr.length
  };
}

function emptyCountMap<T extends string>(keys: readonly T[]) {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

function normalizeStage(stage: string | null | undefined): FlowStageKey {
  return FLOW_STAGES.includes(stage as FlowStageKey) ? (stage as FlowStageKey) : 'unknown';
}

function getOpenIssueSummary(db: DashboardDatabase, projectId?: string | null) {
  const filter = projectWhere(projectId);
  const rows = db.prepare(`
    select current_flow_stage, issue_type
    from issues
    where state = 'opened' and ${filter.sql}
  `).all(...filter.params) as OpenIssueSummaryRow[];
  const byStage = emptyCountMap(FLOW_STAGES);
  const byType = emptyCountMap(['feature', 'bug', 'debt', 'ops', 'design', 'spike', 'group', 'unknown'] as const);

  for (const row of rows) {
    byStage[normalizeStage(row.current_flow_stage)] += 1;
    const type = row.issue_type && row.issue_type in byType ? row.issue_type : 'unknown';
    byType[type as keyof typeof byType] += 1;
  }

  return { total: rows.length, byStage, byType };
}

function selectStageRows(db: DashboardDatabase, where: { sql: string; params: unknown[] }, closedOnly: boolean) {
  const closedClause = closedOnly ? 'and first_close_duration_sec is not null' : '';
  return db.prepare(`
    select stage_triage_sec, stage_plan_sec, stage_build_sec, stage_clarify_sec,
      stage_approve_sec, stage_unknown_sec
    from issues
    where ${where.sql} ${closedClause}
  `).all(...where.params) as StageSecondsRow[];
}

function stageValue(row: StageSecondsRow, stage: FlowStageKey) {
  return coerceNumber(row[STAGE_SECONDS_FIELD[stage] as keyof StageSecondsRow]);
}

function getStageDurations(db: DashboardDatabase, where: { sql: string; params: unknown[] }, closedOnly: boolean) {
  const rows = selectStageRows(db, where, closedOnly);
  return Object.fromEntries(
    FLOW_STAGES.map((stage) => [stage, quantiles(rows.map((row) => stageValue(row, stage)))])
  ) as Record<FlowStageKey, Quantiles>;
}

function getStageShare(db: DashboardDatabase, where: { sql: string; params: unknown[] }): StageShare {
  const rows = selectStageRows(db, where, true);
  const stages = Object.fromEntries(
    FLOW_STAGES.map((stage) => [
      stage,
      {
        seconds: 0,
        averageSeconds: null as number | null,
        average_seconds: null as number | null,
        share: null as number | null,
        visited: 0
      }
    ])
  ) as StageShare['total']['stages'];
  let total = 0;
  for (const row of rows) {
    for (const stage of FLOW_STAGES) {
      const seconds = stageValue(row, stage);
      total += seconds;
      stages[stage].seconds += seconds;
      if (seconds > 0) stages[stage].visited += 1;
    }
  }
  for (const stage of FLOW_STAGES) {
    stages[stage].share = total > 0 ? stages[stage].seconds / total : null;
    stages[stage].averageSeconds = rows.length > 0 ? stages[stage].seconds / rows.length : null;
    stages[stage].average_seconds = stages[stage].averageSeconds;
  }
  const average = rows.length > 0 ? total / rows.length : null;
  return {
    total: {
      totalSeconds: total,
      total_seconds: total,
      issueCount: rows.length,
      issue_count: rows.length,
      averageSeconds: average,
      average_seconds: average,
      stages
    }
  };
}

function startOfLocalDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms: number, days: number) {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function buildTrend(db: DashboardDatabase, options: SummaryOptions, projectId?: string | null): TrendPoint[] {
  const now = options.now ?? Date.now();
  const grain = options.trendGrain ?? 'day';
  const bucketDays = grain === 'month' ? 30 : grain === 'week' ? 7 : 1;
  const bucketCount = grain === 'day' ? 30 : 12;
  const end = addDays(startOfLocalDay(now), 1);
  const start = addDays(end, -bucketDays * bucketCount);
  const rows = db.prepare(`
    select created_at, first_close_duration_sec, is_bug_ever
    from issues
    where created_at >= ? and created_at < ? and ${projectWhere(projectId).sql}
  `).all(start, end, ...projectWhere(projectId).params) as Array<{
    created_at: number | null;
    first_close_duration_sec: number | null;
    is_bug_ever: number | null;
  }>;

  let cumulativeBugs = 0;
  let cumulativeCreated = 0;
  const points: TrendPoint[] = [];
  for (let bucketStart = start; bucketStart < end; bucketStart = addDays(bucketStart, bucketDays)) {
    const bucketEnd = Math.min(addDays(bucketStart, bucketDays), end);
    const bucketRows = rows.filter((row) => row.created_at != null && row.created_at >= bucketStart && row.created_at < bucketEnd);
    const created = bucketRows.length;
    const durations = bucketRows.map((row) => row.first_close_duration_sec).filter((value): value is number => value != null);
    const completed = durations.length;
    const bugs = bucketRows.filter((row) => row.is_bug_ever === 1).length;
    cumulativeBugs += bugs;
    cumulativeCreated += created;
    const q = quantiles(durations);
    const shortLabel = localDate(bucketStart).slice(5);
    points.push({
      key: `${grain}:${bucketStart}`,
      label: localDate(bucketStart),
      shortLabel,
      short_label: shortLabel,
      bucketStart,
      bucketEnd,
      created,
      completed,
      unfinished: created - completed,
      firstCloseP50: q.p50,
      first_close_p50: q.p50,
      firstCloseP75: q.p75,
      first_close_p75: q.p75,
      firstCloseP90: q.p90,
      first_close_p90: q.p90,
      firstCloseN: q.n,
      first_close_n: q.n,
      newBugs: bugs,
      new_bugs: bugs,
      newBugRatio: created > 0 ? bugs / created : null,
      new_bug_ratio: created > 0 ? bugs / created : null,
      cumulativeBugs,
      cumulative_bugs: cumulativeBugs,
      cumulativeCreated,
      cumulative_created: cumulativeCreated,
      cumulativeBugRatio: cumulativeCreated > 0 ? cumulativeBugs / cumulativeCreated : null,
      cumulative_bug_ratio: cumulativeCreated > 0 ? cumulativeBugs / cumulativeCreated : null
    });
  }
  return points;
}

function mapIssueRow(row: RawIssueRow): IssueRow {
  return {
    ...row,
    agentrixTaskCount: coerceNumber(row.agentrix_task_count),
    projectName: row.project_name,
    projectPath: row.project_path
  };
}

function issueOrderExpression(orderBy: IssueListFilter['orderBy']) {
  if (orderBy === 'token_total') {
    return 'coalesce(i.input_tokens, 0) + coalesce(i.output_tokens, 0)';
  }
  return `i.${orderBy}`;
}

export function queryIssueList(db: DashboardDatabase, filter: IssueListFilter) {
  const wheres = ['1=1'];
  const params: unknown[] = [];
  if (filter.projectId) {
    wheres.push('i.project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.type) {
    wheres.push('i.issue_type = ?');
    params.push(filter.type);
  }
  if (filter.state) {
    wheres.push('i.state = ?');
    params.push(filter.state);
  }
  if (filter.createdSince != null) {
    wheres.push('i.created_at >= ?');
    params.push(filter.createdSince);
  }
  if (filter.createdUntil != null) {
    wheres.push('i.created_at < ?');
    params.push(filter.createdUntil);
  }
  if (filter.onlyReopened) {
    wheres.push('i.reopen_count > 0');
  }
  const whereSql = wheres.join(' and ');
  const orderBy = filter.orderBy;
  const orderExpression = issueOrderExpression(orderBy);
  const order = filter.order === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, filter.page);
  const pageSize = Math.max(1, Math.min(200, filter.pageSize));
  const offset = (page - 1) * pageSize;

  const total = db.prepare(`select count(*) as c from issues i where ${whereSql}`).get(...params) as { c: number };
  const rows = db.prepare(`
    select i.*,
      coalesce(p.path_with_namespace, p.name, i.project_id) as project_name,
      p.path_with_namespace as project_path,
      (
        select count(*)
        from agentrix_tasks t
        where t.project_id = i.project_id and t.issue_iid = i.iid
      ) as agentrix_task_count
    from issues i
    left join projects p on p.id = i.project_id
    where ${whereSql}
    order by ${orderExpression} is null, ${orderExpression} ${order}, i.iid desc
    limit ? offset ?
  `).all(...params, pageSize, offset) as RawIssueRow[];

  return {
    total: coerceNumber(total.c),
    page,
    pageSize,
    rows: rows.map(mapIssueRow)
  };
}

function getDataFreshness(db: DashboardDatabase, projectId?: string | null) {
  const sql = projectId ? 'p.id = ?' : '1=1';
  const params = projectId ? [projectId] : [];
  const rows = db.prepare(`
    select id, coalesce(path_with_namespace, name, id) as name, last_success_at
    from projects p
    where active = 1 and ${sql}
    order by name
  `).all(...params) as Array<{ id: string; name: string; last_success_at: number | null }>;
  const times = rows.map((row) => row.last_success_at).filter((value): value is number => value != null);
  return {
    lastSuccessAt: times.length > 0 ? Math.min(...times) : null,
    last_success_at: times.length > 0 ? Math.min(...times) : null,
    perProject: rows,
    per_project: rows
  };
}

export function getDashboardSummary(db: DashboardDatabase, options: SummaryOptions = {}) {
  const window = getWindowInfo(options);
  const projectId = options.projectId || null;
  const where = combineWhere(issueWindowWhere(window), projectWhere(projectId));
  const totals = db.prepare(`
    select
      count(*) as created_count,
      sum(case when first_close_duration_sec is not null then 1 else 0 end) as completed_count,
      coalesce(sum(human_intervention_total), 0) as human_intervention_total,
      coalesce(sum(automation_action_count), 0) as automation_action_count,
      coalesce(sum(input_tokens), 0) as input_tokens,
      coalesce(sum(output_tokens), 0) as output_tokens,
      coalesce(sum(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
      coalesce(sum(cache_read_input_tokens), 0) as cache_read_input_tokens,
      coalesce(sum(token_cost_usd), 0) as token_cost_usd,
      avg(first_close_duration_sec) as first_close_duration_avg,
      coalesce(sum(is_bug_ever), 0) as bug_count,
      coalesce(sum(case when is_bug_ever = 1 and first_close_duration_sec is not null and reopen_count > 0 then 1 else 0 end), 0) as reopened_bug_count,
      coalesce(sum(case when is_bug_ever = 1 and first_close_duration_sec is not null then 1 else 0 end), 0) as completed_bug_count
    from issues
    where ${where.sql}
  `).get(...where.params) as TotalsRow;

  const human = db.prepare(`
    select
      coalesce(sum(issue_flow_gate_count), 0) as issue_flow_gate_count,
      coalesce(sum(agentrix_user_message_count), 0) as agentrix_user_message_count,
      coalesce(sum(agentrix_question_answer_count), 0) as agentrix_question_answer_count
    from issues
    where ${where.sql}
  `).get(...where.params) as HumanRow;

  const stages = db.prepare(`
    select
      coalesce(sum(stage_triage_sec), 0) as stage_triage_sec,
      coalesce(sum(stage_plan_sec), 0) as stage_plan_sec,
      coalesce(sum(stage_build_sec), 0) as stage_build_sec,
      coalesce(sum(stage_clarify_sec), 0) as stage_clarify_sec,
      coalesce(sum(stage_approve_sec), 0) as stage_approve_sec,
      coalesce(sum(stage_unknown_sec), 0) as stage_unknown_sec
    from issues
    where ${where.sql}
  `).get(...where.params) as StageSecondsRow;

  const agentrixTasks = db.prepare(`
    select
      count(*) as task_count,
      sum(case when project_id is null or issue_iid is null then 1 else 0 end) as unlinked_task_count,
      coalesce(sum(input_tokens), 0) as input_tokens,
      coalesce(sum(output_tokens), 0) as output_tokens,
      coalesce(sum(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
      coalesce(sum(cache_read_input_tokens), 0) as cache_read_input_tokens,
      coalesce(sum(cost_usd), 0) as cost_usd
    from agentrix_tasks
  `).get() as AgentrixTaskTotalsRow;

  const recentAgentrixTasks = db.prepare(`
    select task_id, runner_id, project_id, issue_iid, action, input_tokens, output_tokens,
      cost_usd, last_sequence, collected_at
    from agentrix_tasks
    order by coalesce(collected_at, 0) desc
    limit 20
  `).all() as AgentrixTaskRow[];

  const openIssues = queryIssueList(db, {
    projectId,
    createdSince: window.since,
    createdUntil: window.since == null ? null : window.until,
    page: 1,
    pageSize: 50,
    orderBy: 'created_at',
    order: 'desc'
  }).rows;
  const projects = listProjectOptions(db);
  const selectedProject = projectId ? projects.find((project) => project.id === projectId) ?? null : null;
  const createdCount = coerceNumber(totals.created_count);
  const completedBugCount = coerceNumber(totals.completed_bug_count);

  return {
    window,
    project: selectedProject,
    projects: projects as ProjectOption[],
    freshness: getDataFreshness(db, projectId),
    totals: {
      createdCount,
      completedCount: coerceNumber(totals.completed_count),
      humanInterventionTotal: coerceNumber(totals.human_intervention_total),
      automationActionCount: coerceNumber(totals.automation_action_count),
      inputTokens: coerceNumber(totals.input_tokens),
      outputTokens: coerceNumber(totals.output_tokens),
      cacheCreationInputTokens: coerceNumber(totals.cache_creation_input_tokens),
      cacheReadInputTokens: coerceNumber(totals.cache_read_input_tokens),
      tokenCostUsd: coerceNumber(totals.token_cost_usd),
      averageFirstCloseDurationSec: totals.first_close_duration_avg,
      bugCount: coerceNumber(totals.bug_count),
      newBugLoadRate: {
        newBugs: coerceNumber(totals.bug_count),
        totalIssues: createdCount,
        rate: createdCount > 0 ? coerceNumber(totals.bug_count) / createdCount : null
      },
      reopenRate: {
        numerator: coerceNumber(totals.reopened_bug_count),
        denominator: completedBugCount,
        rate: completedBugCount > 0 ? coerceNumber(totals.reopened_bug_count) / completedBugCount : null
      }
    },
    agentrixTasks: {
      taskCount: coerceNumber(agentrixTasks.task_count),
      unlinkedTaskCount: coerceNumber(agentrixTasks.unlinked_task_count),
      inputTokens: coerceNumber(agentrixTasks.input_tokens),
      outputTokens: coerceNumber(agentrixTasks.output_tokens),
      cacheCreationInputTokens: coerceNumber(agentrixTasks.cache_creation_input_tokens),
      cacheReadInputTokens: coerceNumber(agentrixTasks.cache_read_input_tokens),
      costUsd: coerceNumber(agentrixTasks.cost_usd),
      recent: recentAgentrixTasks
    },
    dataQuality: {
      unlinkedAgentrixTaskCount: coerceNumber(agentrixTasks.unlinked_task_count)
    },
    humanBreakdown: {
      issueFlowGates: coerceNumber(human.issue_flow_gate_count),
      agentrixUserMessages: coerceNumber(human.agentrix_user_message_count),
      agentrixQuestionAnswers: coerceNumber(human.agentrix_question_answer_count)
    },
    stageTotals: {
      triageSec: coerceNumber(stages.stage_triage_sec),
      planSec: coerceNumber(stages.stage_plan_sec),
      buildSec: coerceNumber(stages.stage_build_sec),
      clarifySec: coerceNumber(stages.stage_clarify_sec),
      approveSec: coerceNumber(stages.stage_approve_sec),
      unknownSec: coerceNumber(stages.stage_unknown_sec),
      intakeDurationSec: coerceNumber(stages.stage_triage_sec) + coerceNumber(stages.stage_clarify_sec),
      planDurationSec: coerceNumber(stages.stage_plan_sec) + coerceNumber(stages.stage_approve_sec),
      deliveryDurationSec: coerceNumber(stages.stage_build_sec)
    },
    stageDurations: getStageDurations(db, where, Boolean(options.stageClosedOnly)),
    stageShare: getStageShare(db, where),
    trend: buildTrend(db, options, projectId),
    openIssueSummary: getOpenIssueSummary(db, projectId),
    openIssues
  };
}
