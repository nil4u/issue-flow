-- 将 Issue 生命周期拆成可下钻的阶段耗时，同时保留总量守恒。
CREATE VIEW "issue_stage_time_metrics" AS
WITH issue_lifecycle AS (
  SELECT
    i."id" AS issue_row_id,
    i."git_server_id",
    i."repository_id",
    i."issue_number",
    (date_trunc('week', coalesce(st."opened_at", i."opened_at")))::date AS week,
    least(
      coalesce(st."cycle_started_at", st."opened_at", i."opened_at"),
      coalesce(st."opened_at", i."opened_at")
    ) AS lifecycle_started_at,
    coalesce(st."done_at", st."drop_at", now() AT TIME ZONE 'utc') AS lifecycle_ended_at,
    greatest(extract(epoch FROM (
      coalesce(st."done_at", st."drop_at", now() AT TIME ZONE 'utc')
      - least(
          coalesce(st."cycle_started_at", st."opened_at", i."opened_at"),
          coalesce(st."opened_at", i."opened_at")
        )
    )), 0)::numeric AS lifecycle_seconds,
    coalesce(st."total_task_seconds", 0)::numeric AS total_agent_seconds
  FROM "issues" i
  LEFT JOIN "issue_stats" st ON st."id" = i."id"
), span_facts AS (
  SELECT
    l.issue_row_id,
    s."id" AS span_id,
    s."flow",
    greatest(s."entered_at", l.lifecycle_started_at) AS started_at,
    least(coalesce(s."exited_at", l.lifecycle_ended_at), l.lifecycle_ended_at) AS ended_at,
    greatest(extract(epoch FROM (
      least(coalesce(s."exited_at", l.lifecycle_ended_at), l.lifecycle_ended_at)
      - greatest(s."entered_at", l.lifecycle_started_at)
    )), 0)::numeric AS span_seconds
  FROM issue_lifecycle l
  JOIN "issue_spans" s
    ON s."git_server_id" = l."git_server_id"
    AND s."repository_id" = l."repository_id"
    AND s."issue_number" = l."issue_number"
    AND s."entered_at" < l.lifecycle_ended_at
    AND coalesce(s."exited_at", l.lifecycle_ended_at) > l.lifecycle_started_at
), task_span_seconds AS (
  SELECT
    assigned.span_id,
    (sum(t."execution_ms") / 1000.0)::numeric AS agent_seconds
  FROM "tasks" t
  JOIN issue_lifecycle l
    ON l."git_server_id" = t."git_server_id"
    AND l."repository_id" = t."repository_id"
    AND l."issue_number" = t."issue_number"
  JOIN LATERAL (
    SELECT s."id" AS span_id
    FROM "issue_spans" s
    WHERE s."git_server_id" = t."git_server_id"
      AND s."repository_id" = t."repository_id"
      AND s."issue_number" = t."issue_number"
      AND s."entered_at" <= t."started_at"
      AND coalesce(s."exited_at", l.lifecycle_ended_at) >= t."started_at"
      AND t."started_at" >= l.lifecycle_started_at
      AND t."started_at" <= l.lifecycle_ended_at
    ORDER BY s."entered_at" DESC, s."id" DESC
    LIMIT 1
  ) assigned ON true
  WHERE t."started_at" IS NOT NULL
  GROUP BY assigned.span_id
), real_stages AS (
  SELECT
    sf.issue_row_id,
    sf."flow",
    min(sf.started_at) AS started_at,
    max(sf.ended_at) AS ended_at,
    sum(sf.span_seconds)::numeric AS span_seconds,
    sum(coalesce(ts.agent_seconds, 0))::numeric AS agent_seconds
  FROM span_facts sf
  LEFT JOIN task_span_seconds ts ON ts.span_id = sf.span_id
  GROUP BY sf.issue_row_id, sf."flow"
), real_totals AS (
  SELECT
    issue_row_id,
    sum(span_seconds)::numeric AS span_seconds,
    sum(agent_seconds)::numeric AS agent_seconds
  FROM real_stages
  GROUP BY issue_row_id
), stage_capacity AS (
  SELECT
    r.issue_row_id,
    r."flow",
    r.started_at,
    r.ended_at,
    r.span_seconds,
    r.agent_seconds,
    greatest(r.span_seconds - r.agent_seconds, 0)::numeric AS raw_wait_seconds
  FROM real_stages r

  UNION ALL

  SELECT
    l.issue_row_id,
    'unassigned' AS "flow",
    l.lifecycle_started_at AS started_at,
    l.lifecycle_ended_at AS ended_at,
    greatest(l.lifecycle_seconds - coalesce(rt.span_seconds, 0), 0)::numeric AS span_seconds,
    greatest(l.total_agent_seconds - coalesce(rt.agent_seconds, 0), 0)::numeric AS agent_seconds,
    greatest(
      greatest(l.lifecycle_seconds - coalesce(rt.span_seconds, 0), 0)
      - greatest(l.total_agent_seconds - coalesce(rt.agent_seconds, 0), 0),
      0
    )::numeric AS raw_wait_seconds
  FROM issue_lifecycle l
  LEFT JOIN real_totals rt ON rt.issue_row_id = l.issue_row_id
), reconciled AS (
  SELECT
    sc.*,
    sum(sc.raw_wait_seconds) OVER (PARTITION BY sc.issue_row_id)::numeric AS raw_wait_total
  FROM stage_capacity sc
)
SELECT
  l.issue_row_id,
  l."git_server_id",
  l."repository_id",
  l."issue_number",
  l.week,
  r."flow",
  r.started_at,
  r.ended_at,
  r.span_seconds,
  r.agent_seconds,
  CASE
    WHEN r.raw_wait_total > 0 THEN
      r.raw_wait_seconds
      * greatest(l.lifecycle_seconds - l.total_agent_seconds, 0)
      / r.raw_wait_total
    WHEN r."flow" = 'unassigned' THEN
      greatest(l.lifecycle_seconds - l.total_agent_seconds, 0)
    ELSE 0
  END::numeric AS wait_seconds,
  l.lifecycle_started_at,
  l.lifecycle_ended_at,
  l.lifecycle_seconds,
  l.total_agent_seconds,
  greatest(l.lifecycle_seconds - l.total_agent_seconds, 0)::numeric AS total_wait_seconds
FROM reconciled r
JOIN issue_lifecycle l ON l.issue_row_id = r.issue_row_id;

UPDATE "dashboard_panels"
SET
  "drill_query_sql" = $drill$with stage_rows as (
  select
    m.issue_row_id,
    m.issue_number,
    m.flow,
    m.wait_seconds,
    m.agent_seconds,
    m.total_agent_seconds,
    m.lifecycle_seconds,
    m.lifecycle_started_at,
    m.lifecycle_ended_at,
    row_number() over (
      partition by m.issue_row_id
      order by m.wait_seconds desc, m.flow
    ) as wait_rank
  from issue_stage_time_metrics m
  where m.git_server_id = :git_server_id
    and m.repository_id = :repository_id
    and m.week = :week::date
    and :component = 'wait'
), issue_rows as (
  select
    s.issue_row_id,
    s.issue_number,
    i.title,
    i.type,
    i.priority,
    i.size,
    max(s.lifecycle_started_at) as opened_at,
    max(s.lifecycle_ended_at) as resolved_at,
    max(s.lifecycle_seconds)::numeric as lifecycle_seconds,
    max(s.total_agent_seconds)::numeric as agent_seconds,
    sum(s.wait_seconds)::numeric as total_wait_seconds,
    max(s.flow) filter (where s.wait_rank = 1) as bottleneck_flow,
    max(s.wait_seconds) filter (where s.wait_rank = 1)::numeric as bottleneck_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'triage')::numeric as triage_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'plan')::numeric as plan_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'build')::numeric as build_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'clarify')::numeric as clarify_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'approve')::numeric as approve_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'suspend')::numeric as suspend_wait_seconds,
    sum(s.wait_seconds) filter (where s.flow = 'unassigned')::numeric as unassigned_wait_seconds
  from stage_rows s
  join issues i on i.id = s.issue_row_id
  group by s.issue_row_id, s.issue_number, i.title, i.type, i.priority, i.size
  having sum(s.wait_seconds) > 0
), summary as (
  select
    count(*)::int as total_count,
    percentile_cont(0.5) within group (order by total_wait_seconds)::numeric as wait_p50_seconds,
    max(total_wait_seconds)::numeric as wait_max_seconds
  from issue_rows
)
select
  r.*,
  case
    when r.lifecycle_seconds > 0 then round(r.agent_seconds * 100.0 / r.lifecycle_seconds)::int
    else 0
  end as agent_execution_pct,
  s.total_count,
  s.wait_p50_seconds,
  s.wait_max_seconds
from issue_rows r
cross join summary s
order by r.total_wait_seconds desc, r.issue_number desc
limit 100$drill$,
  "drill_config" = '{"kind":"issue_wait","params":["week","component"],"xParam":"week","seriesParam":"component","allowedSeries":["wait"]}',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'dashpanel_task_time_share';
