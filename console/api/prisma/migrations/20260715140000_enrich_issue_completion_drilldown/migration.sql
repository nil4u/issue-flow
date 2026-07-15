-- Enrich completion drilldown with bucket context and issue-level explanatory metrics.
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
    (
      coalesce(st."triage_task_turns", 0)
      + coalesce(st."plan_task_turns", 0)
      + coalesce(st."build_task_turns", 0)
      + coalesce(st."review_task_turns", 0)
    )::int as task_turns,
    (
      coalesce(st."triage_task_seconds", 0)
      + coalesce(st."plan_task_seconds", 0)
      + coalesce(st."build_task_seconds", 0)
      + coalesce(st."review_task_seconds", 0)
    )::int as agent_seconds,
    case
      when st."drop_at" is not null then concat('dr', 'op')
      when st."done_at" is null then 'open'
      when st."done_at" <= st."opened_at" + interval '1 day' then '1d'
      when st."done_at" <= st."opened_at" + interval '2 days' then '2d'
      when st."done_at" <= st."opened_at" + interval '3 days' then '3d'
      when st."done_at" <= st."opened_at" + interval '4 days' then '4d'
      when st."done_at" <= st."opened_at" + interval '5 days' then '5d'
      when st."done_at" <= st."opened_at" + interval '6 days' then '6d'
      when st."done_at" <= st."opened_at" + interval '7 days' then '7d'
      else '7d+'
    end as done_bucket
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
), bucket_rows as (
  select *
  from scoped
  where done_bucket = :bucket
), summary as (
  select
    count(*)::int as total_count,
    (select count(*)::int from scoped) as weekly_count,
    (percentile_cont(0.5) within group (order by duration_seconds))::int as duration_p50_seconds,
    max(duration_seconds)::int as duration_max_seconds
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
  b.task_turns,
  case
    when b.duration_seconds > 0 then round(b.agent_seconds * 100.0 / b.duration_seconds)::int
    else 0
  end as agent_execution_pct,
  s.total_count,
  s.weekly_count,
  s.duration_p50_seconds,
  s.duration_max_seconds
from bucket_rows b
cross join summary s
order by b.duration_seconds desc, b.issue_number desc
limit 100$drill$,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
