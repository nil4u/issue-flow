-- Task turns 表示用户输入次数，而不是 Agent SDK 的内部执行轮次。
UPDATE "tasks" AS task
SET "turns" = (
  SELECT count(*)::integer
  FROM "task_events" AS event
  WHERE event."task_id" = task."task_id"
    AND event."event_type" = 'human_input'
);

-- issue_stats 缓存了分阶段 turns，需要与修正后的 Task 数据保持一致。
WITH task_turns AS (
  SELECT
    issue."id",
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'triage'), 0)::integer AS "triage_turns",
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'plan'), 0)::integer AS "plan_turns",
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'build'), 0)::integer AS "build_turns",
    coalesce(sum(task."turns") FILTER (WHERE task."action" = 'review'), 0)::integer AS "review_turns"
  FROM "issues" AS issue
  LEFT JOIN "tasks" AS task
    ON task."git_server_id" = issue."git_server_id"
   AND task."repository_id" = issue."repository_id"
   AND task."issue_id" = issue."issue_id"
  GROUP BY issue."id"
)
UPDATE "issue_stats" AS stats
SET
  "triage_task_turns" = task_turns."triage_turns",
  "plan_task_turns" = task_turns."plan_turns",
  "build_task_turns" = task_turns."build_turns",
  "review_task_turns" = task_turns."review_turns",
  "updated_at" = CURRENT_TIMESTAMP
FROM task_turns
WHERE stats."id" = task_turns."id";
