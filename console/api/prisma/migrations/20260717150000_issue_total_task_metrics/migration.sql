-- Issue 总量独立于 action 分桶，并补齐创建 Issue 的 Task action。
ALTER TABLE "issue_stats"
ADD COLUMN "create_task_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "total_task_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "create_task_turns" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "total_task_turns" INTEGER NOT NULL DEFAULT 0;

UPDATE "tasks" task
SET "action" = 'create',
    "updated_at" = CURRENT_TIMESTAMP
FROM "issues" issue
WHERE task."action" = ''
  AND issue."created_by_task_id" = task."task_id"
  AND issue."git_server_id" = task."git_server_id"
  AND issue."repository_id" = task."repository_id"
  AND issue."issue_number" = task."issue_number";

WITH task_metrics AS (
  SELECT
    issue."id",
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'create'), 0) AS create_ms,
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'triage'), 0) AS triage_ms,
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'plan'), 0) AS plan_ms,
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'build'), 0) AS build_ms,
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'review'), 0) AS review_ms,
    coalesce(sum(task."execution_ms"), 0) AS total_ms,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'create'), 0)::integer AS create_turns,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'triage'), 0)::integer AS triage_turns,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'plan'), 0)::integer AS plan_turns,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'build'), 0)::integer AS build_turns,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'review'), 0)::integer AS review_turns,
    coalesce(sum(task."turns"), 0)::integer AS total_turns
  FROM "issues" issue
  LEFT JOIN "tasks" task
    ON task."git_server_id" = issue."git_server_id"
    AND task."repository_id" = issue."repository_id"
    AND task."issue_number" = issue."issue_number"
  GROUP BY issue."id"
)
UPDATE "issue_stats" stats
SET "create_task_seconds" = round(task_metrics.create_ms / 1000.0)::integer,
    "triage_task_seconds" = round(task_metrics.triage_ms / 1000.0)::integer,
    "plan_task_seconds" = round(task_metrics.plan_ms / 1000.0)::integer,
    "build_task_seconds" = round(task_metrics.build_ms / 1000.0)::integer,
    "review_task_seconds" = round(task_metrics.review_ms / 1000.0)::integer,
    "total_task_seconds" = round(task_metrics.total_ms / 1000.0)::integer,
    "create_task_turns" = task_metrics.create_turns,
    "triage_task_turns" = task_metrics.triage_turns,
    "plan_task_turns" = task_metrics.plan_turns,
    "build_task_turns" = task_metrics.build_turns,
    "review_task_turns" = task_metrics.review_turns,
    "total_task_turns" = task_metrics.total_turns,
    "updated_at" = CURRENT_TIMESTAMP
FROM task_metrics
WHERE stats."id" = task_metrics."id";

UPDATE "dashboard_panels"
SET "query_sql" = $panel$with scoped as (
  select
    (date_trunc('week', coalesce(st."opened_at", i."opened_at")))::date as week,
    extract(epoch from (
      coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
      - least(
          coalesce(st."cycle_started_at", st."opened_at", i."opened_at"),
          coalesce(st."opened_at", i."opened_at")
        )
    ))::numeric as lifecycle_seconds,
    coalesce(st."total_task_seconds", 0)::numeric as agent_seconds
  from "issues" i
  left join "issue_stats" st on st."id" = i."id"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and coalesce(st."opened_at", i."opened_at") >= :from
    and coalesce(st."opened_at", i."opened_at") < :to
), weekly as (
  select
    week,
    sum(agent_seconds)::numeric as agent_seconds,
    sum(lifecycle_seconds)::numeric as lifecycle_seconds,
    greatest(sum(lifecycle_seconds) - sum(agent_seconds), 0)::numeric as wait_seconds
  from scoped
  where lifecycle_seconds > 0
  group by week
)
select
  week,
  'agent' as component,
  agent_seconds as seconds,
  case when lifecycle_seconds > 0 then agent_seconds * 100.0 / lifecycle_seconds else 0 end as task_share_pct
from weekly
where agent_seconds > 0
union all
select
  week,
  'wait' as component,
  wait_seconds as seconds,
  case when lifecycle_seconds > 0 then agent_seconds * 100.0 / lifecycle_seconds else 0 end as task_share_pct
from weekly
where wait_seconds > 0
order by week, component$panel$,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_task_time_share';

UPDATE "dashboard_panels"
SET "visual_config" = jsonb_set(
      "visual_config",
      '{stackOrder}',
      '["create", "triage", "plan", "build", "review"]'::jsonb
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_token_consumption_trend';

UPDATE "dashboard_panels"
SET "query_sql" = $panel$with bucketed as (
  select
    scored.git_server_id,
    scored.repository_id,
    scored.week,
    scored.total_task_turns,
    case
      when scored.total_task_turns = 0 then '0'
      when scored.total_task_turns <= 3 then '1-3'
      when scored.total_task_turns <= 6 then '4-6'
      when scored.total_task_turns <= 10 then '7-10'
      when scored.total_task_turns <= 20 then '11-20'
      else '20+'
    end as turns_bucket,
    scored.weight
  from (
    select
      i."git_server_id",
      i."repository_id",
      (date_trunc('week', st."opened_at"))::date as week,
      st."total_task_turns",
      coalesce(w."weight", 1) as weight
    from "issue_stats" st
    join "issues" i on i."id" = st."id"
    left join "metric_size_weights" w on w."size" = i."size"
    where i."git_server_id" = :git_server_id
      and i."repository_id" = :repository_id
      and st."opened_at" >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
  ) scored
)
select
  b.week,
  b.turns_bucket,
  count(*)::int as issue_count,
  sum(b.weight)::numeric as weighted_count,
  w.task_turns_p80
from bucketed b
join (
  select
    git_server_id,
    repository_id,
    week,
    percentile_cont(0.8) within group (order by total_task_turns) as task_turns_p80
  from bucketed
  group by git_server_id, repository_id, week
) w
  on w.git_server_id = b.git_server_id
  and w.repository_id = b.repository_id
  and w.week = b.week
group by b.week, b.turns_bucket, w.task_turns_p80
order by b.week, b.turns_bucket$panel$,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_task_turns_distribution';

UPDATE "dashboard_panels"
SET "drill_query_sql" = $drill$with scoped as (
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
    st."total_task_turns"::int as task_turns,
    st."total_task_seconds"::int as agent_seconds,
    extract(epoch from (
      coalesce(st."drop_at", st."done_at", now() at time zone 'utc')
      - least(coalesce(st."cycle_started_at", st."opened_at"), st."opened_at")
    ))::int as agent_lifecycle_seconds,
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
  select * from scoped where done_bucket = :bucket
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
    when b.agent_lifecycle_seconds > 0
      then round(b.agent_seconds * 100.0 / b.agent_lifecycle_seconds)::int
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

UPDATE "dashboard_panels"
SET "drill_query_sql" = $drill$with scoped as (
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
    st."total_task_turns"::int as task_turns,
    case
      when extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc')
        - least(coalesce(st."cycle_started_at", st."opened_at"), st."opened_at")
      )) > 0 then round(st."total_task_seconds" * 100.0 / extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc')
        - least(coalesce(st."cycle_started_at", st."opened_at"), st."opened_at")
      )))::int
      else 0
    end as agent_execution_pct,
    coalesce(w."weight", 1) as weight,
    case when i."type" = '' then '未分类' else 'type::' || i."type" end as issue_type,
    st."done_at" is not null as completed
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  left join "metric_size_weights" w on w."size" = i."size"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
), bucket_rows as (
  select * from scoped where issue_type = :bucket
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
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_type_distribution';

UPDATE "dashboard_panels"
SET "drill_query_sql" = $drill$with scoped as (
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
    st."create_task_turns"::int as create_turns,
    st."triage_task_turns"::int as triage_turns,
    st."plan_task_turns"::int as plan_turns,
    st."build_task_turns"::int as build_turns,
    st."review_task_turns"::int as review_turns,
    greatest(
      st."total_task_turns"
      - st."create_task_turns"
      - st."triage_task_turns"
      - st."plan_task_turns"
      - st."build_task_turns"
      - st."review_task_turns",
      0
    )::int as other_turns,
    st."total_task_turns"::int as task_turns,
    case
      when extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc')
        - least(coalesce(st."cycle_started_at", st."opened_at"), st."opened_at")
      )) > 0 then round(st."total_task_seconds" * 100.0 / extract(epoch from (
        coalesce(st."drop_at", st."done_at", now() at time zone 'utc')
        - least(coalesce(st."cycle_started_at", st."opened_at"), st."opened_at")
      )))::int
      else 0
    end as agent_execution_pct,
    case
      when st."total_task_turns" = 0 then '0'
      when st."total_task_turns" <= 3 then '1-3'
      when st."total_task_turns" <= 6 then '4-6'
      when st."total_task_turns" <= 10 then '7-10'
      when st."total_task_turns" <= 20 then '11-20'
      else '20+'
    end as turns_bucket
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
), bucket_rows as (
  select * from scoped where turns_bucket = :bucket
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
  b.create_turns,
  b.triage_turns,
  b.plan_turns,
  b.build_turns,
  b.review_turns,
  b.other_turns,
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
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_task_turns_distribution';
