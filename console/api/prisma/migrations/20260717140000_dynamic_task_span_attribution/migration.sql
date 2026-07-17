-- A task's span is derived from repository-scoped issue identity and time.
-- Keeping the derived span row id on tasks makes ingestion order observable.
DROP VIEW IF EXISTS "issue_flow_metrics";

ALTER TABLE "tasks"
DROP COLUMN "issue_span_row_id";

CREATE INDEX "issue_spans_git_server_id_repository_id_issue_number_entered_at_idx"
ON "issue_spans"("git_server_id", "repository_id", "issue_number", "entered_at");

CREATE VIEW "issue_flow_metrics" AS
WITH task_span_seconds AS (
    SELECT
        assigned."issue_span_row_id",
        round(sum(t."execution_ms")::numeric / 1000.0)::int AS task_seconds
    FROM "tasks" t
    JOIN LATERAL (
        SELECT s."id" AS "issue_span_row_id"
        FROM "issue_spans" s
        WHERE s."git_server_id" = t."git_server_id"
          AND s."repository_id" = t."repository_id"
          AND s."issue_number" = t."issue_number"
          AND s."entered_at" <= t."started_at"
          AND (s."exited_at" IS NULL OR s."exited_at" >= t."started_at")
        ORDER BY
            CASE WHEN s."flow" = CASE t."action"
                WHEN 'triage' THEN 'triage'
                WHEN 'plan' THEN 'plan'
                WHEN 'build' THEN 'build'
                WHEN 'review' THEN 'approve'
                ELSE ''
            END THEN 0 ELSE 1 END,
            s."entered_at" DESC,
            s."id" DESC
        LIMIT 1
    ) assigned ON true
    WHERE t."started_at" IS NOT NULL
    GROUP BY assigned."issue_span_row_id"
)
SELECT
    i."id" AS issue_row_id,
    s."git_server_id",
    s."repository_id",
    s."flow",
    (extract(epoch FROM (coalesce(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int AS span_seconds,
    coalesce(st.task_seconds, 0) AS task_seconds,
    greatest(
        (extract(epoch FROM (coalesce(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int
        - coalesce(st.task_seconds, 0),
        0
    ) AS wait_seconds,
    s."entered_at" AS started_at,
    s."exited_at" AS ended_at
FROM "issue_spans" s
JOIN "issues" i
    ON i."git_server_id" = s."git_server_id"
    AND i."repository_id" = s."repository_id"
    AND i."issue_id" = s."issue_id"
LEFT JOIN task_span_seconds st ON st."issue_span_row_id" = s."id";
