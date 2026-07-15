-- Enable evidence drilldowns for issue type and task-turn distributions.
UPDATE "dashboard_panels"
SET
    "drill_query_sql" = $drill$with scoped as (
  select
    i."id" as issue_row_id,
    i."issue_number" as issue_number,
    i."title" as title,
    i."type" as type,
    i."priority" as priority,
    i."size" as size,
    i."status" as status,
    i."flow" as flow,
    st."opened_at" as opened_at,
    coalesce(st."drop_at", st."done_at") as resolved_at,
    extract(epoch from (
      coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
    ))::int as duration_seconds,
    (
      coalesce(st."triage_task_turns", 0)
      + coalesce(st."plan_task_turns", 0)
      + coalesce(st."build_task_turns", 0)
      + coalesce(st."review_task_turns", 0)
    )::int as task_turns,
    case
      when extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
      )) > 0 then round((
        coalesce(st."triage_task_seconds", 0)
        + coalesce(st."plan_task_seconds", 0)
        + coalesce(st."build_task_seconds", 0)
        + coalesce(st."review_task_seconds", 0)
      ) * 100.0 / extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
      )))::int
      else 0
    end as agent_execution_pct,
    coalesce(w."weight", 1) as weight,
    case
      when i."type" = '' then '未分类'
      else 'type::' || i."type"
    end as issue_type,
    st."done_at" is not null as completed
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  left join "metric_size_weights" w on w."size" = i."size"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
), bucket_rows as (
  select *
  from scoped
  where issue_type = :bucket
), summary as (
  select
    count(*)::int as total_count,
    (select count(*)::int from scoped) as weekly_count,
    coalesce(sum(weight), 0)::numeric as weighted_total,
    count(*) filter (where completed)::int as done_count
  from bucket_rows
)
select
  b.issue_row_id,
  b.issue_number,
  b.title,
  b.type,
  b.priority,
  b.size,
  b.status,
  b.flow,
  b.opened_at,
  b.resolved_at,
  b.duration_seconds,
  b.task_turns,
  b.agent_execution_pct,
  s.total_count,
  s.weekly_count,
  s.weighted_total,
  s.done_count
from bucket_rows b
cross join summary s
order by b.resolved_at nulls first, b.duration_seconds desc, b.issue_number desc
limit 100$drill$,
    "drill_config" = '{"kind":"issue_type","params":["week","bucket"],"xParam":"week","seriesParam":"bucket"}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_type_distribution';

UPDATE "dashboard_panels"
SET
    "drill_query_sql" = $drill$with scoped as (
  select
    i."id" as issue_row_id,
    i."issue_number" as issue_number,
    i."title" as title,
    i."type" as type,
    i."priority" as priority,
    i."size" as size,
    st."opened_at" as opened_at,
    coalesce(st."drop_at", st."done_at") as resolved_at,
    extract(epoch from (
      coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
    ))::int as duration_seconds,
    coalesce(st."triage_task_turns", 0)::int as triage_turns,
    coalesce(st."plan_task_turns", 0)::int as plan_turns,
    coalesce(st."build_task_turns", 0)::int as build_turns,
    coalesce(st."review_task_turns", 0)::int as review_turns,
    (
      coalesce(st."triage_task_turns", 0)
      + coalesce(st."plan_task_turns", 0)
      + coalesce(st."build_task_turns", 0)
      + coalesce(st."review_task_turns", 0)
    )::int as task_turns,
    case
      when extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
      )) > 0 then round((
        coalesce(st."triage_task_seconds", 0)
        + coalesce(st."plan_task_seconds", 0)
        + coalesce(st."build_task_seconds", 0)
        + coalesce(st."review_task_seconds", 0)
      ) * 100.0 / extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
      )))::int
      else 0
    end as agent_execution_pct,
    case
      when (
        coalesce(st."triage_task_turns", 0)
        + coalesce(st."plan_task_turns", 0)
        + coalesce(st."build_task_turns", 0)
        + coalesce(st."review_task_turns", 0)
      ) = 0 then '0'
      when (
        coalesce(st."triage_task_turns", 0)
        + coalesce(st."plan_task_turns", 0)
        + coalesce(st."build_task_turns", 0)
        + coalesce(st."review_task_turns", 0)
      ) <= 3 then '1-3'
      when (
        coalesce(st."triage_task_turns", 0)
        + coalesce(st."plan_task_turns", 0)
        + coalesce(st."build_task_turns", 0)
        + coalesce(st."review_task_turns", 0)
      ) <= 6 then '4-6'
      when (
        coalesce(st."triage_task_turns", 0)
        + coalesce(st."plan_task_turns", 0)
        + coalesce(st."build_task_turns", 0)
        + coalesce(st."review_task_turns", 0)
      ) <= 10 then '7-10'
      when (
        coalesce(st."triage_task_turns", 0)
        + coalesce(st."plan_task_turns", 0)
        + coalesce(st."build_task_turns", 0)
        + coalesce(st."review_task_turns", 0)
      ) <= 20 then '11-20'
      else '20+'
    end as turns_bucket
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
), bucket_rows as (
  select *
  from scoped
  where turns_bucket = :bucket
), summary as (
  select
    count(*)::int as total_count,
    (select count(*)::int from scoped) as weekly_count,
    (percentile_cont(0.5) within group (order by task_turns))::numeric as task_turns_p50,
    (select percentile_cont(0.8) within group (order by task_turns) from scoped)::numeric as task_turns_p80
  from bucket_rows
)
select
  b.issue_row_id,
  b.issue_number,
  b.title,
  b.type,
  b.priority,
  b.size,
  b.opened_at,
  b.resolved_at,
  b.duration_seconds,
  b.triage_turns,
  b.plan_turns,
  b.build_turns,
  b.review_turns,
  b.task_turns,
  b.agent_execution_pct,
  s.total_count,
  s.weekly_count,
  s.task_turns_p50,
  s.task_turns_p80
from bucket_rows b
cross join summary s
order by b.task_turns desc, b.duration_seconds desc, b.issue_number desc
limit 100$drill$,
    "drill_config" = '{"kind":"issue_turns","params":["week","bucket"],"xParam":"week","seriesParam":"bucket"}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_task_turns_distribution';
