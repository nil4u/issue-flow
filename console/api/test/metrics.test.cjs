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
  const envPath = path.join(__dirname, '..', '..', '..', '.env.dev');
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

const { createApp } = require('../src/app.ts');
const { IssueFlowStore } = require('../src/core/store.ts');
const {
  applyGitEventToIssueFacts,
  applyGitlabIssueSnapshotToFacts,
  applyIssueSnapshotToFacts,
} = require('../src/core/issue-projection.ts');
const { applyGitEventToPullRequestFacts } = require('../src/core/pull-request-projection.ts');
const { applyForwardedEventToTaskFacts } = require('../src/core/task-projection.ts');

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
        description: '<!-- issue-flow:source-issue=7 -->\n<!-- issue-flow:source source_task_id=task-abc source_runtime=agentrix -->',
        state: 'opened',
        url: 'https://gitlab.example.com/group/app/-/merge_requests/12',
        created_at: at(HOUR_MS),
        updated_at: at(HOUR_MS),
        ...attributes,
      },
    },
  };
}

function issueEvent(attributes = {}, labels = ['flow::triage']) {
  return {
    eventName: 'issue',
    gitServerId: 'gitlab-main',
    repositoryId: '42',
    repositoryFullName: 'group/app',
    receivedAt: at(HOUR_MS),
    payload: {
      object_kind: 'issue',
      labels: labels.map((title) => ({ title })),
      object_attributes: {
        id: 4207,
        iid: 7,
        title: 'Metrics issue',
        description: '<!-- issue-flow:source source_task_id=task-created-issue source_runtime=agentrix -->',
        state: 'opened',
        created_at: at(0),
        updated_at: at(HOUR_MS),
        ...attributes,
      },
    },
  };
}

function forwardedEvent(overrides = {}) {
  return {
    cursor: 1,
    eventId: 'evt-1',
    taskId: 'task-abc',
    eventType: 'task-message',
    direction: 'outbound',
    eventData: {},
    createdAt: at(HOUR_MS),
    ...overrides,
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
    const markerTask = await store.getTask('task-abc');
    assert.equal(markerTask.status, 'unknown');
    assert.equal(markerTask.issueNumber, 7);
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

test('issue markers persist creator provenance and create fill-only task placeholders', async () => {
  const { store } = tempStore();
  try {
    await applyGitEventToIssueFacts(store, issueEvent());

    let issue = await findIssueRow(store, issueSnapshot());
    assert.equal(issue.createdByTaskId, 'task-created-issue');

    let task = await store.getTask('task-created-issue');
    assert.equal(task.status, 'unknown');
    assert.equal(task.gitServerId, 'gitlab-main');
    assert.equal(task.repositoryId, '42');
    assert.equal('issueId' in task, false);
    assert.equal(task.issueNumber, 7);

    await store.upsertTaskRuntime({
      taskId: 'task-created-issue',
      status: 'running',
      agent: 'codex',
      model: 'gpt-5',
      startedAt: at(HOUR_MS + 1000),
    });
    await store.appendTaskEvent({
      taskId: 'task-created-issue',
      eventId: 'evt-before-authoritative-link',
      eventType: 'worker_state',
      eventData: { state: 'ready', duration: 1000 },
      createdAt: at(HOUR_MS + 2000),
    });
    await applyGitEventToIssueFacts(store, issueEvent());
    task = await store.getTask('task-created-issue');
    assert.equal(task.status, 'running');
    assert.equal(task.agent, 'codex');
    assert.equal(task.issueNumber, 7);

    await applyIssueSnapshotToFacts(store, issueSnapshot({
      issueId: '4208',
      issueNumber: 8,
      title: 'Another issue',
      updatedAt: at(2 * HOUR_MS),
    }));
    await applyGitEventToIssueFacts(store, issueEvent({
      id: 4208,
      iid: 8,
      title: 'Another issue',
      updated_at: at(2 * HOUR_MS),
    }));
    issue = await findIssueRow(store, issueSnapshot({ issueId: '4208', issueNumber: 8 }));
    assert.equal(issue.createdByTaskId, 'task-created-issue');
    task = await store.getTask('task-created-issue');
    assert.equal(task.issueNumber, 7, 'a later marker cannot rebind an existing task');

    await store.upsertTaskLink({
      taskId: 'task-created-issue',
      gitServerId: 'gitlab-main',
      repositoryId: '42',
      issueNumber: 8,
      action: 'build',
    });
    task = await store.getTask('task-created-issue');
    assert.equal(task.issueNumber, 8, 'the forwarded link remains authoritative');
    assert.equal(task.action, 'build');
    assert.equal(task.status, 'running');
    assert.equal('issueSpanRowId' in task, false);
    const events = await store.listTaskEvents('task-created-issue');
    assert.equal('issueId' in events[0], false);
    assert.equal(events[0].issueNumber, 8);
  } finally {
    await store.close();
  }
});

test('issue markers fill an existing task only when its issue link is empty', async () => {
  const { store } = tempStore();
  try {
    await store.upsertTaskRuntime({
      taskId: 'task-created-issue',
      status: 'running',
      agent: 'codex',
      startedAt: at(HOUR_MS + 1000),
    });

    await applyGitEventToIssueFacts(store, issueEvent());
    const task = await store.getTask('task-created-issue');
    assert.equal(task.status, 'running');
    assert.equal(task.issueNumber, 7);
  } finally {
    await store.close();
  }
});

test('issue provenance from another runtime does not create an Agentrix task', async () => {
  const { store } = tempStore();
  try {
    await applyGitEventToIssueFacts(store, issueEvent({
      description: '<!-- issue-flow:source source_task_id=foreign-task source_runtime=other -->',
    }));
    const issue = await findIssueRow(store, issueSnapshot());
    assert.equal(issue.createdByTaskId, '');
    assert.equal(await store.getTask('foreign-task'), undefined);
  } finally {
    await store.close();
  }
});

test('GitLab issue snapshots backfill task links from stored descriptions', async () => {
  const { store } = tempStore();
  try {
    await applyGitlabIssueSnapshotToFacts(store, {
      gitServerId: 'gitlab-main',
      projectId: '42',
      projectPath: 'group/app',
    }, {
      id: '4207',
      iid: 7,
      title: 'Metrics issue',
      state: 'opened',
      labels: ['flow::triage'],
      description: '<!-- issue-flow:source source_task_id=task-from-snapshot source_runtime=agentrix -->',
      createdAt: at(0),
      updatedAt: at(HOUR_MS),
      closedAt: '',
    });
    const task = await store.getTask('task-from-snapshot');
    assert.equal(task.status, 'unknown');
    assert.equal(task.issueNumber, 7);
    const issue = await findIssueRow(store, issueSnapshot());
    assert.equal(issue.createdByTaskId, 'task-from-snapshot');
  } finally {
    await store.close();
  }
});

test('task metrics join by repository-scoped issue number when the issue arrives later', async () => {
  const { store } = tempStore();
  try {
    await store.upsertTaskLink({
      taskId: 'task-before-issue',
      gitServerId: 'gitlab-main',
      repositoryId: '42',
      issueNumber: 7,
      action: 'build',
      queuedAt: at(HOUR_MS),
    });
    await store.upsertTaskRuntime({
      taskId: 'task-before-issue',
      status: 'running',
      startedAt: at(HOUR_MS + 1000),
    });
    await store.appendTaskEvent({
      taskId: 'task-before-issue',
      eventId: 'evt-task-before-issue-ready',
      eventType: 'worker_state',
      eventData: { state: 'ready', duration: 60_000 },
      createdAt: at(HOUR_MS + 61_000),
    });

    await applyIssueSnapshotToFacts(store, issueSnapshot());
    await store.flushIssueStatsRebuilds();

    const task = await store.getTask('task-before-issue');
    const issue = await findIssueRow(store, issueSnapshot());
    const stats = await store.getIssueStats(issue.id);
    const execution = await store.runMetricsQuery(`select
      issue_row_id,
      task_row_id
    from task_execution_metrics
    where git_server_id = :git_server_id
      and repository_id = :repository_id`, {
      git_server_id: 'gitlab-main',
      repository_id: '42',
    });
    const flow = await store.runMetricsQuery(`select
      flow,
      task_seconds
    from issue_flow_metrics
    where git_server_id = :git_server_id
      and repository_id = :repository_id`, {
      git_server_id: 'gitlab-main',
      repository_id: '42',
    });

    assert.equal(task.issueNumber, 7);
    assert.equal('issueId' in task, false);
    assert.equal(stats.buildTaskSeconds, 60);
    assert.equal(execution.rows[0].issue_row_id, issue.id);
    assert.equal(execution.rows[0].task_row_id, task.id);
    assert.equal(flow.rows[0].flow, 'triage');
    assert.equal(Number(flow.rows[0].task_seconds), 60);
  } finally {
    await store.close();
  }
});

test('forwarded task envelopes link tasks to issues and fill task metrics', async () => {
  const { store } = tempStore();
  try {
    await store.ensureGitServer({
      id: 'gitlab-main',
      type: 'gitlab',
      baseUrl: 'https://gitlab.example.com',
      agentrixGitServerId: 'agx-main',
    });
    await applyIssueSnapshotToFacts(store, issueSnapshot());
    await applyIssueSnapshotToFacts(store, issueSnapshot({
      flow: 'build',
      updatedAt: at(HOUR_MS),
    }));

    // create-task envelope carries the linkage: agentrix git server id +
    // GitLab project id + issue number, action via ci-run metadata
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 1,
      eventId: 'evt-create',
      eventType: 'create-task',
      eventData: {
        model: 'claude-sonnet-5',
        agentType: 'claude',
        gitServerId: 'agx-main',
        serverRepoId: '42',
        issueNumber: 7,
        metadata: { issue_flow_action: 'build', issue_flow_issue: 'group/app#7' },
      },
      createdAt: at(HOUR_MS + 5 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 2,
      eventId: 'evt-run',
      eventType: 'worker-running',
      createdAt: at(HOUR_MS + 10 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 3,
      eventId: 'evt-human',
      chatId: 'chat-1',
      direction: 'inbound',
      eventData: { senderType: 'human', message: { type: 'user' } },
      createdAt: at(HOUR_MS + 12 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 4,
      eventId: 'evt-assistant',
      chatId: 'chat-1',
      eventData: { message: { type: 'assistant', message: { role: 'assistant', content: 'working on it' } } },
      createdAt: at(HOUR_MS + 15 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 5,
      eventId: 'evt-result',
      chatId: 'chat-1',
      eventData: { message: { type: 'result', subtype: 'success', num_turns: 9 } },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 6,
      eventId: 'evt-ready',
      eventType: 'worker-ready',
      eventData: { machineId: 'machine-1', duration: 30 * 60 * 1000 },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 7,
      eventId: 'evt-usage',
      eventType: 'task-usage-report',
      eventData: {
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 2147483000,
            outputTokens: 300,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 25,
            webSearchRequests: 0,
            costUSD: 0.42,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
      },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 3,
      eventId: 'evt-human',
      chatId: 'chat-1',
      direction: 'inbound',
      eventData: { senderType: 'human', message: { type: 'user' } },
      createdAt: at(HOUR_MS + 12 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 6,
      eventId: 'evt-ready',
      eventType: 'worker-ready',
      eventData: { machineId: 'machine-1', duration: 30 * 60 * 1000 },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    // resumed run reports its own usage: per-task tokens sum across reports
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 7,
      eventId: 'evt-usage-resume',
      eventType: 'task-usage-report',
      eventData: {
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 800,
            outputTokens: 200,
            cacheReadInputTokens: 25,
            costUSD: 0.18,
          },
        },
      },
      createdAt: at(HOUR_MS + 50 * 60000),
    }));

    const task = await store.getTask('task-abc');
    assert.equal(task.status, 'succeeded');
    const usageReports = await store.db.taskUsageReport.findMany({
      where: { taskId: 'task-abc' },
      orderBy: { eventId: 'asc' },
    });
    assert.deepEqual(
      usageReports.map((report) => ({
        eventId: report.eventId,
        model: report.model,
        inputTokens: Number(report.inputTokens),
        outputTokens: Number(report.outputTokens),
        cacheReadInputTokens: Number(report.cacheReadInputTokens),
        cacheCreationInputTokens: Number(report.cacheCreationInputTokens),
        webSearchRequests: Number(report.webSearchRequests),
      })),
      [
        {
          eventId: 'evt-usage',
          model: 'claude-sonnet-5',
          inputTokens: 2147483000,
          outputTokens: 300,
          cacheReadInputTokens: 50,
          cacheCreationInputTokens: 25,
          webSearchRequests: 0,
        },
        {
          eventId: 'evt-usage-resume',
          model: 'claude-sonnet-5',
          inputTokens: 800,
          outputTokens: 200,
          cacheReadInputTokens: 25,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
        },
      ],
      'each run is stored as a separate model usage row',
    );
    assert.equal('contextWindow' in usageReports[0], false, 'capacity fields are not persisted');
    assert.equal('costUsd' in usageReports[0], false, 'cost metadata is not persisted');
    assert.equal(task.agent, 'claude');
    assert.equal(task.model, 'claude-sonnet-5');
    assert.equal(task.turns, 1, 'task turns count unique human inputs');
    assert.equal(task.executionMs, 30 * 60 * 1000, 'task execution sums unique worker-ready durations');
    assert.equal(task.startedAt, at(HOUR_MS + 10 * 60000));
    assert.equal(task.finishedAt, at(HOUR_MS + 40 * 60000));
    assert.equal(task.gitServerId, 'gitlab-main', 'agentrix git server id resolves to the console git server');
    assert.equal(task.repositoryId, '42');
    assert.equal(task.repositoryFullName, 'group/app');
    assert.equal(task.issueNumber, 7);
    assert.equal(task.action, 'build');
    assert.equal('issueSpanRowId' in task, false);

    const replay = await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 5,
      eventId: 'evt-result',
      chatId: 'chat-1',
      eventData: { message: { type: 'result', subtype: 'success', num_turns: 9 } },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    assert.ok(replay, 'redelivered events are handled');
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 6,
      eventId: 'evt-usage',
      eventType: 'task-usage-report',
      eventData: {
        modelUsage: {
          'claude-sonnet-5': {
            inputTokens: 2147483000,
            outputTokens: 300,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 25,
            webSearchRequests: 0,
            costUSD: 0.42,
            contextWindow: 200000,
            maxOutputTokens: 32000,
          },
        },
      },
      createdAt: at(HOUR_MS + 40 * 60000),
    }));
    assert.equal(
      await store.db.taskUsageReport.count({ where: { taskId: 'task-abc' } }),
      2,
      'redelivered usage reports do not create duplicate rows',
    );

    const events = await store.listTaskEvents('task-abc');
    assert.equal(events.length, 5, 'usage reports stay out of the task event stream');
    assert.deepEqual(events.map((event) => event.eventType), ['worker_state', 'human_input', 'agent_message', 'agent_result', 'worker_state']);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      events.filter((event) => event.eventType === 'worker_state').map((event) => event.eventData.state),
      ['running', 'ready'],
    );
    assert.ok(events.every((event) => event.issueNumber === 7), 'task events carry the issue linkage');

    // review task: dispatched with the source issue number and action=review metadata
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 8,
      eventId: 'evt-review-create',
      taskId: 'task-review-1',
      eventType: 'create-task',
      eventData: {
        gitServerId: 'agx-main',
        serverRepoId: '42',
        issueNumber: 7,
        metadata: { issue_flow_action: 'review', issue_flow_pr: 'group/app#12' },
      },
      createdAt: at(2 * HOUR_MS),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 9,
      eventId: 'evt-review-run',
      taskId: 'task-review-1',
      eventType: 'worker-running',
      createdAt: at(2 * HOUR_MS + 10 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 10,
      eventId: 'evt-review-result',
      taskId: 'task-review-1',
      eventData: { message: { type: 'result', subtype: 'success', num_turns: 2 } },
      createdAt: at(2 * HOUR_MS + 20 * 60000),
    }));
    await applyForwardedEventToTaskFacts(store, forwardedEvent({
      cursor: 11,
      eventId: 'evt-review-ready',
      taskId: 'task-review-1',
      eventType: 'worker-ready',
      eventData: { machineId: 'machine-1', duration: 10 * 60 * 1000 },
      createdAt: at(2 * HOUR_MS + 20 * 60000),
    }));
    const reviewTask = await store.getTask('task-review-1');
    assert.equal(reviewTask.action, 'review');
    assert.equal(reviewTask.executionMs, 10 * 60 * 1000);
    assert.equal(reviewTask.issueNumber, 7, 'review tasks link through the dispatched source issue number');

    await applyIssueSnapshotToFacts(store, issueSnapshot({
      state: 'closed',
      status: 'done',
      flow: '',
      closedAt: at(3 * HOUR_MS),
      updatedAt: at(3 * HOUR_MS),
    }));
    await store.flushIssueStatsRebuilds();

    const issueRow = await findIssueRow(store, issueSnapshot());
    const stats = await store.getIssueStats(issueRow.id);
    assert.equal(stats.cycleStartedAt, at(HOUR_MS + 10 * 60000));
    assert.equal(stats.buildTaskSeconds, 30 * 60);
    assert.equal(stats.buildTaskTurns, 1);
    assert.equal(stats.reviewTaskSeconds, 10 * 60);
    assert.equal(stats.reviewTaskTurns, 0);
    assert.equal(stats.triageTaskSeconds, 0);

    const repoParams = { git_server_id: 'gitlab-main', repository_id: '42' };
    const execution = await store.runMetricsQuery(
      `select action, turns, task_seconds, input_tokens, output_tokens, total_tokens
from task_execution_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
order by action`,
      repoParams,
    );
    assert.deepEqual(execution.rows.map((row) => row.action), ['build', 'review']);
    const buildRow = execution.rows[0];
    assert.equal(Number(buildRow.task_seconds), 1800);
    assert.equal(Number(buildRow.turns), 1);
    assert.equal(Number(buildRow.input_tokens), 2147483800);
    assert.equal(Number(buildRow.output_tokens), 500);
    assert.equal(Number(buildRow.total_tokens), 2147484400);

    const dashboard = await store.getDashboardBySlug('agent-first-overview');
    const tokenPanel = dashboard.panels.find((panel) => panel.id === 'dashpanel_token_consumption_trend');
    const tokenTrend = await store.runMetricsQuery(tokenPanel.querySql, {
      ...repoParams,
      from: at(-DAY_MS),
      to: at(2 * DAY_MS),
    });
    assert.equal(Number(tokenTrend.rows[0].total_tokens), 2147484400, 'weekly token totals stay wider than INT');

    const flowMetrics = await store.runMetricsQuery(
      `select flow, span_seconds, task_seconds, wait_seconds
from issue_flow_metrics
where git_server_id = :git_server_id
  and repository_id = :repository_id
order by flow`,
      repoParams,
    );
    const buildFlow = flowMetrics.rows.find((row) => row.flow === 'build');
    assert.equal(Number(buildFlow.span_seconds), 2 * 3600);
    assert.equal(Number(buildFlow.task_seconds), 1800 + 600, 'build span carries build + review task time');
    assert.equal(Number(buildFlow.wait_seconds), 2 * 3600 - 2400);

    const route = { machineId: 'runner-1' };
    assert.equal(await store.getAgentrixForwardCursor(route), 0);
    await store.setAgentrixForwardCursor(route, 42);
    assert.equal(await store.getAgentrixForwardCursor(route), 42);
    await store.setAgentrixForwardCursor(route, 7);
    assert.equal(await store.getAgentrixForwardCursor(route), 42, 'forward cursors only move forward');
    const cloudRoute = { machineId: 'runner-1', cloudId: 'cloud-a' };
    assert.equal(await store.getAgentrixForwardCursor(cloudRoute), 0, 'the same machine id in another cloud has its own cursor');
    await store.setAgentrixForwardCursor(cloudRoute, 10);
    assert.equal(await store.getAgentrixForwardCursor(cloudRoute), 10);
    assert.equal(await store.getAgentrixForwardCursor(route), 42, 'routes do not stomp each other');
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
      type: 'bug',
      size: 'S',
      openedAt: at(HOUR_MS),
      updatedAt: at(HOUR_MS),
    });
    await applyIssueSnapshotToFacts(store, openIssue);
    // dropped issue: opened, then dropped — should stay visible without inflating open
    const droppedIssue = issueSnapshot({
      issueId: '4209',
      issueNumber: 9,
      title: 'Dropped metrics issue',
      type: '',
      openedAt: at(2 * HOUR_MS),
      updatedAt: at(2 * HOUR_MS),
    });
    await applyIssueSnapshotToFacts(store, droppedIssue);
    await applyIssueSnapshotToFacts(store, {
      ...droppedIssue,
      state: 'closed',
      status: 'drop',
      flow: '',
      closedAt: at(4 * HOUR_MS),
      updatedAt: at(4 * HOUR_MS),
    });
    await store.flushIssueStatsRebuilds();

    const doneIssueRow = await findIssueRow(store, issueSnapshot());
    const openIssueRow = await findIssueRow(store, openIssue);
    const droppedIssueRow = await findIssueRow(store, droppedIssue);
    await store.db.issueStat.update({
      where: { id: doneIssueRow.id },
      data: {
        triageTaskSeconds: 3600,
        triageTaskTurns: 1,
        planTaskTurns: 2,
        buildTaskTurns: 3,
        reviewTaskTurns: 1,
      },
    });
    await store.db.issueStat.update({
      where: { id: openIssueRow.id },
      data: {
        triageTaskTurns: 0,
        planTaskTurns: 0,
        buildTaskTurns: 0,
        reviewTaskTurns: 0,
      },
    });
    await store.db.issueStat.update({
      where: { id: droppedIssueRow.id },
      data: {
        buildTaskSeconds: 1800,
        triageTaskTurns: 0,
        planTaskTurns: 8,
        buildTaskTurns: 9,
        reviewTaskTurns: 4,
      },
    });
    const weekly = await store.runMetricsQuery(
      'select week, done_bucket, issue_count, weighted_count from weekly_issue_metrics order by done_bucket',
      {},
    );
    const buckets = new Map(weekly.rows.map((row) => [row.done_bucket, row]));
    assert.ok(buckets.has('1d'), 'done-in-12h issue lands in the 1d bucket');
    assert.equal(buckets.get('1d').issue_count, 1);
    assert.equal(Number(buckets.get('1d').weighted_count), 2);
    assert.ok(buckets.has('open'), 'open issues use the open bucket');
    assert.equal(buckets.get('open').issue_count, 1, 'dropped issues do not count as open');
    assert.equal(Number(buckets.get('open').weighted_count), 1);
    assert.ok(buckets.has('drop'), 'dropped issues use the drop bucket');
    assert.equal(buckets.get('drop').issue_count, 1);
    assert.equal(Number(buckets.get('drop').weighted_count), 2);
    assert.equal(
      weekly.rows.reduce((sum, row) => sum + Number(row.issue_count), 0),
      3,
      'dropped issues remain in the weekly distribution',
    );

    const wip = await store.runMetricsQuery('select * from wip_aging_metrics', {});
    assert.equal(wip.rows.length, 1);
    assert.equal(wip.rows[0].flow, 'triage');
    assert.equal(wip.rows[0].issue_number, 8);
    assert.ok(Number(wip.rows[0].aging_seconds) > 0);

    const dashboard = await store.getDashboardBySlug('agent-first-overview');
    assert.ok(dashboard, 'system dashboard seeded');
    assert.equal(dashboard.isSystem, true);
    assert.deepEqual(
      dashboard.panels.map((panel) => panel.id).sort(),
      [
        'dashpanel_issue_task_turns_distribution',
        'dashpanel_issue_type_distribution',
        'dashpanel_started_issue_distribution',
        'dashpanel_task_time_share',
        'dashpanel_token_consumption_trend',
      ],
    );
    assert.deepEqual(dashboard.variables.map((variable) => variable.name), ['weeks', 'from', 'to']);
    const weeksVariable = dashboard.variables.find((variable) => variable.name === 'weeks');
    assert.equal(weeksVariable.defaultValue.value, 8);
    assert.deepEqual(weeksVariable.defaultValue.options, [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52]);

    const repoParams = { git_server_id: 'gitlab-main', repository_id: '42' };
    const distribution = dashboard.panels.find((panel) => panel.id === 'dashpanel_started_issue_distribution');
    assert.deepEqual(distribution.y2Fields, ['duration_p80_days']);
    assert.equal(distribution.visualConfig.fieldLabels.duration_p80_days, 'P80 耗时');
    assert.deepEqual(distribution.drillConfig, {
      kind: 'issues',
      params: ['week', 'bucket'],
      xParam: 'week',
      seriesParam: 'bucket',
    });
    assert.match(distribution.drillQuerySql, /done_bucket = :bucket/);
    const distributionResult = await store.runMetricsQuery(distribution.querySql, { ...repoParams, weeks: 8 });
    assert.ok(distributionResult.rows.length >= 2);
    assert.deepEqual(
      distributionResult.columns.map((column) => column.name),
      ['week', 'done_bucket', 'issue_count', 'weighted_count', 'duration_p80_days'],
    );
    assert.ok(
      distributionResult.rows.some((row) => Number(row.duration_p80_days) > 0),
      'completion duration P80 is computed from done/drop issues',
    );
    const completedWeek = distributionResult.rows.find((row) => row.done_bucket === '1d').week;
    const completionDrill = await store.runMetricsQuery(distribution.drillQuerySql, {
      ...repoParams,
      week: String(completedWeek).slice(0, 10),
      bucket: '1d',
    });
    assert.equal(completionDrill.rows.length, 1);
    assert.equal(completionDrill.rows[0].issue_number, 7);
    assert.equal(completionDrill.rows[0].title, 'Metrics issue');
    assert.equal(completionDrill.rows[0].total_count, 1);
    assert.equal(completionDrill.rows[0].weekly_count, 3);
    assert.equal(completionDrill.rows[0].duration_p50_seconds, 12 * 3600);
    assert.equal(completionDrill.rows[0].duration_max_seconds, 12 * 3600);
    assert.equal(completionDrill.rows[0].task_turns, 7);
    assert.equal(completionDrill.rows[0].agent_execution_pct, 8);

    const otherRepo = await store.runMetricsQuery(distribution.querySql, {
      ...repoParams,
      repository_id: 'other-repo',
      weeks: 8,
    });
    assert.equal(otherRepo.rows.length, 0, 'panel queries are scoped to the requested repository');

    const issueType = dashboard.panels.find((panel) => panel.id === 'dashpanel_issue_type_distribution');
    assert.equal(issueType.chartType, 'stacked_bar');
    assert.deepEqual(issueType.yFields, ['issue_count', 'weighted_count']);
    assert.deepEqual(issueType.visualConfig.stackOrder, ['type::feature', 'type::bug', 'type::debt', 'type::ops', '未分类']);
    assert.equal(issueType.drillConfig.kind, 'issue_type');
    const typeResult = await store.runMetricsQuery(issueType.querySql, { ...repoParams, weeks: 8 });
    assert.deepEqual(
      typeResult.columns.map((column) => column.name),
      ['week', 'issue_type', 'issue_count', 'weighted_count'],
    );
    const typeBuckets = new Map(typeResult.rows.map((row) => [row.issue_type, row]));
    assert.equal(typeBuckets.get('type::feature').issue_count, 1);
    assert.equal(Number(typeBuckets.get('type::feature').weighted_count), 2);
    assert.equal(typeBuckets.get('type::bug').issue_count, 1);
    assert.equal(Number(typeBuckets.get('type::bug').weighted_count), 1);
    assert.equal(typeBuckets.get('未分类').issue_count, 1);
    assert.equal(Number(typeBuckets.get('未分类').weighted_count), 2);
    const typeDrill = await store.runMetricsQuery(issueType.drillQuerySql, {
      ...repoParams,
      week: String(completedWeek).slice(0, 10),
      bucket: 'type::feature',
    });
    assert.equal(typeDrill.rows.length, 1);
    assert.equal(typeDrill.rows[0].issue_number, 7);
    assert.equal(typeDrill.rows[0].total_count, 1);
    assert.equal(typeDrill.rows[0].weekly_count, 3);
    assert.equal(Number(typeDrill.rows[0].weighted_total), 2);
    assert.equal(typeDrill.rows[0].done_count, 1);

    const otherRepoTypes = await store.runMetricsQuery(issueType.querySql, {
      ...repoParams,
      repository_id: 'other-repo',
      weeks: 8,
    });
    assert.equal(otherRepoTypes.rows.length, 0, 'type panel query is scoped to the requested repository');

    const taskTurns = dashboard.panels.find((panel) => panel.id === 'dashpanel_issue_task_turns_distribution');
    assert.equal(taskTurns.chartType, 'stacked_bar_with_lines');
    assert.deepEqual(taskTurns.yFields, ['issue_count', 'weighted_count']);
    assert.deepEqual(taskTurns.y2Fields, ['task_turns_p80']);
    assert.equal(taskTurns.visualConfig.fieldLabels.task_turns_p80, 'P80 轮次');
    assert.equal(taskTurns.drillConfig.kind, 'issue_turns');
    const turnsResult = await store.runMetricsQuery(taskTurns.querySql, { ...repoParams, weeks: 8 });
    assert.deepEqual(
      turnsResult.columns.map((column) => column.name),
      ['week', 'turns_bucket', 'issue_count', 'weighted_count', 'task_turns_p80'],
    );
    const turnsBuckets = new Map(turnsResult.rows.map((row) => [row.turns_bucket, row]));
    assert.equal(turnsBuckets.get('0').issue_count, 1);
    assert.equal(Number(turnsBuckets.get('0').weighted_count), 1);
    assert.equal(turnsBuckets.get('7-10').issue_count, 1);
    assert.equal(Number(turnsBuckets.get('7-10').weighted_count), 2);
    assert.equal(turnsBuckets.get('20+').issue_count, 1);
    assert.equal(Number(turnsBuckets.get('20+').weighted_count), 2);
    assert.ok(
      turnsResult.rows.some((row) => Math.abs(Number(row.task_turns_p80) - 15.4) < 0.001),
      'task turns P80 is computed from summed issue_stats task turns',
    );
    const turnsDrill = await store.runMetricsQuery(taskTurns.drillQuerySql, {
      ...repoParams,
      week: String(completedWeek).slice(0, 10),
      bucket: '20+',
    });
    assert.equal(turnsDrill.rows.length, 1);
    assert.equal(turnsDrill.rows[0].issue_number, 9);
    assert.equal(turnsDrill.rows[0].task_turns, 21);
    assert.deepEqual(
      ['triage_turns', 'plan_turns', 'build_turns', 'review_turns'].map((field) => turnsDrill.rows[0][field]),
      [0, 8, 9, 4],
    );
    assert.equal(turnsDrill.rows[0].total_count, 1);
    assert.equal(turnsDrill.rows[0].weekly_count, 3);
    assert.equal(Number(turnsDrill.rows[0].task_turns_p50), 21);
    assert.ok(Math.abs(Number(turnsDrill.rows[0].task_turns_p80) - 15.4) < 0.001);

    const otherRepoTurns = await store.runMetricsQuery(taskTurns.querySql, {
      ...repoParams,
      repository_id: 'other-repo',
      weeks: 8,
    });
    assert.equal(otherRepoTurns.rows.length, 0, 'task turns panel query is scoped to the requested repository');

    assert.equal(dashboard.panels.find((panel) => panel.id === 'dashpanel_token_consumption_trend').chartType, 'stacked_bar_with_lines');
    assert.equal(dashboard.panels.find((panel) => panel.id === 'dashpanel_task_time_share').chartType, 'percent_stacked_bar_with_lines');

    const taskTimeShare = dashboard.panels.find((panel) => panel.id === 'dashpanel_task_time_share');
    assert.match(taskTimeShare.querySql, /issue_stats/);
    assert.doesNotMatch(taskTimeShare.querySql, /issue_flow_metrics/);
    const taskTimeShareResult = await store.runMetricsQuery(taskTimeShare.querySql, {
      ...repoParams,
      from: at(-30 * DAY_MS),
      to: at(30 * DAY_MS),
    });
    const taskTimeShareRows = new Map(taskTimeShareResult.rows.map((row) => [row.component, row]));
    assert.equal(Number(taskTimeShareRows.get('agent').seconds), 5400, 'agent execution comes from issue_stats task seconds');
    assert.ok(Number(taskTimeShareRows.get('wait').seconds) > 0, 'issue lifecycle remainder is reported as wait');
    assert.ok(
      Math.abs(
        Number(taskTimeShareRows.get('agent').task_share_pct)
        - (5400 * 100 / (5400 + Number(taskTimeShareRows.get('wait').seconds)))
      ) < 0.001,
      'agent execution share uses issue lifecycle seconds as its denominator',
    );

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
    const { token } = await store.createConsoleSession({ userId: user.id });
    const cookie = `issue_flow_sid=${token}`;
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
    const drillPath = `/api/repositories/${repoRow.id}/dashboards/agent-first-overview/panels/dashpanel_started_issue_distribution/drill`;

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
    assert.equal(detailBody.dashboard.panels.length, 5);

    const queryResponse = await fetch(`${baseUrl}${queryPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ params: { weeks: 8 } }),
    });
    assert.equal(queryResponse.status, 200);
    const queryBody = await queryResponse.json();
    assert.ok(Array.isArray(queryBody.result.columns));
    assert.ok(Array.isArray(queryBody.result.rows));

    const drillResponse = await fetch(`${baseUrl}${drillPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ params: { week: '2026-07-06', bucket: 'open' } }),
    });
    assert.equal(drillResponse.status, 200);
    const drillBody = await drillResponse.json();
    assert.ok(Array.isArray(drillBody.result.rows));

    const blockedDrillParam = await fetch(`${baseUrl}${drillPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ params: { week: '2026-07-06', bucket: 'open', repository_id: 'other' } }),
    });
    assert.equal(blockedDrillParam.status, 400);

    for (const [panelId, bucket] of [
      ['dashpanel_issue_type_distribution', 'type::feature'],
      ['dashpanel_issue_task_turns_distribution', '20+'],
    ]) {
      const enabledDrill = await fetch(
        `${baseUrl}/api/repositories/${repoRow.id}/dashboards/agent-first-overview/panels/${panelId}/drill`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', cookie },
          body: JSON.stringify({ params: { week: '2026-07-06', bucket } }),
        },
      );
      assert.equal(enabledDrill.status, 200, `${panelId} exposes drilldown`);
    }

    const outsider = await store.createUser({ displayName: 'Metrics Outsider' });
    const { token: outsiderToken } = await store.createConsoleSession({ userId: outsider.id });
    const noAccess = await fetch(`${baseUrl}${queryPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `issue_flow_sid=${outsiderToken}` },
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

test('agentrix forward websocket receives task events end to end', async () => {
  const WebSocket = require('ws');
  const { store } = tempStore();
  process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN = 'forward-test-token';
  const app = await createApp({ store });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const forwardUrl = `ws://127.0.0.1:${app.server.address().port}/webhooks/agentrix/forward`;

    const unauthorized = new WebSocket(forwardUrl);
    const rejection = await new Promise((resolve) => unauthorized.once('error', resolve));
    assert.match(String(rejection.message), /401/, 'connections without the bearer token are rejected');

    const client = new WebSocket(forwardUrl, {
      headers: { Authorization: 'Bearer forward-test-token' },
    });
    const received = [];
    let waiter = null;
    client.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(frame);
      } else {
        received.push(frame);
      }
    });
    const nextFrame = () => (received.length
      ? Promise.resolve(received.shift())
      : new Promise((resolve) => {
        waiter = resolve;
      }));
    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    client.send(JSON.stringify({ type: 'hello', protocolVersion: 1, machineId: 'runner-e2e', hostname: 'test' }));
    const helloAck = await nextFrame();
    assert.equal(helloAck.type, 'hello-ack');
    assert.equal(helloAck.resumeFromCursor, undefined, 'no cursor stored for a new machine');

    client.send(JSON.stringify({
      type: 'events',
      events: [forwardedEvent({
        cursor: 3,
        eventId: 'evt-e2e',
        taskId: 'task-e2e',
        eventType: 'create-task',
        eventData: { model: 'claude-sonnet-5', agentType: 'claude' },
      })],
    }));
    const ack = await nextFrame();
    assert.deepEqual(ack, { type: 'ack', cursor: 3 });

    const task = await store.getTask('task-e2e');
    assert.equal(task.status, 'queued');
    assert.equal(task.model, 'claude-sonnet-5');
    assert.equal(await store.getAgentrixForwardCursor({ machineId: 'runner-e2e' }), 3);
    client.close();
  } finally {
    delete process.env.ISSUE_FLOW_AGENTRIX_FORWARD_TOKEN;
    await app.close();
    await store.close();
  }
});
