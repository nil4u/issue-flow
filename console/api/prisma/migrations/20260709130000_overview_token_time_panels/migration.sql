-- 新增 repo overview 的 token 消耗趋势与任务耗时占比面板.
INSERT INTO "dashboard_panels" (
    "id", "dashboard_id", "title", "query_sql", "chart_type",
    "x_field", "y_fields", "y2_fields", "series_field", "stack_field",
    "visual_config", "position", "created_at", "updated_at"
) VALUES
    (
        'dashpanel_token_consumption_trend',
        'dashboard_agent_first_overview',
        'Token Consumption Trend',
        $panel$with scoped as (
  select
    (date_trunc('week', started_at))::date as week,
    action,
    total_tokens
  from task_execution_metrics
  where git_server_id = :git_server_id
    and repository_id = :repository_id
    and started_at >= :from
    and started_at < :to
    and total_tokens > 0
)
select
  wa.week,
  wa.action,
  wa.total_tokens,
  wp.task_token_p80
from (
  select
    week,
    action,
    sum(total_tokens)::int as total_tokens
  from scoped
  group by week, action
) wa
join (
  select
    week,
    percentile_cont(0.8) within group (order by total_tokens) as task_token_p80
  from scoped
  group by week
) wp on wp.week = wa.week
order by wa.week, wa.action$panel$,
        'stacked_area_with_lines',
        'week',
        '["total_tokens"]',
        '["task_token_p80"]',
        '',
        'action',
        '{"stackOrder": ["triage", "plan", "build", "review"], "yUnit": "tokens", "y2Unit": "tokens", "fieldLabels": {"total_tokens": "Token 总量", "task_token_p80": "P80 / task"}}',
        '{"x": 0, "y": 30, "w": 12, "h": 10}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        'dashpanel_task_time_share',
        'dashboard_agent_first_overview',
        'Task Time Share',
        $panel$with weekly as (
  select
    (date_trunc('week', started_at))::date as week,
    sum(task_seconds)::numeric as task_seconds,
    sum(wait_seconds)::numeric as wait_seconds
  from issue_flow_metrics
  where git_server_id = :git_server_id
    and repository_id = :repository_id
    and started_at >= :from
    and started_at < :to
  group by week
)
select
  week,
  'agent' as component,
  task_seconds as seconds,
  case when task_seconds + wait_seconds > 0 then (task_seconds * 100.0 / (task_seconds + wait_seconds)) else 0 end as task_share_pct
from weekly
where task_seconds > 0
union all
select
  week,
  'wait' as component,
  wait_seconds as seconds,
  case when task_seconds + wait_seconds > 0 then (task_seconds * 100.0 / (task_seconds + wait_seconds)) else 0 end as task_share_pct
from weekly
where wait_seconds > 0
order by week, component$panel$,
        'percent_stacked_bar_with_lines',
        'week',
        '["seconds"]',
        '["task_share_pct"]',
        '',
        'component',
        '{"stackOrder": ["agent", "wait"], "yUnit": "seconds", "y2Unit": "percent", "fieldLabels": {"seconds": "整体耗时", "task_share_pct": "Agent 执行占比"}}',
        '{"x": 0, "y": 40, "w": 12, "h": 10}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("id") DO NOTHING;
