-- Align Task Time Share with the issue lifecycle metric used by issue cards.
UPDATE "dashboard_panels"
SET
    "query_sql" = $panel$with scoped as (
  select
    (date_trunc('week', coalesce(st."opened_at", i."opened_at")))::date as week,
    extract(epoch from (
      coalesce(st."done_at", st."drop_at", now() at time zone 'utc')
      - coalesce(st."opened_at", i."opened_at")
    ))::numeric as lifecycle_seconds,
    (
      coalesce(st."triage_task_seconds", 0)
      + coalesce(st."plan_task_seconds", 0)
      + coalesce(st."build_task_seconds", 0)
      + coalesce(st."review_task_seconds", 0)
    )::numeric as agent_seconds
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
  case when lifecycle_seconds > 0
    then agent_seconds * 100.0 / lifecycle_seconds
    else 0
  end as task_share_pct
from weekly
where agent_seconds > 0
union all
select
  week,
  'wait' as component,
  wait_seconds as seconds,
  case when lifecycle_seconds > 0
    then agent_seconds * 100.0 / lifecycle_seconds
    else 0
  end as task_share_pct
from weekly
where wait_seconds > 0
order by week, component$panel$,
    "visual_config" = '{"stackOrder": ["agent", "wait"], "yUnit": "seconds", "y2Unit": "percent", "fieldLabels": {"seconds": "整体耗时", "task_share_pct": "Agent execution 占比"}}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_task_time_share';
