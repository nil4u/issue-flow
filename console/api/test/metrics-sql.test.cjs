const assert = require('node:assert/strict');
const test = require('node:test');

require('tsx/cjs');

const {
  assertReadOnlyMetricsSql,
  bindMetricsParams,
  metricsResultFromRows,
} = require('../src/core/metrics-sql.ts');
const {
  openedByTaskId,
  pullRequestKind,
  pullRequestSnapshot,
  sourceIssueNumber,
} = require('../src/core/pull-request-projection.ts');

const STARTED_ISSUE_DISTRIBUTION_SQL = `select
  week,
  done_bucket,
  issue_count,
  weighted_count,
  duration_p80_days
from weekly_issue_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and week >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
order by week, done_bucket`;

const ISSUE_TYPE_DISTRIBUTION_SQL = `with typed as (
  select
    (date_trunc('week', i."opened_at"))::date as week,
    case
      when i."type" = '' then '未分类'
      else 'type::' || i."type"
    end as issue_type,
    coalesce(w."weight", 1) as weight
  from issues i
  left join metric_size_weights w on w."size" = i."size"
  where i."git_server_id" = :git_server_id
    and i."repository_id" = :repository_id
    and i."opened_at" >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
)
select
  week,
  issue_type,
  count(*)::int as issue_count,
  sum(weight)::numeric as weighted_count
from typed
group by week, issue_type
order by week, issue_type`;

const ISSUE_TASK_TURNS_DISTRIBUTION_SQL = `with bucketed as (
  select
    scored.git_server_id,
    scored.repository_id,
    scored.week,
    scored.total_task_turns,
    case
      when scored.total_task_turns = 0 then '0'
      when scored.total_task_turns <= 3 then '1-3'
      when scored.total_task_turns <= 6 then '4-6'
      when scored.total_task_turns <= 10 then '7-10'
      when scored.total_task_turns <= 20 then '11-20'
      else '20+'
    end as turns_bucket,
    scored.weight
  from (
    select
      i."git_server_id",
      i."repository_id",
      (date_trunc('week', st."opened_at"))::date as week,
      (
        st."triage_task_turns"
        + st."plan_task_turns"
        + st."build_task_turns"
        + st."review_task_turns"
      ) as total_task_turns,
      coalesce(w."weight", 1) as weight
    from issue_stats st
    join issues i on i."id" = st."id"
    left join metric_size_weights w on w."size" = i."size"
    where i."git_server_id" = :git_server_id
      and i."repository_id" = :repository_id
      and st."opened_at" >= date_trunc('week', now()) - (:weeks::int - 1) * interval '1 week'
  ) scored
)
select
  b.week,
  b.turns_bucket,
  count(*)::int as issue_count,
  sum(b.weight)::numeric as weighted_count,
  w.task_turns_p80
from bucketed b
join (
  select
    git_server_id,
    repository_id,
    week,
    percentile_cont(0.8) within group (order by total_task_turns) as task_turns_p80
  from bucketed
  group by git_server_id, repository_id, week
) w
  on w.git_server_id = b.git_server_id
  and w.repository_id = b.repository_id
  and w.week = b.week
group by b.week, b.turns_bucket, w.task_turns_p80
order by b.week, b.turns_bucket`;

const TOKEN_CONSUMPTION_TREND_SQL = `with scoped as (
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
order by wa.week, wa.action`;

const TASK_TIME_SHARE_SQL = `with scoped as (
  select
    (date_trunc('week', coalesce(st.opened_at, i.opened_at)))::date as week,
    extract(epoch from (
      coalesce(st.done_at, st.drop_at, now() at time zone 'utc')
      - coalesce(st.opened_at, i.opened_at)
    ))::numeric as lifecycle_seconds,
    (
      coalesce(st.triage_task_seconds, 0)
      + coalesce(st.plan_task_seconds, 0)
      + coalesce(st.build_task_seconds, 0)
      + coalesce(st.review_task_seconds, 0)
    )::numeric as agent_seconds
  from issues i
  left join issue_stats st on st.id = i.id
  where i.git_server_id = :git_server_id
    and i.repository_id = :repository_id
    and coalesce(st.opened_at, i.opened_at) >= :from
    and coalesce(st.opened_at, i.opened_at) < :to
), weekly as (
  select
    week,
    sum(agent_seconds)::numeric as agent_seconds,
    sum(lifecycle_seconds)::numeric as lifecycle_seconds,
    greatest(sum(lifecycle_seconds) - sum(agent_seconds), 0)::numeric as wait_seconds
  from scoped
  where lifecycle_seconds > 0
  group by week
)
select
  week,
  'agent' as component,
  agent_seconds as seconds,
  case when lifecycle_seconds > 0 then (agent_seconds * 100.0 / lifecycle_seconds) else 0 end as task_share_pct
from weekly
where agent_seconds > 0
union all
select
  week,
  'wait' as component,
  wait_seconds as seconds,
  case when lifecycle_seconds > 0 then (agent_seconds * 100.0 / lifecycle_seconds) else 0 end as task_share_pct
from weekly
where wait_seconds > 0
order by week, component`;

test('assertReadOnlyMetricsSql allows the seeded panel queries', () => {
  assert.equal(typeof assertReadOnlyMetricsSql(STARTED_ISSUE_DISTRIBUTION_SQL), 'string');
  assert.equal(typeof assertReadOnlyMetricsSql(ISSUE_TYPE_DISTRIBUTION_SQL), 'string');
  assert.equal(typeof assertReadOnlyMetricsSql(ISSUE_TASK_TURNS_DISTRIBUTION_SQL), 'string');
  assert.equal(typeof assertReadOnlyMetricsSql(TOKEN_CONSUMPTION_TREND_SQL), 'string');
  assert.equal(typeof assertReadOnlyMetricsSql(TASK_TIME_SHARE_SQL), 'string');
  assert.match(TASK_TIME_SHARE_SQL, /from issues[\s\S]+left join issue_stats/);
  assert.doesNotMatch(TASK_TIME_SHARE_SQL, /issue_flow_metrics/);
  assert.ok(assertReadOnlyMetricsSql(`select
    flow,
    percentile_cont(0.85) within group (order by wait_seconds) as wait_p85_seconds,
    sum(wait_seconds) as wait_total_seconds
  from issue_flow_metrics
  where started_at >= :from
    and started_at < :to
  group by flow
  order by wait_total_seconds desc`));
  assert.ok(assertReadOnlyMetricsSql('select repository_full_name, aging_seconds from wip_aging_metrics order by aging_seconds desc limit 50'));
});

test('assertReadOnlyMetricsSql allows CTE names and extract(... from ...)', () => {
  assert.ok(assertReadOnlyMetricsSql('with recent as (select id from issues), sized as (select size from issues) select count(*) from recent'));
  assert.ok(assertReadOnlyMetricsSql('select extract(epoch from started_at) from issue_flow_metrics'));
});

test('assertReadOnlyMetricsSql blocks write statements', () => {
  for (const sql of [
    "insert into issues values ('x')",
    'update issues set title = 1',
    'delete from issues',
    'drop table issues',
    'create table x (id int)',
    'truncate issues',
    'grant all on issues to public',
  ]) {
    assert.throws(() => assertReadOnlyMetricsSql(sql), /metrics_sql/);
  }
});

test('assertReadOnlyMetricsSql blocks embedded write keywords in select statements', () => {
  assert.throws(() => assertReadOnlyMetricsSql('select 1 from issues; drop table issues'), /metrics_sql_single_statement_required/);
  assert.throws(() => assertReadOnlyMetricsSql('select 1 -- drop'), /metrics_sql_comment_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('select 1 /* x */ from issues'), /metrics_sql_comment_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('with x as (delete from issues returning id) select 1 from x'), /metrics_sql_statement_blocked/);
});

test('assertReadOnlyMetricsSql blocks sources outside the allowlist', () => {
  assert.throws(() => assertReadOnlyMetricsSql('select * from git_events'), /metrics_sql_source_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('select * from git_servers'), /metrics_sql_source_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('select * from task_events'), /metrics_sql_source_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('select * from public.issues'), /metrics_sql_source_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('select * from issues join oauth_sessions on true'), /metrics_sql_source_blocked/);
});

test('assertReadOnlyMetricsSql blocks pg_ functions and non-select statements', () => {
  assert.throws(() => assertReadOnlyMetricsSql('select pg_sleep(10)'), /metrics_sql_function_blocked/);
  assert.throws(() => assertReadOnlyMetricsSql('vacuum issues'), /metrics_sql_select_only/);
  assert.throws(() => assertReadOnlyMetricsSql(''), /metrics_sql_required/);
});

test('bindMetricsParams rewrites named params to positional placeholders', () => {
  const bound = bindMetricsParams(STARTED_ISSUE_DISTRIBUTION_SQL, {
    git_server_id: 'gitlab-main',
    repository_id: '42',
    weeks: 8,
  });
  assert.match(bound.text, /\(\$3::int - 1\)/);
  assert.deepEqual(bound.values, ['gitlab-main', '42', 8]);

  const range = bindMetricsParams('select 1 from issue_flow_metrics where started_at >= :from and started_at < :to and ended_at < :to', {
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-07-01T00:00:00.000Z',
  });
  assert.match(range.text, /started_at >= \$1::timestamp/);
  assert.match(range.text, /started_at < \$2::timestamp/);
  assert.match(range.text, /ended_at < \$2::timestamp/);
  assert.deepEqual(range.values, ['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']);
});

test('bindMetricsParams validates parameter names and values', () => {
  assert.throws(() => bindMetricsParams('select :evil', { evil: 1 }), /metrics_sql_param_blocked/);
  assert.throws(() => bindMetricsParams('select :weeks::int', {}), /metrics_sql_param_required/);
  assert.throws(() => bindMetricsParams('select :weeks::int', { weeks: 'nope' }), /metrics_sql_param_invalid/);
  assert.throws(() => bindMetricsParams('select :weeks::int', { weeks: 0 }), /metrics_sql_param_invalid/);
});

test('metricsResultFromRows normalizes cells and reports truncation', () => {
  const result = metricsResultFromRows([
    { week: new Date('2026-06-01T00:00:00.000Z'), issue_count: 3n, title: 'x' },
    { week: null, issue_count: 1n, title: 'y' },
  ]);
  assert.deepEqual(result.columns, [
    { name: 'week', type: 'date' },
    { name: 'issue_count', type: 'number' },
    { name: 'title', type: 'string' },
  ]);
  assert.deepEqual(result.rows[0], { week: '2026-06-01T00:00:00.000Z', issue_count: 3, title: 'x' });
  assert.equal(result.rows[1].week, null);
  assert.equal(result.truncated, false);

  const truncated = metricsResultFromRows([{ n: 1 }, { n: 2 }, { n: 3 }], 2);
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.rows.length, 2);
});

test('pullRequestSnapshot parses merge request webhook payloads', () => {
  const description = [
    'Build result',
    '',
    '<!-- issue-flow:source-issue=42 -->',
    '<!-- issue-flow:agentrix:task=task-abc-123 -->',
  ].join('\n');
  assert.equal(sourceIssueNumber(description), 42);
  assert.equal(openedByTaskId(description), 'task-abc-123');
  assert.equal(pullRequestKind(['mr-by::build']), 'build');
  assert.equal(pullRequestKind([{ title: 'mr-by::plan' }].map((label) => label.title)), 'plan');
  assert.equal(pullRequestKind(['type::feature']), '');

  const snapshot = pullRequestSnapshot({
    eventName: 'merge_request',
    gitServerId: 'gitlab-main',
    repositoryId: '42',
    repositoryFullName: 'group/app',
    receivedAt: '2026-06-20T10:00:00.000Z',
    payload: {
      object_kind: 'merge_request',
      labels: [{ title: 'mr-by::build' }],
      object_attributes: {
        id: 9001,
        iid: 12,
        title: 'Build #42: do the thing',
        description,
        state: 'opened',
        url: 'https://gitlab.example.com/group/app/-/merge_requests/12',
        created_at: '2026-06-20T09:59:00.000Z',
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    },
  });
  assert.equal(snapshot.pullRequestId, '9001');
  assert.equal(snapshot.prNumber, 12);
  assert.equal(snapshot.issueNumber, 42);
  assert.equal(snapshot.openedByTaskId, 'task-abc-123');
  assert.equal(snapshot.kind, 'build');
  assert.equal(snapshot.state, 'open');
  assert.equal(snapshot.htmlUrl, 'https://gitlab.example.com/group/app/-/merge_requests/12');
  assert.equal(snapshot.openedAt, '2026-06-20T09:59:00.000Z');
  assert.equal(snapshot.mergedAt, '');
  assert.equal(snapshot.closedAt, '');
});

test('pullRequestSnapshot maps merged and closed states', () => {
  const base = {
    eventName: 'merge_request',
    gitServerId: 'gitlab-main',
    repositoryId: '42',
    repositoryFullName: 'group/app',
    payload: {
      object_kind: 'merge_request',
      object_attributes: {
        id: 9002,
        iid: 13,
        state: 'merged',
        updated_at: '2026-06-21T08:00:00.000Z',
      },
    },
  };
  const merged = pullRequestSnapshot(base);
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedAt, '2026-06-21T08:00:00.000Z');

  const closed = pullRequestSnapshot({
    ...base,
    payload: {
      object_kind: 'merge_request',
      object_attributes: { id: 9002, iid: 13, state: 'closed', updated_at: '2026-06-21T09:00:00.000Z' },
    },
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closedAt, '2026-06-21T09:00:00.000Z');

  assert.equal(pullRequestSnapshot({ eventName: 'issue', payload: { object_kind: 'issue' } }), undefined);
});
