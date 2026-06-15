import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';
import { repairAgentrixIssueRollups, upsertIssueShell } from '../src/lib/db.ts';
import { ingestAgentrixBatch } from '../src/lib/agentrix/ingest.ts';

test('ingestAgentrixBatch is idempotent and aggregates human events plus cost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-ingest-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    upsertIssueShell(db, {
      projectId: 'gitlab:huilian/wandou-kanban',
      iid: 1,
      title: 'Issue 1',
      createdAt: 1000
    });

    const batch = {
      runnerId: 'runner-1',
      source: 'agentrix_sqlite' as const,
      taskId: 'task-1',
      projectId: 'gitlab:huilian/wandou-kanban',
      issueIid: 1,
      issueRef: 'huilian/wandou-kanban#1',
      action: 'build',
      events: [
        {
          sourceEventId: 'event-1',
          sequence: 1,
          eventType: 'task-message',
          eventSubtype: 'ask_user',
          actorType: 'agent',
          occurredAt: 1000,
          payload: { message: { messageType: 'ask_user', usage: { input_tokens: 5 } } }
        },
        {
          sourceEventId: 'event-2',
          sequence: 2,
          eventType: 'task-message',
          actorType: 'human',
          occurredAt: 2000,
          payload: { senderType: 'human' }
        },
        {
          sourceEventId: 'event-3',
          sequence: 3,
          eventType: 'task-message',
          actorType: 'agent',
          occurredAt: 3000,
          payload: {
            message: {
              modelUsage: {
                'claude-sonnet-4-6': {
                  inputTokens: 25,
                  outputTokens: 10,
                  cacheCreationInputTokens: 2,
                  cacheReadInputTokens: 3,
                  costUSD: 0.04
                }
              }
            }
          }
        }
      ]
    };

    ingestAgentrixBatch(db, batch);
    ingestAgentrixBatch(db, batch);

    const issue = db
      .prepare('select agentrix_user_message_count, agentrix_question_answer_count, human_intervention_total, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, token_cost_usd from issues where project_id = ? and iid = ?')
      .get('gitlab:huilian/wandou-kanban', 1) as Record<string, number>;
    assert.equal(issue.agentrix_user_message_count, 1);
    assert.equal(issue.agentrix_question_answer_count, 1);
    assert.equal(issue.human_intervention_total, 2);
    assert.equal(issue.input_tokens, 30);
    assert.equal(issue.output_tokens, 10);
    assert.equal(issue.cache_creation_input_tokens, 2);
    assert.equal(issue.cache_read_input_tokens, 3);
    assert.equal(issue.token_cost_usd, 0.04);

    const rawCount = db.prepare('select count(*) as count from agentrix_raw_events').get() as { count: number };
    assert.equal(rawCount.count, 3);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('ingestAgentrixBatch backfills existing human events when a task later links to an issue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-ingest-link-backfill-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    upsertIssueShell(db, {
      projectId: 'gitlab:huilian/wandou-kanban',
      iid: 7,
      title: 'Issue 7',
      createdAt: 1000
    });

    const events = [
      {
        sourceEventId: 'event-1',
        sequence: 1,
        eventType: 'task-message',
        eventSubtype: 'ask_user',
        actorType: 'agent',
        occurredAt: 1000,
        payload: { message: { messageType: 'ask_user' } }
      },
      {
        sourceEventId: 'event-2',
        sequence: 2,
        eventType: 'task-message',
        actorType: 'human',
        occurredAt: 2000,
        payload: { senderType: 'human' }
      }
    ];

    ingestAgentrixBatch(db, {
      runnerId: 'runner-1',
      source: 'agentrix_sqlite',
      taskId: 'task-late-link',
      events
    });

    ingestAgentrixBatch(db, {
      runnerId: 'runner-1',
      source: 'agentrix_sqlite',
      taskId: 'task-late-link',
      projectId: 'gitlab:huilian/wandou-kanban',
      issueIid: 7,
      issueRef: 'huilian/wandou-kanban#7',
      events
    });

    const issue = db
      .prepare('select agentrix_user_message_count, agentrix_question_answer_count, human_intervention_total from issues where project_id = ? and iid = ?')
      .get('gitlab:huilian/wandou-kanban', 7) as Record<string, number>;
    assert.equal(issue.agentrix_user_message_count, 1);
    assert.equal(issue.agentrix_question_answer_count, 1);
    assert.equal(issue.human_intervention_total, 2);

    const linkedEvents = db
      .prepare('select count(*) as count from agentrix_human_events where task_id = ? and project_id = ? and issue_iid = ?')
      .get('task-late-link', 'gitlab:huilian/wandou-kanban', 7) as { count: number };
    assert.equal(linkedEvents.count, 2);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('repairAgentrixIssueRollups restores stale human event links and issue counters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-rollup-repair-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    upsertIssueShell(db, {
      projectId: 'gitlab:huilian/wandou-kanban',
      iid: 9,
      title: 'Issue 9',
      createdAt: 1000
    });
    db.prepare(`
      insert into agentrix_tasks (
        task_id, runner_id, project_id, issue_iid, input_tokens, output_tokens, cost_usd, collected_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('task-stale-link', 'runner-1', 'gitlab:huilian/wandou-kanban', 9, 30, 4, 0.02, 1000);
    db.prepare(`
      insert into agentrix_human_events (
        id, source, source_event_id, task_id, event_type, actor, created_at, raw_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('event-stale-link', 'agentrix_sqlite', 'event-stale-link', 'task-stale-link', 'user_message', 'human', 1000, '{}');

    repairAgentrixIssueRollups(db);

    const issue = db
      .prepare('select agentrix_user_message_count, agentrix_question_answer_count, human_intervention_total, input_tokens, output_tokens, token_cost_usd from issues where project_id = ? and iid = ?')
      .get('gitlab:huilian/wandou-kanban', 9) as Record<string, number>;
    assert.equal(issue.agentrix_user_message_count, 1);
    assert.equal(issue.agentrix_question_answer_count, 0);
    assert.equal(issue.human_intervention_total, 1);
    assert.equal(issue.input_tokens, 30);
    assert.equal(issue.output_tokens, 4);
    assert.equal(issue.token_cost_usd, 0.02);

    const event = db
      .prepare('select project_id, issue_iid from agentrix_human_events where id = ?')
      .get('event-stale-link') as { project_id: string; issue_iid: number };
    assert.equal(event.project_id, 'gitlab:huilian/wandou-kanban');
    assert.equal(event.issue_iid, 9);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
