-- Add a reusable panel drill contract and enable it for issue completion distribution.
ALTER TABLE "dashboard_panels"
ADD COLUMN "drill_query_sql" TEXT NOT NULL DEFAULT '',
ADD COLUMN "drill_config" JSONB NOT NULL DEFAULT '{}';

UPDATE "dashboard_panels"
SET
    "drill_query_sql" = $drill$with scoped as (
  select
    i."id" as issue_row_id,
    i."issue_number" as issue_number,
    i."title" as title,
    i."state" as state,
    i."status" as status,
    i."type" as type,
    i."priority" as priority,
    i."size" as size,
    st."opened_at" as opened_at,
    coalesce(st."drop_at", st."done_at") as resolved_at,
    extract(epoch from (
      coalesce(st."drop_at", st."done_at", now() at time zone 'utc') - st."opened_at"
    ))::int as duration_seconds,
    case
      when st."drop_at" is not null then concat('dr', 'op')
      when st."done_at" is null then 'open'
      when st."done_at" <= st."opened_at" + interval '1 day' then '1d'
      when st."done_at" <= st."opened_at" + interval '2 days' then '2d'
      when st."done_at" <= st."opened_at" + interval '3 days' then '3d'
      when st."done_at" <= st."opened_at" + interval '4 days' then '4d'
      when st."done_at" <= st."opened_at" + interval '5 days' then '5d'
      when st."done_at" <= st."opened_at" + interval '6 days' then '6d'
      when st."done_at" <= st."opened_at" + interval '7 days' then '7d'
      else '7d+'
    end as done_bucket
  from "issues" i
  join "issue_stats" st on st."id" = i."id"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and date_trunc('week', st."opened_at")::date = :week::date
)
select
  issue_row_id,
  issue_number,
  title,
  state,
  status,
  type,
  priority,
  size,
  opened_at,
  resolved_at,
  duration_seconds,
  count(*) over()::int as total_count
from scoped
where done_bucket = :bucket
order by duration_seconds desc, issue_number desc
limit 100$drill$,
    "drill_config" = '{"kind":"issues","params":["week","bucket"],"xParam":"week","seriesParam":"bucket"}',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_started_issue_distribution';
