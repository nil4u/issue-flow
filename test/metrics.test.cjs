const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const envPath = path.join(__dirname, '..', '.env.dev');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.startsWith('DATABASE_URL='));
    if (line) {
      process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim();
      return process.env.DATABASE_URL;
    }
  }
  throw new Error('DATABASE_URL is required for metrics tests');
}

loadDatabaseUrl();
process.env.ISSUE_FLOW_BASE_URL ||= 'https://issue-flow.internal';
process.env.ISSUE_FLOW_SETUP_CODE ||= 'test-setup-code';
require('tsx/cjs');

const { createApp } = require('../apps/api/src/app.ts');
const { IssueFlowStore } = require('../apps/api/src/core/store.ts');
const { applyIssueSnapshotToFacts } = require('../apps/api/src/core/issue-projection.ts');
const { applyGitEventToPullRequestFacts } = require('../apps/api/src/core/pull-request-projection.ts');

let testSchemaCounter = 0;
const migrationSql = fs.readdirSync(path.join(__dirname, '..', 'prisma', 'migrations'))
  .filter((name) => /^\d+_/.test(name))
  .sort()
  .map((name) => fs.readFileSync(
    path.join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql'),
    'utf8'
  ))
  .join('\n');

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrlWithoutSchema(value) {
  const url = new URL(value);
  url.searchParams.delete('schema');
  return url.toString();
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-flow-metrics-test-'));
  const schema = `issue_flow_metrics_test_${process.pid}_${Date.now()}_${++testSchemaCounter}`;
  const connectionString = databaseUrlWithoutSchema(loadDatabaseUrl());
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }, { schema }),
  });
  const store = new IssueFlowStore({
    db: prisma,
    keyPath: path.join(dir, 'key'),
    metricsSchema: schema,
    // keep the debounce window out of the way: tests drive rebuilds via flushIssueStatsRebuilds()
    issueStatsDebounceMs: 60000,
  });
  store.ready = (async () => {
    await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await pool.query(`SET search_path TO ${quoteIdent(schema)};\n${migrationSql}`);
  })();
  store.close = async () => {
    await store.ready;
    await prisma.$disconnect();
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await pool.end();
  };
  return { dir, store };
}

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const BASE_TIME = Date.now() - 3 * DAY_MS;

function at(offsetMs) {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

function issueSnapshot(overrides = {}) {
  return {
    gitServerId: 'gitlab-main',
    repositoryId: '42',
    repositoryFullName: 'group/app',
    issueId: '4207',
    issueNumber: 7,
    title: 'Metrics issue',
    state: 'opened',
    type: 'feature',
    priority: 'P1',
    size: 'M',
    automation: 'off',
    status: 'active',
    flow: 'triage',
    openedAt: at(0),
    closedAt: '',
    updatedAt: at(0),
    ...overrides,
  };
}

function mergeRequestEvent(attributes = {}, labels = ['mr-by::build']) {
  return {
    eventName: 'merge_request',
    gitServerId: 'gitlab-main',
    repositoryId: '42',
    repositoryFullName: 'group/app',
    receivedAt: at(HOUR_MS),
    payload: {
      object_kind: 'merge_request',
      labels: labels.map((title) => ({ title })),
      object_attributes: {
        id: 9001,
        iid: 12,
        title: 'Build #7: metrics',
        description: '<!-- issue-flow:source-issue=7 -->\n<!-- issue-flow:agentrix:task=task-abc -->',
        state: 'opened',
        url: 'https://gitlab.example.com/group/app/-/merge_requests/12',
        created_at: at(HOUR_MS),
        updated_at: at(HOUR_MS),
        ...attributes,
      },
    },
  };
}

async function findIssueRow(store, snapshot) {
  return store.db.issue.findUnique({
    where: {
      gitServerId_repositoryId_issueId: {
        gitServerId: snapshot.gitServerId,
        repositoryId: snapshot.repositoryId,
        issueId: snapshot.issueId,
      },
    },
  });
}

test('issue snapshots rebuild issue_stats with span totals and terminal timestamps', async () => {
  const { store } = tempStore();
  try {
    await applyIssueSnapshotToFacts(store, issueSnapshot());
    await applyIssueSnapshotToFacts(store, issueSnapshot({
      flow: 'build',
      updatedAt: at(HOUR_MS),
    }));
    await applyIssueSnapshotToFacts(store, issueSnapshot({
      state: 'closed',
      status: 'done',
      flow: '',
      closedAt: at(3 * HOUR_MS),
      updatedAt: at(3 * HOUR_MS),
    }));
    assert.equal(store.pendingIssueStatsRebuilds.size, 1, 'rebuild triggers for one issue coalesce into a single pending entry');
    await store.flushIssueStatsRebuilds();
    assert.equal(store.pendingIssueStatsRebuilds.size, 0);

    const issueRow = await findIssueRow(store, issueSnapshot());
    assert.ok(issueRow, 'issue row exists');
    const stats = await store.getIssueStats(issueRow.id);
    assert.ok(stats, 'issue_stats row exists with the same id');
    assert.equal(stats.id, issueRow.id);
    assert.equal(stats.openedAt, at(0));
    assert.equal(stats.closedAt, at(3 * HOUR_MS));
    assert.equal(stats.doneAt, at(3 * HOUR_MS));
    assert.equal(stats.dropAt, '');
    assert.equal(stats.triageSpanSeconds, 3600);
    assert.equal(stats.buildSpanSeconds, 2 * 3600);
    assert.equal(stats.planSpanSeconds, 0);
    assert.equal(stats.triageTaskSeconds, 0);
    assert.equal(stats.buildTaskTurns, 0);
    assert.equal(stats.pullRequestCount, 0);
  } finally {
    await store.close();
  }
});

test('dropped issues record drop_at instead of done_at', async () => {
  const { store } = tempStore();
  try {
    await applyIssueSnapshotToFacts(store, issueSnapshot());
    await applyIssueSnapshotToFacts(store, issueSnapshot({
      state: 'closed',
      status: 'drop',
      flow: '',
      closedAt: at(HOUR_MS),
      updatedAt: at(HOUR_MS),
    }));
    await store.flushIssueStatsRebuilds();
    const issueRow = await findIssueRow(store, issueSnapshot());
    const stats = await store.getIssueStats(issueRow.id);
    assert.equal(stats.doneAt, '');
    assert.equal(stats.dropAt, at(HOUR_MS));
  } finally {
    await store.close();
  }
});

test('merge request events project pull_requests and update pull_request_count', async () => {
  const { store } = tempStore();
  try {
    await applyIssueSnapshotToFacts(store, issueSnapshot());

    const opened = await applyGitEventToPullRequestFacts(store, mergeRequestEvent());
    assert.ok(opened, 'pull request projected');
    assert.equal(opened.prNumber, 12);
    assert.equal(opened.issueNumber, 7);
    assert.equal(opened.issueId, '4207');
    assert.equal(opened.kind, 'build');
    assert.equal(opened.openedByTaskId, 'task-abc');
    assert.equal(opened.state, 'open');
    await store.flushIssueStatsRebuilds();

    const issueRow = await findIssueRow(store, issueSnapshot());
    let stats = await store.getIssueStats(issueRow.id);
    assert.equal(stats.pullRequestCount, 1);

    const merged = await applyGitEventToPullRequestFacts(store, mergeRequestEvent({
      state: 'merged',
      updated_at: at(2 * HOUR_MS),
    }));
    assert.equal(merged.state, 'merged');
    assert.equal(merged.mergedAt, at(2 * HOUR_MS));

    const stale = await store.upsertPullRequestSnapshot({
      gitServerId: 'gitlab-main',
      repositoryId: '42',
      repositoryFullName: 'group/app',
      pullRequestId: '9001',
      prNumber: 12,
      state: 'open',
      updatedAt: at(HOUR_MS / 2),
    });
    assert.equal(stale.applied, false, 'stale updates are ignored');
    await store.flushIssueStatsRebuilds();

    stats = await store.getIssueStats(issueRow.id);
    assert.equal(stats.pullRequestCount, 1);
  } finally {
    await store.close();
  }
});

test('metric views and the read-only executor answer the seeded panel queries', async () => {
  const { store } = tempStore();
  try {
    // done issue: triage 1h then done after 12h, size M (weight 2)
    await applyIssueSnapshotToFacts(store, issueSnapshot());
    await applyIssueSnapshotToFacts(store, issueSnapshot({
      state: 'closed',
      status: 'done',
      flow: '',
      closedAt: at(12 * HOUR_MS),
      updatedAt: at(12 * HOUR_MS),
    }));
    // open issue: still in triage, size S (weight 1)
    const openIssue = issueSnapshot({
      issueId: '4208',
      issueNumber: 8,
      title: 'Open metrics issue',
      size: 'S',
      openedAt: at(HOUR_MS),
      updatedAt: at(HOUR_MS),
    });
    await applyIssueSnapshotToFacts(store, openIssue);
    await store.flushIssueStatsRebuilds();

    const weekly = await store.runMetricsQuery(
      'select week, done_bucket, issue_count, weighted_count from weekly_issue_metrics order by done_bucket',
      {},
    );
    const buckets = new Map(weekly.rows.map((row) => [row.done_bucket, row]));
    assert.ok(buckets.has('1d'), 'done-in-12h issue lands in the 1d bucket');
    assert.equal(buckets.get('1d').issue_count, 1);
    assert.equal(Number(buckets.get('1d').weighted_count), 2);
    assert.ok(buckets.has('open'), 'open issues use the open bucket');
    assert.equal(Number(buckets.get('open').weighted_count), 1);

    const wip = await store.runMetricsQuery('select * from wip_aging_metrics', {});
    assert.equal(wip.rows.length, 1);
    assert.equal(wip.rows[0].flow, 'triage');
    assert.equal(wip.rows[0].issue_number, 8);
    assert.ok(Number(wip.rows[0].aging_seconds) > 0);

    const dashboard = await store.getDashboardBySlug('agent-first-overview');
    assert.ok(dashboard, 'system dashboard seeded');
    assert.equal(dashboard.isSystem, true);
    assert.deepEqual(dashboard.panels.map((panel) => panel.id), ['dashpanel_started_issue_distribution']);
    assert.deepEqual(dashboard.variables.map((variable) => variable.name), ['weeks', 'from', 'to']);

    const repoParams = { git_server_id: 'gitlab-main', repository_id: '42' };
    const distribution = dashboard.panels.find((panel) => panel.id === 'dashpanel_started_issue_distribution');
    const distributionResult = await store.runMetricsQuery(distribution.querySql, { ...repoParams, weeks: 8 });
    assert.ok(distributionResult.rows.length >= 2);
    assert.deepEqual(
      distributionResult.columns.map((column) => column.name),
      ['week', 'done_bucket', 'issue_count', 'weighted_count', 'triage_p50_days', 'build_p75_days', 'approve_p85_days'],
    );

    const otherRepo = await store.runMetricsQuery(distribution.querySql, {
      ...repoParams,
      repository_id: 'other-repo',
      weeks: 8,
    });
    assert.equal(otherRepo.rows.length, 0, 'panel queries are scoped to the requested repository');

    const flowWaitSql = `select
  flow,
  sum(wait_seconds) as wait_total_seconds
from issue_flow_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
  and started_at >= :from
  and started_at < :to
group by flow`;
    const waitResult = await store.runMetricsQuery(flowWaitSql, {
      ...repoParams,
      from: at(-30 * DAY_MS),
      to: at(30 * DAY_MS),
    });
    assert.ok(waitResult.rows.some((row) => row.flow === 'triage'));

    await assert.rejects(store.runMetricsQuery('select * from git_events', {}), /metrics_sql_source_blocked/);
    await assert.rejects(store.runMetricsQuery("insert into issues (id) values ('x')", {}), /metrics_sql_select_only/);
    await assert.rejects(store.runMetricsQuery(flowWaitSql, repoParams), /metrics_sql_param_required/);
  } finally {
    await store.close();
  }
});

test('dashboard routes require login and serve repo-scoped panel queries', async () => {
  const { store } = tempStore();
  const app = await createApp({ store });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const user = await store.createUser({ displayName: 'Metrics Tester' });
    const cookie = `issue_flow_user=${user.id}`;
    await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
    });
    const repoRow = await store.upsertRepo({
      gitServerId: 'gitlab-main',
      serverRepoId: '42',
      fullName: 'group/app',
    });
    await store.grantUserRepoAccess({
      userId: user.id,
      gitServerId: 'gitlab-main',
      repoId: repoRow.id,
    });
    const queryPath = `/api/repositories/${repoRow.id}/dashboards/agent-first-overview/panels/dashpanel_started_issue_distribution/query`;

    const anonymous = await fetch(`${baseUrl}/api/dashboards`);
    assert.equal(anonymous.status, 401);

    const forged = await fetch(`${baseUrl}/api/dashboards`, { headers: { cookie: 'issue_flow_user=user_forged' } });
    assert.equal(forged.status, 401, 'cookies without a backing user are rejected');

    const listResponse = await fetch(`${baseUrl}/api/dashboards`, { headers: { cookie } });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.ok(listBody.dashboards.some((dashboard) => dashboard.slug === 'agent-first-overview'));

    const missing = await fetch(`${baseUrl}/api/dashboards/nope`, { headers: { cookie } });
    assert.equal(missing.status, 404);

    const detailResponse = await fetch(`${baseUrl}/api/dashboards/agent-first-overview`, { headers: { cookie } });
    assert.equal(detailResponse.status, 200);
    const detailBody = await detailResponse.json();
    assert.equal(detailBody.dashboard.panels.length, 1);

    const queryResponse = await fetch(`${baseUrl}${queryPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ params: { weeks: 8 } }),
    });
    assert.equal(queryResponse.status, 200);
    const queryBody = await queryResponse.json();
    assert.ok(Array.isArray(queryBody.result.columns));
    assert.ok(Array.isArray(queryBody.result.rows));

    const noAccess = await fetch(`${baseUrl}${queryPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: 'issue_flow_user=user_forged' },
      body: JSON.stringify({ params: { weeks: 8 } }),
    });
    assert.equal(noAccess.status, 404, 'users without repo access cannot query repo panels');

    const badQuery = await fetch(`${baseUrl}${queryPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ params: {} }),
    });
    assert.equal(badQuery.status, 400);
  } finally {
    await app.close();
    await store.close();
  }
});
