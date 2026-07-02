-- Repo-scoped metric views: expose git_server_id/repository_id and filter seeded panels by repo

-- RecreateView: weekly_issue_metrics
DROP VIEW IF EXISTS "weekly_issue_metrics";
CREATE VIEW "weekly_issue_metrics" AS
WITH base AS (
    SELECT
        i."git_server_id",
        i."repository_id",
        (date_trunc('week', st."opened_at"))::date AS week,
        CASE
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

-- RecreateView: issue_flow_metrics (task metrics deferred: task_seconds fixed at 0, wait_seconds equals span_seconds)
DROP VIEW IF EXISTS "issue_flow_metrics";
CREATE VIEW "issue_flow_metrics" AS
SELECT
    i."id" AS issue_row_id,
    s."git_server_id",
    s."repository_id",
    s."flow",
    (extract(epoch FROM (COALESCE(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int AS span_seconds,
    0 AS task_seconds,
    (extract(epoch FROM (COALESCE(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int AS wait_seconds,
    s."entered_at" AS started_at,
    s."exited_at" AS ended_at
FROM "issue_spans" s
JOIN "issues" i
    ON i."git_server_id" = s."git_server_id"
    AND i."repository_id" = s."repository_id"
    AND i."issue_id" = s."issue_id";

-- RecreateView: wip_aging_metrics
DROP VIEW IF EXISTS "wip_aging_metrics";
CREATE VIEW "wip_aging_metrics" AS
SELECT
    i."id" AS issue_row_id,
    s."git_server_id",
    s."repository_id",
    s."flow",
    s."entered_at",
    (extract(epoch FROM (now() AT TIME ZONE 'utc' - s."entered_at")))::int AS aging_seconds,
    s."repository_full_name",
    s."issue_number",
    i."title",
    i."priority",
    i."size"
FROM "issue_spans" s
JOIN "issues" i
    ON i."git_server_id" = s."git_server_id"
    AND i."repository_id" = s."repository_id"
    AND i."issue_id" = s."issue_id"
WHERE s."exited_at" IS NULL;

-- Update seeded panels: scope queries to the requesting repository
UPDATE "dashboard_panels"
SET "query_sql" = $panel$select
  week,
  done_bucket,
  issue_count,
  weighted_count,
  triage_p50_days,
  build_p75_days,
  approve_p85_days
from weekly_issue_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and week >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
order by week, done_bucket$panel$,
    "visual_config" = '{"stackOrder": ["1d", "2d", "3d", "4d", "5d", "6d", "7d", "7d+", "open"], "y2Unit": "days"}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';

UPDATE "dashboard_panels"
SET "query_sql" = $panel$select
  repository_full_name,
  issue_number,
  title,
  flow,
  priority,
  size,
  aging_seconds
from wip_aging_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
order by aging_seconds desc
limit 50$panel$,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_wip_aging';

UPDATE "dashboard_panels"
SET "query_sql" = $panel$select
  flow,
  percentile_cont(0.85) within group (order by wait_seconds) as wait_p85_seconds,
  sum(wait_seconds) as wait_total_seconds
from issue_flow_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and started_at >= :from
  and started_at < :to
group by flow
order by wait_total_seconds desc$panel$,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_flow_wait_ranking';
