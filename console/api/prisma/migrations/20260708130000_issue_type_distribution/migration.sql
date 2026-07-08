-- 新增 repo overview 的 issue 类型分布面板.
INSERT INTO "dashboard_panels" (
    "id", "dashboard_id", "title", "query_sql", "chart_type",
    "x_field", "y_fields", "y2_fields", "series_field", "stack_field",
    "visual_config", "position", "created_at", "updated_at"
) VALUES
    (
        'dashpanel_issue_type_distribution',
        'dashboard_agent_first_overview',
        'Issue 类型分布',
        $panel$with typed as (
  select
    (date_trunc('week', i."opened_at"))::date as week,
    case
      when i."type" = '' then '未分类'
      else 'type::' || i."type"
    end as issue_type,
    coalesce(w."weight", 1) as weight
  from issues i
  left join metric_size_weights w on w."size" = i."size"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and i."opened_at" >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
)
select
  week,
  issue_type,
  count(*)::int as issue_count,
  sum(weight)::numeric as weighted_count
from typed
group by week, issue_type
order by week, issue_type$panel$,
        'stacked_bar',
        'week',
        '["issue_count", "weighted_count"]',
        NULL,
        '',
        'issue_type',
        '{"stackOrder": ["type::feature", "type::bug", "type::debt", "type::ops", "未分类"], "fieldLabels": {"issue_count": "数量", "weighted_count": "加权"}}',
        '{"x": 0, "y": 10, "w": 12, "h": 10}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("id") DO NOTHING;

UPDATE "dashboard_panels"
SET "position" = '{"x": 0, "y": 20, "w": 12, "h": 8}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_task_execution_trend';
