import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';
import { getDashboardSummary, queryIssueList } from '../src/lib/queries.ts';

test('getDashboardSummary returns core counts and cost totals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-queries-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into issues (
        project_id, iid, title, state, created_at, first_closed_at,
        first_close_duration_sec, issue_flow_gate_count,
        agentrix_user_message_count, agentrix_question_answer_count,
        human_intervention_total, automation_action_count,
        input_tokens, output_tokens, token_cost_usd,
        stage_triage_sec, stage_plan_sec, stage_build_sec,
        stage_clarify_sec, stage_approve_sec, is_bug_ever
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'gitlab:huilian/wandou-kanban',
      1,
      'Issue 1',
      'closed',
      1000,
      2000,
      1,
      2,
      3,
      1,
      6,
      2,
      100,
      50,
      0.25,
      10,
      20,
      30,
      40,
      50,
      1
    );
    db.prepare(`
      insert into agentrix_tasks (
        task_id, runner_id, project_id, issue_iid, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task-linked', 'runner-1', 'gitlab:huilian/wandou-kanban', 1, 25, 15, 5, 7, 0.12);
    db.prepare(`
      insert into agentrix_tasks (
        task_id, runner_id, input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens, cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run('task-unlinked', 'runner-1', 5, 3, 0, 0, 0.03);

    const summary = getDashboardSummary(db);
    assert.equal(summary.totals.createdCount, 1);
    assert.equal(summary.totals.completedCount, 1);
    assert.equal(summary.totals.humanInterventionTotal, 6);
    assert.equal(summary.totals.automationActionCount, 2);
    assert.equal(summary.totals.inputTokens, 100);
    assert.equal(summary.totals.outputTokens, 50);
    assert.equal(summary.totals.tokenCostUsd, 0.25);
    assert.equal(summary.openIssues[0].agentrixTaskCount, 1);
    assert.equal(summary.agentrixTasks.taskCount, 2);
    assert.equal(summary.agentrixTasks.unlinkedTaskCount, 1);
    assert.equal(summary.agentrixTasks.costUsd, 0.15);
    assert.equal(summary.dataQuality.unlinkedAgentrixTaskCount, 1);
    assert.equal(summary.humanBreakdown.agentrixUserMessages, 3);
    assert.equal(summary.stageTotals.deliveryDurationSec, 30);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('getDashboardSummary uses issue created_at window and exposes bug, reopen and open issue metrics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-window-metrics-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    const now = Date.parse('2026-06-15T12:00:00Z');
    db.prepare(`
      insert into issues (
        project_id, iid, title, state, current_flow_stage, issue_type,
        created_at, first_closed_at, first_close_duration_sec,
        reopen_count, is_bug_ever, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '12345',
      1,
      'Recent closed bug',
      'closed',
      'build',
      'bug',
      Date.parse('2026-06-14T00:00:00Z'),
      Date.parse('2026-06-14T05:00:00Z'),
      5 * 3600,
      1,
      1,
      1.5
    );
    db.prepare(`
      insert into issues (
        project_id, iid, title, state, current_flow_stage, issue_type,
        created_at, reopen_count, is_bug_ever, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '12345',
      2,
      'Recent open feature',
      'opened',
      'plan',
      'feature',
      Date.parse('2026-06-15T00:00:00Z'),
      0,
      0,
      2.5
    );
    db.prepare(`
      insert into issues (
        project_id, iid, title, state, current_flow_stage, issue_type,
        created_at, first_closed_at, first_close_duration_sec,
        reopen_count, is_bug_ever, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '12345',
      3,
      'Old closed bug',
      'closed',
      'approve',
      'bug',
      Date.parse('2026-05-01T00:00:00Z'),
      Date.parse('2026-06-15T00:00:00Z'),
      45 * 24 * 3600,
      1,
      1,
      9
    );

    const summary = getDashboardSummary(db, { now, windowDays: 7 });
    assert.equal(summary.window.mode, 'preset');
    assert.equal(summary.totals.createdCount, 2);
    assert.equal(summary.totals.completedCount, 1);
    assert.equal(summary.totals.tokenCostUsd, 4);
    assert.deepEqual(summary.totals.newBugLoadRate, {
      newBugs: 1,
      totalIssues: 2,
      rate: 0.5
    });
    assert.deepEqual(summary.totals.reopenRate, {
      numerator: 1,
      denominator: 1,
      rate: 1
    });
    assert.equal(summary.openIssueSummary.total, 1);
    assert.equal(summary.openIssueSummary.byStage.plan, 1);
    assert.equal(summary.openIssueSummary.byType.feature, 1);
    assert.equal(summary.openIssues.length, 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('getDashboardSummary exposes stage share, quantiles, trend, freshness and project filtering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-old-metrics-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    const now = Date.parse('2026-06-15T12:00:00Z');
    db.prepare(`
      insert into projects (id, name, path_with_namespace, provider, active, token, last_success_at)
      values (?, ?, ?, 'gitlab', 1, ?, ?)
    `).run('43371', 'wandou-kanban', 'huilian/wandou-kanban', 'token-a', Date.parse('2026-06-15T09:00:00Z'));
    db.prepare(`
      insert into projects (id, name, path_with_namespace, provider, active, token, last_success_at)
      values (?, ?, ?, 'gitlab', 1, ?, ?)
    `).run('999', 'other', 'huilian/other', 'token-b', Date.parse('2026-06-14T09:00:00Z'));

    const insertIssue = db.prepare(`
      insert into issues (
        project_id, iid, title, state, current_flow_stage, issue_type,
        created_at, first_closed_at, first_close_duration_sec, reopen_count,
        stage_triage_sec, stage_plan_sec, stage_build_sec, stage_clarify_sec,
        stage_approve_sec, stage_unknown_sec, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertIssue.run(
      '43371',
      1,
      'Done',
      'closed',
      'approve',
      'feature',
      Date.parse('2026-06-14T00:00:00Z'),
      Date.parse('2026-06-14T04:00:00Z'),
      4 * 3600,
      0,
      600,
      1200,
      2400,
      0,
      600,
      0,
      1
    );
    insertIssue.run(
      '43371',
      2,
      'Open bug',
      'opened',
      'build',
      'bug',
      Date.parse('2026-06-15T00:00:00Z'),
      null,
      null,
      0,
      300,
      600,
      900,
      300,
      0,
      0,
      2
    );
    insertIssue.run(
      '999',
      1,
      'Other',
      'closed',
      'approve',
      'feature',
      Date.parse('2026-06-15T01:00:00Z'),
      Date.parse('2026-06-15T02:00:00Z'),
      3600,
      0,
      10,
      10,
      10,
      0,
      10,
      0,
      9
    );

    const summary = getDashboardSummary(db, {
      now,
      windowDays: 7,
      projectId: '43371'
    });

    assert.equal(summary.projects.length, 2);
    assert.equal(summary.project?.id, '43371');
    assert.equal(summary.freshness.lastSuccessAt, Date.parse('2026-06-15T09:00:00Z'));
    assert.equal(summary.totals.createdCount, 2);
    assert.equal(summary.totals.tokenCostUsd, 3);
    assert.equal(summary.stageShare.total.issueCount, 1);
    assert.equal(summary.stageShare.total.stages.build.seconds, 2400);
    assert.equal(summary.stageDurations.build.n, 2);
    assert.equal(summary.stageDurations.build.p50, 1650);
    assert.equal(summary.trend.some((point) => point.created === 1 && point.completed === 1), true);
    assert.equal(summary.openIssueSummary.total, 1);
    assert.equal(summary.openIssueSummary.byStage.build, 1);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('queryIssueList filters and sorts issue rows for the detail table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-issue-list-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into projects (id, name, path_with_namespace, provider, active)
      values ('43371', 'wandou-kanban', 'huilian/wandou-kanban', 'gitlab', 1)
    `).run();
    const insertIssue = db.prepare(`
      insert into issues (
        project_id, iid, title, author, state, current_flow_stage, issue_type,
        priority, created_at, first_closed_at, first_close_duration_sec,
        reopen_count, human_intervention_total, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertIssue.run('43371', 1, 'Feature', 'alice', 'opened', 'plan', 'feature', 'p2', 1000, null, null, 0, 2, 1.5);
    insertIssue.run('43371', 2, 'Bug', 'bob', 'closed', 'approve', 'bug', 'p1', 2000, 5000, 3000, 2, 5, 2.5);

    const result = queryIssueList(db, {
      projectId: '43371',
      type: 'bug',
      onlyReopened: true,
      page: 1,
      pageSize: 20,
      orderBy: 'created_at',
      order: 'desc'
    });

    assert.equal(result.total, 1);
    assert.equal(result.rows[0].iid, 2);
    assert.equal(result.rows[0].projectPath, 'huilian/wandou-kanban');
    assert.equal(result.rows[0].agentrixTaskCount, 0);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('queryIssueList sorts by total token usage when requested', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-token-list-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into projects (id, name, path_with_namespace, provider, active)
      values ('43371', 'wandou-kanban', 'huilian/wandou-kanban', 'gitlab', 1)
    `).run();
    const insertIssue = db.prepare(`
      insert into issues (
        project_id, iid, title, state, created_at,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, token_cost_usd
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertIssue.run('43371', 1, 'Low token issue', 'opened', 1000, 100, 50, 10, 5, 9);
    insertIssue.run('43371', 2, 'High token issue', 'opened', 2000, 900, 300, 200, 100, 1);

    const result = queryIssueList(db, {
      projectId: '43371',
      page: 1,
      pageSize: 20,
      orderBy: 'token_total',
      order: 'desc'
    });

    assert.equal(result.rows[0].iid, 2);
    assert.equal(result.rows[0].input_tokens + result.rows[0].output_tokens, 1200);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
