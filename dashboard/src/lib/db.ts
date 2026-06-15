import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { migrate } from './schema.ts';

export type DashboardDatabase = BetterSqliteDatabase;

export function defaultDbPath() {
  return join(process.cwd(), 'data', 'dashboard.db');
}

export function openDashboardDb(dbPath = process.env.DASHBOARD_DB_PATH || defaultDbPath()) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrate(db);
  repairAgentrixIssueRollups(db);
  return db;
}

export function upsertIssueShell(
  db: DashboardDatabase,
  input: {
    projectId: string;
    iid: number;
    title?: string | null;
    createdAt?: number | null;
  }
) {
  db.prepare(`
    insert into issues (project_id, iid, title, created_at, updated_at, collected_at)
    values (@projectId, @iid, @title, @createdAt, @now, @now)
    on conflict(project_id, iid) do update set
      title = coalesce(excluded.title, issues.title),
      created_at = coalesce(excluded.created_at, issues.created_at),
      updated_at = excluded.updated_at,
      collected_at = excluded.collected_at
  `).run({
    projectId: input.projectId,
    iid: input.iid,
    title: input.title ?? null,
    createdAt: input.createdAt ?? null,
    now: Date.now()
  });
}

export function recomputeIssueAgentrixMetrics(db: DashboardDatabase, projectId: string, issueIid: number) {
  backfillAgentrixHumanEventLinksForIssue(db, projectId, issueIid);

  const taskTotals = db.prepare(`
    select
      coalesce(sum(input_tokens), 0) as input_tokens,
      coalesce(sum(output_tokens), 0) as output_tokens,
      coalesce(sum(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
      coalesce(sum(cache_read_input_tokens), 0) as cache_read_input_tokens,
      coalesce(sum(cost_usd), 0) as token_cost_usd
    from agentrix_tasks
    where project_id = ? and issue_iid = ?
  `).get(projectId, issueIid) as Record<string, number>;

  const humanTotals = db.prepare(`
    select
      sum(case when event_type = 'user_message' then 1 else 0 end) as user_messages,
      sum(case when event_type = 'question_answer' then 1 else 0 end) as question_answers
    from agentrix_human_events
    where project_id = ? and issue_iid = ?
  `).get(projectId, issueIid) as { user_messages: number | null; question_answers: number | null };

  db.prepare(`
    update issues set
      agentrix_user_message_count = @userMessages,
      agentrix_question_answer_count = @questionAnswers,
      human_intervention_total = issue_flow_gate_count + @userMessages + @questionAnswers,
      input_tokens = @input_tokens,
      output_tokens = @output_tokens,
      cache_creation_input_tokens = @cache_creation_input_tokens,
      cache_read_input_tokens = @cache_read_input_tokens,
      token_cost_usd = @token_cost_usd,
      updated_at = @now
    where project_id = @projectId and iid = @issueIid
  `).run({
    projectId,
    issueIid,
    userMessages: humanTotals.user_messages ?? 0,
    questionAnswers: humanTotals.question_answers ?? 0,
    ...taskTotals,
    now: Date.now()
  });
}

function backfillAgentrixHumanEventLinksForIssue(db: DashboardDatabase, projectId: string, issueIid: number) {
  db.prepare(`
    update agentrix_human_events
    set
      project_id = @projectId,
      issue_iid = @issueIid
    where task_id in (
      select task_id
      from agentrix_tasks
      where project_id = @projectId and issue_iid = @issueIid
    )
      and (project_id is null or issue_iid is null)
  `).run({ projectId, issueIid });
}

function backfillAllAgentrixHumanEventLinks(db: DashboardDatabase) {
  db.prepare(`
    update agentrix_human_events
    set
      project_id = (
        select t.project_id
        from agentrix_tasks t
        where t.task_id = agentrix_human_events.task_id
      ),
      issue_iid = (
        select t.issue_iid
        from agentrix_tasks t
        where t.task_id = agentrix_human_events.task_id
      )
    where (project_id is null or issue_iid is null)
      and exists (
        select 1
        from agentrix_tasks t
        where t.task_id = agentrix_human_events.task_id
          and t.project_id is not null
          and t.issue_iid is not null
      )
  `).run();
}

export function repairAgentrixIssueRollups(db: DashboardDatabase) {
  const run = db.transaction(() => {
    backfillAllAgentrixHumanEventLinks(db);
    db.prepare(`
      update issues
      set
        agentrix_user_message_count = (
          select count(*)
          from agentrix_human_events e
          where e.project_id = issues.project_id
            and e.issue_iid = issues.iid
            and e.event_type = 'user_message'
        ),
        agentrix_question_answer_count = (
          select count(*)
          from agentrix_human_events e
          where e.project_id = issues.project_id
            and e.issue_iid = issues.iid
            and e.event_type = 'question_answer'
        ),
        human_intervention_total = coalesce(issue_flow_gate_count, 0)
          + (
            select count(*)
            from agentrix_human_events e
            where e.project_id = issues.project_id
              and e.issue_iid = issues.iid
              and e.event_type = 'user_message'
          )
          + (
            select count(*)
            from agentrix_human_events e
            where e.project_id = issues.project_id
              and e.issue_iid = issues.iid
              and e.event_type = 'question_answer'
          ),
        input_tokens = coalesce((
          select sum(t.input_tokens)
          from agentrix_tasks t
          where t.project_id = issues.project_id
            and t.issue_iid = issues.iid
        ), 0),
        output_tokens = coalesce((
          select sum(t.output_tokens)
          from agentrix_tasks t
          where t.project_id = issues.project_id
            and t.issue_iid = issues.iid
        ), 0),
        cache_creation_input_tokens = coalesce((
          select sum(t.cache_creation_input_tokens)
          from agentrix_tasks t
          where t.project_id = issues.project_id
            and t.issue_iid = issues.iid
        ), 0),
        cache_read_input_tokens = coalesce((
          select sum(t.cache_read_input_tokens)
          from agentrix_tasks t
          where t.project_id = issues.project_id
            and t.issue_iid = issues.iid
        ), 0),
        token_cost_usd = coalesce((
          select sum(t.cost_usd)
          from agentrix_tasks t
          where t.project_id = issues.project_id
            and t.issue_iid = issues.iid
        ), 0)
    `).run();
  });
  run();
}
