import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate } from '../src/lib/schema.ts';
import { ingestAgentrixBatch } from '../src/lib/agentrix/ingest.ts';
import { readAgentrixDataBin } from '../src/lib/agentrix/sqlite.ts';

test('readAgentrixDataBin infers GitLab issue reference from Agentrix initial prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-agentrix-link-'));
  const dbPath = join(dir, 'data.bin');
  try {
    const db = new Database(dbPath);
    db.exec(`
      create table task_event (
        event_id text primary key,
        task_id text not null,
        chat_id text not null,
        sequence integer,
        event_type text not null,
        event_data text not null,
        created_at text not null
      );
      create table task_agent_session (
        agent_id text primary key,
        task_id text,
        session_id text not null,
        last_sequence integer,
        updated_at text not null
      );
    `);
    db.prepare('insert into task_agent_session (agent_id, task_id, session_id, last_sequence, updated_at) values (?, ?, ?, ?, ?)')
      .run('agent-1', 'task-issue-3', 'session-1', 1, '2026-06-15T00:00:00.000Z');
    db.prepare('insert into task_event (event_id, task_id, chat_id, sequence, event_type, event_data, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(
        'event-1',
        'task-issue-3',
        'chat-1',
        0,
        'task-message',
        JSON.stringify({
          message: {
            type: 'user',
            message: {
              role: 'user',
              content: '目标：实现当前 issue，并发布 build PR/MR。\n\n## Issue\n\nNumber: #3\nProject: huilian/wandou-kanban\nTitle: 根据audio的类型的note id差note状态、asr状态、ai分析状态等明细'
            }
          }
        }),
        '2026-06-15T00:00:01.000Z'
      );
    db.close();

    const snapshot = readAgentrixDataBin({ dbPath, sourcePath: dbPath, runnerId: 'runner-1' });
    assert.equal(snapshot.issueIid, 3);
    assert.equal(snapshot.projectPathWithNamespace, 'huilian/wandou-kanban');
    assert.equal(snapshot.issueRef, 'huilian/wandou-kanban#3');
    assert.equal(snapshot.action, 'build');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('ingestAgentrixBatch resolves project path and aggregates task metrics into the issue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'issue-flow-dashboard-agentrix-link-ingest-'));
  try {
    const db = new Database(join(dir, 'dashboard.db'));
    migrate(db);
    db.prepare(`
      insert into projects (id, name, path_with_namespace, provider, active, created_at, updated_at)
      values (?, ?, ?, 'gitlab', 1, ?, ?)
    `).run('gitlab-git-lianjia-com:huilian/wandou-kanban', 'wandou-kanban', 'huilian/wandou-kanban', 1000, 1000);
    db.prepare(`
      insert into issues (project_id, iid, title, created_at, issue_flow_gate_count)
      values (?, ?, ?, ?, ?)
    `).run('gitlab-git-lianjia-com:huilian/wandou-kanban', 3, 'Issue 3', 1000, 1);

    ingestAgentrixBatch(db, {
      runnerId: 'runner-1',
      source: 'agentrix_sqlite',
      taskId: 'task-issue-3',
      projectPathWithNamespace: 'huilian/wandou-kanban',
      issueIid: 3,
      issueRef: 'huilian/wandou-kanban#3',
      action: 'build',
      events: [
        {
          sourceEventId: 'event-1',
          sequence: 1,
          eventType: 'task-message',
          actorType: 'human',
          occurredAt: 1000,
          payload: { senderType: 'human' }
        },
        {
          sourceEventId: 'event-2',
          sequence: 2,
          eventType: 'task-message',
          actorType: 'agent',
          occurredAt: 2000,
          payload: {
            message: {
              modelUsage: {
                'claude-opus-4-8': {
                  inputTokens: 40,
                  outputTokens: 10,
                  cacheCreationInputTokens: 5,
                  cacheReadInputTokens: 7,
                  costUSD: 0.5
                }
              }
            }
          }
        }
      ]
    });

    const task = db
      .prepare('select project_id, issue_iid, issue_ref, action from agentrix_tasks where task_id = ?')
      .get('task-issue-3') as Record<string, string | number>;
    assert.equal(task.project_id, 'gitlab-git-lianjia-com:huilian/wandou-kanban');
    assert.equal(task.issue_iid, 3);
    assert.equal(task.issue_ref, 'huilian/wandou-kanban#3');
    assert.equal(task.action, 'build');

    const issue = db
      .prepare('select agentrix_user_message_count, human_intervention_total, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, token_cost_usd from issues where project_id = ? and iid = ?')
      .get('gitlab-git-lianjia-com:huilian/wandou-kanban', 3) as Record<string, number>;
    assert.equal(issue.agentrix_user_message_count, 1);
    assert.equal(issue.human_intervention_total, 2);
    assert.equal(issue.input_tokens, 40);
    assert.equal(issue.output_tokens, 10);
    assert.equal(issue.cache_creation_input_tokens, 5);
    assert.equal(issue.cache_read_input_tokens, 7);
    assert.equal(issue.token_cost_usd, 0.5);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
