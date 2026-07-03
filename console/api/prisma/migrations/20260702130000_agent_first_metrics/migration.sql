-- CreateTable
CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "git_server_id" TEXT NOT NULL,
    "repository_id" TEXT NOT NULL,
    "repository_full_name" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL DEFAULT '',
    "issue_number" INTEGER NOT NULL DEFAULT 0,
    "opened_by_task_id" TEXT NOT NULL DEFAULT '',
    "pull_request_id" TEXT NOT NULL,
    "pr_number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'open',
    "html_url" TEXT NOT NULL DEFAULT '',
    "opened_at" TIMESTAMP(3) NOT NULL,
    "merged_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_stats" (
    "id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "cycle_started_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "drop_at" TIMESTAMP(3),
    "triage_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "plan_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "build_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "clarify_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "approve_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "suspend_span_seconds" INTEGER NOT NULL DEFAULT 0,
    "triage_task_seconds" INTEGER NOT NULL DEFAULT 0,
    "plan_task_seconds" INTEGER NOT NULL DEFAULT 0,
    "build_task_seconds" INTEGER NOT NULL DEFAULT 0,
    "review_task_seconds" INTEGER NOT NULL DEFAULT 0,
    "triage_task_turns" INTEGER NOT NULL DEFAULT 0,
    "plan_task_turns" INTEGER NOT NULL DEFAULT 0,
    "build_task_turns" INTEGER NOT NULL DEFAULT 0,
    "review_task_turns" INTEGER NOT NULL DEFAULT 0,
    "pull_request_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_size_weights" (
    "size" TEXT NOT NULL,
    "weight" DECIMAL(8,2) NOT NULL,

    CONSTRAINT "metric_size_weights_pkey" PRIMARY KEY ("size")
);

-- CreateTable
CREATE TABLE "dashboards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_variables" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "default_value" JSONB,
    "query_sql" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dashboard_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dashboard_panels" (
    "id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "query_sql" TEXT NOT NULL,
    "chart_type" TEXT NOT NULL,
    "x_field" TEXT NOT NULL DEFAULT '',
    "y_fields" JSONB,
    "y2_fields" JSONB,
    "series_field" TEXT NOT NULL DEFAULT '',
    "stack_field" TEXT NOT NULL DEFAULT '',
    "visual_config" JSONB NOT NULL,
    "position" JSONB NOT NULL,
    "refresh_interval" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_panels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pull_requests_git_server_id_repository_id_issue_id_idx" ON "pull_requests"("git_server_id", "repository_id", "issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_git_server_id_repository_id_pull_request_id_key" ON "pull_requests"("git_server_id", "repository_id", "pull_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_git_server_id_repository_id_pr_number_key" ON "pull_requests"("git_server_id", "repository_id", "pr_number");

-- CreateIndex
CREATE INDEX "issue_stats_opened_at_idx" ON "issue_stats"("opened_at");

-- CreateIndex
CREATE INDEX "issue_stats_done_at_idx" ON "issue_stats"("done_at");

-- CreateIndex
CREATE UNIQUE INDEX "dashboards_slug_key" ON "dashboards"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "dashboard_variables_dashboard_id_name_key" ON "dashboard_variables"("dashboard_id", "name");

-- CreateIndex
CREATE INDEX "dashboard_panels_dashboard_id_idx" ON "dashboard_panels"("dashboard_id");

-- AddForeignKey
ALTER TABLE "dashboard_variables" ADD CONSTRAINT "dashboard_variables_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dashboard_panels" ADD CONSTRAINT "dashboard_panels_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateView: weekly_issue_metrics
CREATE VIEW "weekly_issue_metrics" AS
WITH base AS (
    SELECT
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
        week,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "triage_span_seconds" / 86400.0) AS triage_p50_days,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY "build_span_seconds" / 86400.0) AS build_p75_days,
        percentile_cont(0.85) WITHIN GROUP (ORDER BY "approve_span_seconds" / 86400.0) AS approve_p85_days
    FROM base
    GROUP BY week
)
SELECT
    b.week,
    b.done_bucket,
    (count(*))::int AS issue_count,
    (sum(b.weight))::numeric AS weighted_count,
    w.triage_p50_days,
    w.build_p75_days,
    w.approve_p85_days
FROM base b
JOIN weekly w ON w.week = b.week
GROUP BY b.week, b.done_bucket, w.triage_p50_days, w.build_p75_days, w.approve_p85_days;

-- CreateView: issue_flow_metrics (task metrics deferred: task_seconds fixed at 0, wait_seconds equals span_seconds)
CREATE VIEW "issue_flow_metrics" AS
SELECT
    i."id" AS issue_row_id,
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

-- CreateView: wip_aging_metrics
CREATE VIEW "wip_aging_metrics" AS
SELECT
    i."id" AS issue_row_id,
    s."git_server_id",
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

-- Seed: metric_size_weights
INSERT INTO "metric_size_weights" ("size", "weight") VALUES
    ('XS', 0.5),
    ('S', 1),
    ('M', 2),
    ('L', 3),
    ('XL', 5)
ON CONFLICT ("size") DO NOTHING;

-- Backfill: issue_stats from existing issues and closed issue_spans
INSERT INTO "issue_stats" (
    "id", "opened_at", "closed_at", "done_at", "drop_at",
    "triage_span_seconds", "plan_span_seconds", "build_span_seconds",
    "clarify_span_seconds", "approve_span_seconds", "suspend_span_seconds",
    "pull_request_count", "updated_at"
)
SELECT
    i."id",
    i."opened_at",
    i."closed_at",
    CASE WHEN i."status" = 'done' THEN i."closed_at" END,
    CASE WHEN i."status" = 'drop' THEN i."closed_at" END,
    COALESCE(s.triage_seconds, 0),
    COALESCE(s.plan_seconds, 0),
    COALESCE(s.build_seconds, 0),
    COALESCE(s.clarify_seconds, 0),
    COALESCE(s.approve_seconds, 0),
    COALESCE(s.suspend_seconds, 0),
    0,
    CURRENT_TIMESTAMP
FROM "issues" i
LEFT JOIN (
    SELECT
        "git_server_id",
        "repository_id",
        "issue_id",
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'triage'), 0))::int AS triage_seconds,
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'plan'), 0))::int AS plan_seconds,
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'build'), 0))::int AS build_seconds,
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'clarify'), 0))::int AS clarify_seconds,
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'approve'), 0))::int AS approve_seconds,
        (COALESCE(sum(extract(epoch FROM ("exited_at" - "entered_at"))) FILTER (WHERE "flow" = 'suspend'), 0))::int AS suspend_seconds
    FROM "issue_spans"
    WHERE "exited_at" IS NOT NULL
    GROUP BY "git_server_id", "repository_id", "issue_id"
) s
    ON s."git_server_id" = i."git_server_id"
    AND s."repository_id" = i."repository_id"
    AND s."issue_id" = i."issue_id"
ON CONFLICT ("id") DO NOTHING;

-- Seed: system dashboard agent-first-overview
INSERT INTO "dashboards" ("id", "name", "slug", "description", "is_system", "created_at", "updated_at") VALUES
    ('dashboard_agent_first_overview', 'Agent-first Overview', 'agent-first-overview', 'Agent-first issue-flow metrics overview', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "dashboard_variables" ("id", "dashboard_id", "name", "type", "default_value", "query_sql", "position") VALUES
    ('dashvar_overview_weeks', 'dashboard_agent_first_overview', 'weeks', 'select', '{"value": 8, "options": [4, 8, 12]}', '', 1),
    ('dashvar_overview_from', 'dashboard_agent_first_overview', 'from', 'time_range', '{"computed": "now_minus_weeks"}', '', 2),
    ('dashvar_overview_to', 'dashboard_agent_first_overview', 'to', 'time_range', '{"computed": "now"}', '', 3)
ON CONFLICT ("dashboard_id", "name") DO NOTHING;

INSERT INTO "dashboard_panels" (
    "id", "dashboard_id", "title", "query_sql", "chart_type",
    "x_field", "y_fields", "y2_fields", "series_field", "stack_field",
    "visual_config", "position", "created_at", "updated_at"
) VALUES
    (
        'dashpanel_started_issue_distribution',
        'dashboard_agent_first_overview',
        'Started Issue Distribution',
        $panel$select
  week,
  done_bucket,
  issue_count,
  weighted_count,
  triage_p50_days,
  build_p75_days,
  approve_p85_days
from weekly_issue_metrics
where week >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
order by week, done_bucket$panel$,
        'stacked_bar_with_lines',
        'week',
        '["issue_count", "weighted_count"]',
        '["triage_p50_days", "build_p75_days", "approve_p85_days"]',
        '',
        'done_bucket',
        '{"stackOrder": ["open", "7d+", "7d", "6d", "5d", "4d", "3d", "2d", "1d"], "y2Unit": "days"}',
        '{"x": 0, "y": 0, "w": 12, "h": 10}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        'dashpanel_wip_aging',
        'dashboard_agent_first_overview',
        'WIP Aging',
        $panel$select
  repository_full_name,
  issue_number,
  title,
  flow,
  priority,
  size,
  aging_seconds
from wip_aging_metrics
order by aging_seconds desc
limit 50$panel$,
        'table',
        '',
        NULL,
        NULL,
        '',
        '',
        '{"durationFields": ["aging_seconds"]}',
        '{"x": 0, "y": 10, "w": 7, "h": 9}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        'dashpanel_flow_wait_ranking',
        'dashboard_agent_first_overview',
        'Flow Wait Ranking',
        $panel$select
  flow,
  percentile_cont(0.85) within group (order by wait_seconds) as wait_p85_seconds,
  sum(wait_seconds) as wait_total_seconds
from issue_flow_metrics
where started_at >= :from
  and started_at < :to
group by flow
order by wait_total_seconds desc$panel$,
        'bar',
        'flow',
        '["wait_total_seconds"]',
        '["wait_p85_seconds"]',
        '',
        '',
        '{"yUnit": "seconds", "y2Unit": "seconds"}',
        '{"x": 7, "y": 10, "w": 5, "h": 9}',
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("id") DO NOTHING;
