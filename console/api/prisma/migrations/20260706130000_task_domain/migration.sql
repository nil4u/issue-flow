-- Task domain: tasks / task_events facts, task_execution_metrics view,
-- issue_flow_metrics task_seconds from tasks, Task Execution Trend panel.

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL DEFAULT '',
    "repository_id" TEXT NOT NULL DEFAULT '',
    "repository_full_name" TEXT NOT NULL DEFAULT '',
    "issue_id" TEXT NOT NULL DEFAULT '',
    "issue_number" INTEGER NOT NULL DEFAULT 0,
    "issue_span_row_id" TEXT NOT NULL DEFAULT '',
    "task_id" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT '',
    "agent" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "turns" INTEGER NOT NULL DEFAULT 0,
    "model_usage" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT NOT NULL DEFAULT '',
    "queued_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL DEFAULT '',
    "repository_id" TEXT NOT NULL DEFAULT '',
    "repository_full_name" TEXT NOT NULL DEFAULT '',
    "issue_id" TEXT NOT NULL DEFAULT '',
    "issue_number" INTEGER NOT NULL DEFAULT 0,
    "task_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL DEFAULT '',
    "event_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentrix_forward_cursors" (
    "machine_id" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agentrix_forward_cursors_pkey" PRIMARY KEY ("machine_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tasks_task_id_key" ON "tasks"("task_id");

-- CreateIndex
CREATE INDEX "tasks_git_server_id_repository_id_issue_id_idx" ON "tasks"("git_server_id", "repository_id", "issue_id");

-- CreateIndex
CREATE INDEX "tasks_action_started_at_idx" ON "tasks"("action", "started_at");

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "task_events_event_id_key" ON "task_events"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_events_task_id_sequence_key" ON "task_events"("task_id", "sequence");

-- CreateIndex
CREATE INDEX "task_events_git_server_id_repository_id_issue_id_idx" ON "task_events"("git_server_id", "repository_id", "issue_id");

-- CreateView: task_execution_metrics
CREATE VIEW "task_execution_metrics" AS
WITH task_usage AS (
    SELECT
        t."id" AS task_row_id,
        (COALESCE(sum((mu.value ->> 'inputTokens')::bigint), 0))::int AS input_tokens,
        (COALESCE(sum((mu.value ->> 'outputTokens')::bigint), 0))::int AS output_tokens,
        (COALESCE(sum(
            COALESCE((mu.value ->> 'inputTokens')::bigint, 0)
            + COALESCE((mu.value ->> 'outputTokens')::bigint, 0)
            + COALESCE((mu.value ->> 'cacheReadInputTokens')::bigint, 0)
            + COALESCE((mu.value ->> 'cacheCreationInputTokens')::bigint, 0)
        ), 0))::int AS total_tokens
    FROM "tasks" t
    LEFT JOIN LATERAL jsonb_each(COALESCE(t."model_usage", '{}'::jsonb)) mu ON true
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

-- RecreateView: issue_flow_metrics (task domain implemented: task_seconds from tasks via issue_span_row_id)
DROP VIEW IF EXISTS "issue_flow_metrics";
CREATE VIEW "issue_flow_metrics" AS
WITH span_task_seconds AS (
    SELECT
        t."issue_span_row_id",
        (sum(extract(epoch FROM (COALESCE(t."finished_at", now() AT TIME ZONE 'utc') - t."started_at"))))::int AS task_seconds
    FROM "tasks" t
    WHERE t."issue_span_row_id" <> '' AND t."started_at" IS NOT NULL
    GROUP BY t."issue_span_row_id"
)
SELECT
    i."id" AS issue_row_id,
    s."git_server_id",
    s."repository_id",
    s."flow",
    (extract(epoch FROM (COALESCE(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int AS span_seconds,
    COALESCE(st.task_seconds, 0) AS task_seconds,
    greatest(
        (extract(epoch FROM (COALESCE(s."exited_at", now() AT TIME ZONE 'utc') - s."entered_at")))::int
        - COALESCE(st.task_seconds, 0),
        0
    ) AS wait_seconds,
    s."entered_at" AS started_at,
    s."exited_at" AS ended_at
FROM "issue_spans" s
JOIN "issues" i
    ON i."git_server_id" = s."git_server_id"
    AND i."repository_id" = s."repository_id"
    AND i."issue_id" = s."issue_id"
LEFT JOIN span_task_seconds st ON st."issue_span_row_id" = s."id";

-- Seed: Task Execution Trend panel (avg_turns kept in SQL for table drill-down; encoding renders p75 per action)
INSERT INTO "dashboard_panels" (
    "id", "dashboard_id", "title", "query_sql", "chart_type",
    "x_field", "y_fields", "y2_fields", "series_field", "stack_field",
    "visual_config", "position", "created_at", "updated_at"
) VALUES
    (
        'dashpanel_task_execution_trend',
        'dashboard_agent_first_overview',
        'Task Execution Trend',
        $panel$select
  (date_trunc('week', started_at))::date as week,
  action,
  percentile_cont(0.75) within group (order by task_seconds) as task_p75_seconds,
  avg(turns) as avg_turns
from task_execution_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and started_at >= :from
  and started_at < :to
group by week, action
order by week, action$panel$,
        'line',
        'week',
        '["task_p75_seconds"]',
        NULL,
        'action',
        '',
        '{"yUnit": "seconds"}',
        '{"x": 0, "y": 10, "w": 12, "h": 8}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("id") DO NOTHING;
