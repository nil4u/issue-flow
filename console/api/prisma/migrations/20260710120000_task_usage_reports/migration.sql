-- Normalize per-run model usage into idempotent event/model rows.

DROP VIEW IF EXISTS "task_execution_metrics";

CREATE TABLE "task_usage_reports" (
    "task_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_read_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "cache_creation_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "web_search_requests" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_usage_reports_pkey" PRIMARY KEY ("event_id", "model")
);

CREATE INDEX "task_usage_reports_task_id_idx" ON "task_usage_reports"("task_id");
CREATE INDEX "task_usage_reports_task_id_model_idx" ON "task_usage_reports"("task_id", "model");

ALTER TABLE "tasks" DROP COLUMN "model_usage";

CREATE VIEW "task_execution_metrics" AS
WITH task_usage AS (
    SELECT
        t."id" AS task_row_id,
        COALESCE(sum(u."input_tokens"), 0)::bigint AS input_tokens,
        COALESCE(sum(u."output_tokens"), 0)::bigint AS output_tokens,
        COALESCE(sum(
            u."input_tokens"
            + u."output_tokens"
            + u."cache_read_input_tokens"
            + u."cache_creation_input_tokens"
        ), 0)::bigint AS total_tokens
    FROM "tasks" t
    LEFT JOIN "task_usage_reports" u ON u."task_id" = t."task_id"
    GROUP BY t."id"
)
SELECT
    i."id" AS issue_row_id,
    t."id" AS task_row_id,
    t."git_server_id",
    t."repository_id",
    t."action",
    t."agent",
    t."model",
    t."turns",
    (extract(epoch FROM (COALESCE(t."finished_at", now() AT TIME ZONE 'utc') - t."started_at")))::int AS task_seconds,
    u.input_tokens,
    u.output_tokens,
    u.total_tokens,
    t."started_at",
    t."finished_at"
FROM "tasks" t
LEFT JOIN "issues" i
    ON i."git_server_id" = t."git_server_id"
    AND i."repository_id" = t."repository_id"
    AND i."issue_id" = t."issue_id"
LEFT JOIN task_usage u ON u.task_row_id = t."id"
WHERE t."started_at" IS NOT NULL;

UPDATE "dashboard_panels"
SET
    "query_sql" = $panel$with scoped as (
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
    sum(total_tokens)::bigint as total_tokens
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
    "chart_type" = 'stacked_bar_with_lines',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_token_consumption_trend';
