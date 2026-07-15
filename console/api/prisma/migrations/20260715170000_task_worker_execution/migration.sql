-- Persist Agentrix worker execution time separately from Task wall-clock duration.
ALTER TABLE "tasks"
ADD COLUMN "execution_ms" INTEGER NOT NULL DEFAULT 0;

-- Task execution metrics use Agentrix's accumulated worker-ready durations.
DROP VIEW IF EXISTS "task_execution_metrics";

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
    round(t."execution_ms" / 1000.0)::int AS task_seconds,
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
