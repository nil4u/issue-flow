-- 将 @AGENTRIX 唤起的 general Task 纳入正式 action 分桶。
ALTER TABLE "issue_stats"
ADD COLUMN "general_task_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "general_task_turns" INTEGER NOT NULL DEFAULT 0;

WITH task_metrics AS (
  SELECT
    issue."id",
    coalesce(sum(task."execution_ms") FILTER (WHERE task."action" = 'general'), 0) AS general_ms,
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'general'), 0)::integer AS general_turns
  FROM "issues" issue
  LEFT JOIN "tasks" task
    ON task."git_server_id" = issue."git_server_id"
    AND task."repository_id" = issue."repository_id"
    AND task."issue_number" = issue."issue_number"
  GROUP BY issue."id"
)
UPDATE "issue_stats" stats
SET "general_task_seconds" = round(task_metrics.general_ms / 1000.0)::integer,
    "general_task_turns" = task_metrics.general_turns,
    "updated_at" = CURRENT_TIMESTAMP
FROM task_metrics
WHERE stats."id" = task_metrics."id";

UPDATE "dashboard_panels"
SET "drill_query_sql" = replace(
      replace(
        replace(
          "drill_query_sql",
          $old$    st."create_task_turns"::int as create_turns,
    st."triage_task_turns"::int as triage_turns,$old$,
          $new$    st."create_task_turns"::int as create_turns,
    st."general_task_turns"::int as general_turns,
    st."triage_task_turns"::int as triage_turns,$new$
        ),
        $old$      - st."create_task_turns"
      - st."triage_task_turns"$old$,
        $new$      - st."create_task_turns"
      - st."general_task_turns"
      - st."triage_task_turns"$new$
      ),
      $old$  b.create_turns,
  b.triage_turns,$old$,
      $new$  b.create_turns,
  b.general_turns,
  b.triage_turns,$new$
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_issue_task_turns_distribution';

UPDATE "dashboard_panels"
SET "visual_config" = jsonb_set(
      "visual_config",
      '{stackOrder}',
      '["create", "general", "triage", "plan", "build", "review"]'::jsonb
    ),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_token_consumption_trend';
