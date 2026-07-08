-- 将阶段分位折线替换为端到端完成耗时 P80.
DROP VIEW IF EXISTS "weekly_issue_metrics";
CREATE VIEW "weekly_issue_metrics" AS
WITH base AS (
    SELECT
        i."git_server_id",
        i."repository_id",
        (date_trunc('week', st."opened_at"))::date AS week,
        CASE
            WHEN st."drop_at" IS NOT NULL THEN 'drop'
            WHEN st."done_at" IS NULL THEN 'open'
            WHEN st."done_at" <= st."opened_at" + interval '1 day' THEN '1d'
            WHEN st."done_at" <= st."opened_at" + interval '2 days' THEN '2d'
            WHEN st."done_at" <= st."opened_at" + interval '3 days' THEN '3d'
            WHEN st."done_at" <= st."opened_at" + interval '4 days' THEN '4d'
            WHEN st."done_at" <= st."opened_at" + interval '5 days' THEN '5d'
            WHEN st."done_at" <= st."opened_at" + interval '6 days' THEN '6d'
            WHEN st."done_at" <= st."opened_at" + interval '7 days' THEN '7d'
            ELSE '7d+'
        END AS done_bucket,
        COALESCE(w."weight", 1) AS weight,
        extract(epoch FROM (
            CASE
                WHEN st."drop_at" IS NOT NULL THEN st."drop_at"
                WHEN st."done_at" IS NOT NULL THEN st."done_at"
            END - st."opened_at"
        )) / 86400.0 AS duration_days
    FROM "issue_stats" st
    JOIN "issues" i ON i."id" = st."id"
    LEFT JOIN "metric_size_weights" w ON w."size" = i."size"
),
weekly AS (
    SELECT
        "git_server_id",
        "repository_id",
        week,
        percentile_cont(0.8) WITHIN GROUP (ORDER BY duration_days)
            FILTER (WHERE duration_days IS NOT NULL) AS duration_p80_days
    FROM base
    GROUP BY "git_server_id", "repository_id", week
)
SELECT
    b."git_server_id",
    b."repository_id",
    b.week,
    b.done_bucket,
    (count(*))::int AS issue_count,
    (sum(b.weight))::numeric AS weighted_count,
    w.duration_p80_days
FROM base b
JOIN weekly w
    ON w."git_server_id" = b."git_server_id"
    AND w."repository_id" = b."repository_id"
    AND w.week = b.week
GROUP BY b."git_server_id", b."repository_id", b.week, b.done_bucket, w.duration_p80_days;

UPDATE "dashboard_panels"
SET "query_sql" = $panel$select
  week,
  done_bucket,
  issue_count,
  weighted_count,
  duration_p80_days
from weekly_issue_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and week >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
order by week, done_bucket$panel$,
    "y2_fields" = '["duration_p80_days"]',
    "visual_config" = '{"stackOrder": ["drop", "1d", "2d", "3d", "4d", "5d", "6d", "7d", "7d+", "open"], "y2Unit": "days", "fieldLabels": {"issue_count": "数量", "weighted_count": "加权", "duration_p80_days": "P80 耗时"}}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
