-- Dropped issues are part of started work, but they should not inflate open.
-- Keep them visible as a first-class stacked bucket.
CREATE OR REPLACE VIEW "weekly_issue_metrics" AS
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
        st."triage_span_seconds",
        st."build_span_seconds",
        st."approve_span_seconds"
    FROM "issue_stats" st
    JOIN "issues" i ON i."id" = st."id"
    LEFT JOIN "metric_size_weights" w ON w."size" = i."size"
),
weekly AS (
    SELECT
        "git_server_id",
        "repository_id",
        week,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "triage_span_seconds" / 86400.0) AS triage_p50_days,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY "build_span_seconds" / 86400.0) AS build_p75_days,
        percentile_cont(0.85) WITHIN GROUP (ORDER BY "approve_span_seconds" / 86400.0) AS approve_p85_days
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
    w.triage_p50_days,
    w.build_p75_days,
    w.approve_p85_days
FROM base b
JOIN weekly w
    ON w."git_server_id" = b."git_server_id"
    AND w."repository_id" = b."repository_id"
    AND w.week = b.week
GROUP BY b."git_server_id", b."repository_id", b.week, b.done_bucket, w.triage_p50_days, w.build_p75_days, w.approve_p85_days;

UPDATE "dashboard_panels"
SET "visual_config" = '{"stackOrder": ["drop", "1d", "2d", "3d", "4d", "5d", "6d", "7d", "7d+", "open"], "y2Unit": "days", "fieldLabels": {"issue_count": "数量", "weighted_count": "加权"}}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
