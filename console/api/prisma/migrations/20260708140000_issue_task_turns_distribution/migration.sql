-- 新增 repo overview 的 issue task turns 分布面板.
INSERT INTO "dashboard_panels" (
    "id", "dashboard_id", "title", "query_sql", "chart_type",
    "x_field", "y_fields", "y2_fields", "series_field", "stack_field",
    "visual_config", "position", "created_at", "updated_at"
) VALUES
    (
        'dashpanel_issue_task_turns_distribution',
        'dashboard_agent_first_overview',
        'Issue Task Turns 分布',
        $panel$with bucketed as (
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
      (
        st."triage_task_turns"
        + st."plan_task_turns"
        + st."build_task_turns"
        + st."review_task_turns"
      ) as total_task_turns,
      coalesce(w."weight", 1) as weight
    from issue_stats st
    join issues i on i."id" = st."id"
    left join metric_size_weights w on w."size" = i."size"
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
        'stacked_bar_with_lines',
        'week',
        '["issue_count", "weighted_count"]',
        '["task_turns_p80"]',
        '',
        'turns_bucket',
        '{"stackOrder": ["0", "1-3", "4-6", "7-10", "11-20", "20+"], "fieldLabels": {"issue_count": "数量", "weighted_count": "加权", "task_turns_p80": "P80 轮次"}}',
        '{"x": 0, "y": 20, "w": 12, "h": 10}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("id") DO NOTHING;

UPDATE "dashboard_panels"
SET "position" = '{"x": 0, "y": 30, "w": 12, "h": 8}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_task_execution_trend';
